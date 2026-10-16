const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const db = require('./db');
const { scoreMultipleChoice, scoreNumber } = require('./scoring');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const GRACE_MS = 800; // network grace after the timer ends
// Groups players choose from when joining. Edit this list to rename/add groups.
const GROUPS = ['KDO Zug', 'Zug 1', 'Zug 2', 'Zug 3', 'Zug 4'];
const displayRoom = pin => `display:${pin}`;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.redirect('/play'));
// list of groups for the join form
app.get('/api/groups', (req, res) => res.json(GROUPS));

/* ---------------------------------------------------------------- REST (admin) */

function auth(req, res, next) {
  if (req.get('x-admin-password') === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Wrong password' });
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function cleanQuestion(q) {
  const text = String(q.text || '').trim().slice(0, 300);
  const timeLimit = clamp(parseInt(q.timeLimit, 10) || 20, 5, 120);
  if (q.type === 'number') {
    let answer = Number(q.answer);
    if (!Number.isFinite(answer)) answer = 0;
    const tol = Number(q.tolerance);
    return { type: 'number', text, answer, tolerance: Number.isFinite(tol) && tol > 0 ? tol : 0, timeLimit };
  }
  const options = [];
  let correct = 0;
  (q.options || []).slice(0, 6).forEach((o, i) => {
    const t = String(o).trim().slice(0, 120);
    if (t) {
      if (i === q.correct) correct = options.length;
      options.push(t);
    }
  });
  if (options.length < 2) return null;
  return { type: 'mc', text, options, correct, timeLimit };
}

app.get('/api/quizzes', auth, (req, res) => res.json(db.listQuizzes()));
app.post('/api/quizzes', auth, (req, res) => {
  const title = String(req.body.title || 'Untitled quiz').trim().slice(0, 100) || 'Untitled quiz';
  res.json(db.createQuiz(title));
});
app.get('/api/quizzes/:id', auth, (req, res) => {
  const quiz = db.getQuiz(Number(req.params.id));
  quiz ? res.json(quiz) : res.status(404).json({ error: 'Not found' });
});
app.put('/api/quizzes/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.getQuiz(id)) return res.status(404).json({ error: 'Not found' });
  const title = String(req.body.title || 'Untitled quiz').trim().slice(0, 100) || 'Untitled quiz';
  const questions = (Array.isArray(req.body.questions) ? req.body.questions : []).map(cleanQuestion).filter(Boolean);
  res.json(db.updateQuiz(id, title, questions));
});
app.delete('/api/quizzes/:id', auth, (req, res) => {
  db.deleteQuiz(Number(req.params.id));
  res.json({ ok: true });
});
app.get('/api/games', auth, (req, res) => res.json(db.listGames()));
app.get('/api/games/:id/csv', auth, (req, res) => {
  const game = db.getGame(Number(req.params.id));
  if (!game) return res.status(404).json({ error: 'Not found' });
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = db.getResults(game.id).map(r => [r.rank, esc(r.name), esc(r.group_name || ''), r.score, r.correct_count, r.times_left || 0, Math.round((r.away_ms || 0) / 1000)].join(','));
  res.type('text/csv').send(['rank,name,group,score,correct_answers,times_left_during_game,time_away_seconds', ...rows].join('\n'));
});
// total time (all players of the group added up) the group was away from the quiz
const secs = ms => Math.round((ms || 0) / 1000);
const mmss = ms => { const t = secs(ms); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
app.get('/api/games/:id/groups.csv', auth, (req, res) => {
  const game = db.getGame(Number(req.params.id));
  if (!game) return res.status(404).json({ error: 'Not found' });
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = db.getGroupResults(game.id).map(g => [g.rank, esc(g.group_name), g.players, g.total_score, g.avg_score, g.left_players || 0, secs(g.away_ms), mmss(g.away_ms)].join(','));
  res.type('text/csv').send(['rank,group,players,total_points,average_points,players_who_left_during_game,total_time_away_seconds,total_time_away_mm_ss', ...rows].join('\n'));
});

/* ---------------------------------------------------------------- Game state (in memory) */

const games = new Map(); // pin -> game

function newPin() {
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); } while (games.has(pin));
  return pin;
}

function createGame(quiz, hostSocketId) {
  const game = {
    pin: newPin(), quizId: quiz.id, title: quiz.title, questions: quiz.questions,
    state: 'lobby', qIndex: -1, players: new Map(), answers: new Map(),
    hostSocketId, startedAt: 0, endsAt: 0, timer: null, ticker: null, lobbyTimer: null,
    lastResults: null, endedPayload: null, finalRank: null, createdAt: Date.now(),
  };
  games.set(game.pin, game);
  return game;
}

function ranking(game) {
  return [...game.players.values()].sort((a, b) =>
    b.score - a.score || a.totalTime - b.totalTime || a.name.localeCompare(b.name));
}

// how many players joined each group (always all groups, in GROUPS order)
// count = players joined, away = currently away (app closed/switched or disconnected),
// left = players who left at least once while the game was running
function groupCounts(game) {
  const counts = GROUPS.map(name => ({ name, count: 0, away: 0, left: 0 }));
  for (const p of game.players.values()) {
    const c = counts[p.groupIndex];
    c.count++;
    if (p.away) c.away++;
    if (p.leaves > 0) c.left++;
  }
  return counts;
}

// automatic player label like "Zug 2 #7" (no names are asked)
function makeLabel(game, groupIndex, except) {
  const others = [...game.players.values()].filter(x => x !== except);
  const used = new Set(others.map(x => x.name));
  let n = others.filter(x => x.groupIndex === groupIndex).length + 1;
  let label;
  do { label = `${GROUPS[groupIndex]} #${n++}`; } while (used.has(label));
  return label;
}

// A player counts as "left" when, while questions are running, they disconnect or
// switch away from the quiz page (home button, other app, locked screen).
function markAway(game, p) {
  if (p.away) return;
  p.away = true;
  if (game.state === 'question' || game.state === 'results') {
    p.leaves++;
    p.awaySince = Date.now();
    // notice goes to the second-monitor group screen only, not to the main host screen
    io.to(displayRoom(game.pin)).emit('player:left', { name: p.name, group: p.group });
  }
  emitLobby(game);
}

function markBack(game, p) {
  if (!p.away) return;
  p.away = false;
  if (p.awaySince) { p.awayMs += Date.now() - p.awaySince; p.awaySince = 0; }
  if (p.leaves > 0 && (game.state === 'question' || game.state === 'results')) {
    io.to(displayRoom(game.pin)).emit('player:returned', { name: p.name, group: p.group });
  }
  emitLobby(game);
}

// group score = sum of all its players' points / number of players in the group
function groupRanking(game) {
  const agg = GROUPS.map(name => ({ name, players: 0, total: 0, left: 0, awayMs: 0 }));
  for (const p of game.players.values()) {
    agg[p.groupIndex].players++;
    agg[p.groupIndex].total += p.score;
    if (p.leaves > 0) agg[p.groupIndex].left++;
    agg[p.groupIndex].awayMs += p.awayMs;
  }
  return agg.filter(g => g.players > 0)
    .map(g => ({ ...g, exact: g.total / g.players, avg: Math.round((g.total / g.players) * 10) / 10 }))
    .sort((a, b) => b.exact - a.exact || a.name.localeCompare(b.name))
    .map(({ exact, ...g }, i) => ({ ...g, rank: i + 1 }));
}

function publicQuestion(game) {
  const q = game.questions[game.qIndex];
  return {
    index: game.qIndex, total: game.questions.length, type: q.type, text: q.text,
    options: q.type === 'mc' ? q.options : undefined, timeLimitMs: q.timeLimit * 1000,
  };
}

function emitLobby(game) {
  if (game.lobbyTimer) return;
  game.lobbyTimer = setTimeout(() => {
    game.lobbyTimer = null;
    const groups = groupCounts(game);
    const count = game.players.size;
    if (game.hostSocketId) io.to(game.hostSocketId).emit('lobby:update', { count, groups });
    // second-monitor group screen (counters + who left/is back)
    io.to(displayRoom(game.pin)).emit('groups:update', { count, groups, state: game.state });
  }, 250);
}

function startQuestion(game) {
  game.qIndex++;
  if (game.qIndex >= game.questions.length) return endGame(game);
  const q = game.questions[game.qIndex];
  game.state = 'question';
  game.answers = new Map();
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + q.timeLimit * 1000;
  io.to(game.pin).emit('question', { ...publicQuestion(game), remainingMs: q.timeLimit * 1000 });
  const idx = game.qIndex;
  game.timer = setTimeout(() => { if (game.qIndex === idx) endQuestion(game); }, q.timeLimit * 1000 + GRACE_MS);
  game.ticker = setInterval(() => {
    if (game.hostSocketId) {
      io.to(game.hostSocketId).emit('answer:count', { answered: game.answers.size, players: connectedCount(game) });
    }
  }, 500);
}

function connectedCount(game) {
  let n = 0;
  for (const p of game.players.values()) if (p.connected) n++;
  return n;
}

function endQuestion(game) {
  if (game.state !== 'question') return;
  clearTimeout(game.timer);
  clearInterval(game.ticker);
  game.state = 'results';

  const q = game.questions[game.qIndex];
  const limitMs = q.timeLimit * 1000;
  const dist = q.type === 'mc' ? q.options.map(() => 0) : null;
  const guesses = [];

  for (const p of game.players.values()) {
    const a = game.answers.get(p.id);
    let pts = 0;
    let exact = false;
    if (a) {
      if (q.type === 'mc') {
        dist[a.value]++;
        if (a.value === q.correct) { pts = scoreMultipleChoice(a.timeMs, limitMs); exact = true; }
      } else {
        pts = scoreNumber(a.value, q.answer, q.tolerance, a.timeMs, limitMs);
        exact = a.value === q.answer;
        guesses.push({ name: p.name, value: a.value, diff: Math.abs(a.value - q.answer) });
      }
    }
    p.score += pts;
    if (pts > 0) { p.correctCount++; p.totalTime += a.timeMs; }
    p.gained = pts;
    p.lastResult = {
      answered: !!a, correct: exact, points: pts, value: a ? a.value : null,
      correctText: q.type === 'mc' ? q.options[q.correct] : String(q.answer),
      type: q.type,
    };
  }

  // no ranking is shown during the game, only at the end
  for (const p of game.players.values()) {
    p.lastResult.score = p.score;
    p.lastResultIndex = game.qIndex;
    // players get no points/ranking between questions, just "ready for the next question"
    if (p.connected) io.to(p.socketId).emit('question:result', {});
  }

  guesses.sort((a, b) => a.diff - b.diff);
  const sortedVals = guesses.map(g => g.value).sort((a, b) => a - b);
  const median = sortedVals.length ? sortedVals[Math.floor(sortedVals.length / 2)] : null;

  game.lastResults = {
    index: game.qIndex, total: game.questions.length, type: q.type, text: q.text,
    options: q.options, correct: q.correct, answer: q.answer, dist,
    median,
    answered: game.answers.size, players: game.players.size,
    isLast: game.qIndex === game.questions.length - 1,
  };
  if (game.hostSocketId) io.to(game.hostSocketId).emit('host:results', game.lastResults);
}

function endGame(game) {
  game.state = 'ended';
  // players still away at the end: close their open interval
  for (const p of game.players.values()) {
    if (p.awaySince) { p.awayMs += Date.now() - p.awaySince; p.awaySince = 0; }
  }
  const rank = ranking(game);
  game.finalRank = rank;
  rank.forEach((p, i) => { p.rank = i + 1; });
  const groups = groupRanking(game);
  game.finalGroups = groups;
  let gameId = null;
  try { gameId = db.saveGame(game.quizId, game.title, rank, groups); } catch (e) { console.error('Could not save results:', e.message); }
  game.endedPayload = {
    gameId, count: rank.length, groups,
  };
  io.to(displayRoom(game.pin)).emit('groups:update', { count: rank.length, groups: groupCounts(game), state: 'ended' });
  if (game.hostSocketId) io.to(game.hostSocketId).emit('game:ended', game.endedPayload);
  for (const p of rank) if (p.connected) io.to(p.socketId).emit('game:over', playerOver(game, p));
  setTimeout(() => games.delete(game.pin), 2 * 60 * 60 * 1000).unref();
}

function playerOver(game, p) {
  const g = game.finalGroups.find(x => x.name === p.group);
  return {
    group: p.group,
    groupRank: g ? g.rank : null, groupAvg: g ? g.avg : 0, groups: game.finalGroups,
  };
}

function sendPlayerState(game, p) {
  const sid = p.socketId;
  if (game.state === 'lobby') return io.to(sid).emit('player:state', { state: 'lobby', group: p.group });
  if (game.state === 'question') {
    return io.to(sid).emit('question', {
      ...publicQuestion(game),
      remainingMs: Math.max(0, game.endsAt - Date.now()),
      answered: game.answers.has(p.id),
    });
  }
  if (game.state === 'results') {
    if (p.lastResult && p.lastResultIndex === game.qIndex) return io.to(sid).emit('question:result', {});
    return io.to(sid).emit('player:state', { state: 'wait' });
  }
  if (game.state === 'ended') return io.to(sid).emit('game:over', playerOver(game, p));
}

/* ---------------------------------------------------------------- Socket.IO */

function baseUrl(socket) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const h = socket.handshake.headers;
  const host = h['x-forwarded-host'] || h.host || `localhost:${PORT}`;
  const proto = h['x-forwarded-proto'] || 'http';
  if (/^(localhost|127\.0\.0\.1)/.test(host)) {
    const ip = lanIps()[0];
    if (ip) return `http://${ip}:${PORT}`;
  }
  return `${proto}://${host}`;
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

async function hostInfo(socket, game) {
  const joinUrl = `${baseUrl(socket)}/play?pin=${game.pin}`;
  const displayUrl = `${baseUrl(socket)}/groups?pin=${game.pin}`;
  const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 480 });
  return {
    ok: true, pin: game.pin, joinUrl, displayUrl, qr, title: game.title, total: game.questions.length,
    state: game.state, groups: groupCounts(game),
  };
}

function hostGuard(socket) {
  const game = games.get(socket.data.pin);
  if (!game || socket.data.role !== 'host' || game.hostSocketId !== socket.id) return null;
  return game;
}

io.on('connection', socket => {
  /* ---- host ---- */
  socket.on('host:create', async ({ quizId, password } = {}, ack = () => {}) => {
    if (password !== ADMIN_PASSWORD) return ack({ ok: false, error: 'Wrong password' });
    const quiz = db.getQuiz(Number(quizId));
    if (!quiz) return ack({ ok: false, error: 'Quiz not found' });
    if (!quiz.questions.length) return ack({ ok: false, error: 'This quiz has no questions yet' });
    const game = createGame(quiz, socket.id);
    socket.join(game.pin);
    socket.data = { role: 'host', pin: game.pin };
    ack(await hostInfo(socket, game));
  });

  socket.on('host:resume', async ({ pin, password } = {}, ack = () => {}) => {
    const game = games.get(String(pin));
    if (password !== ADMIN_PASSWORD || !game) return ack({ ok: false, error: 'Game not found' });
    game.hostSocketId = socket.id;
    socket.join(game.pin);
    socket.data = { role: 'host', pin: game.pin };
    ack(await hostInfo(socket, game));
    if (game.state === 'lobby') emitLobby(game);
    if (game.state === 'question') {
      socket.emit('question', { ...publicQuestion(game), remainingMs: Math.max(0, game.endsAt - Date.now()) });
    }
    if (game.state === 'results' && game.lastResults) socket.emit('host:results', game.lastResults);
    if (game.state === 'ended' && game.endedPayload) socket.emit('game:ended', game.endedPayload);
  });

  socket.on('host:start', () => {
    const game = hostGuard(socket);
    if (game && game.state === 'lobby' && game.players.size > 0) startQuestion(game);
  });
  socket.on('host:skip', () => {
    const game = hostGuard(socket);
    if (game) endQuestion(game);
  });
  socket.on('host:next', () => {
    const game = hostGuard(socket);
    if (game && game.state === 'results') startQuestion(game);
  });

  /* ---- group screen (second monitor, read-only) ---- */
  socket.on('display:join', ({ pin } = {}, ack = () => {}) => {
    const game = games.get(String(pin || '').trim());
    if (!game) return ack({ ok: false, error: 'Game not found. Check the PIN.' });
    socket.join(displayRoom(game.pin));
    socket.data = { role: 'display', pin: game.pin };
    ack({ ok: true, pin: game.pin, title: game.title, count: game.players.size, groups: groupCounts(game), state: game.state });
  });

  /* ---- player ---- */
  socket.on('player:join', ({ pin, name, token, group } = {}, ack = () => {}) => {
    const game = games.get(String(pin || '').trim());
    if (!game) return ack({ ok: false, error: 'Game not found. Check the PIN.' });
    let p = token && game.players.get(token);
    if (p) {
      p.socketId = socket.id;
      p.connected = true;
      markBack(game, p);
    } else {
      if (game.state === 'ended') return ack({ ok: false, error: 'This game is over.' });
      const groupIndex = GROUPS.indexOf(String(group || ''));
      if (groupIndex < 0) return ack({ ok: false, error: 'Please choose your group.' });
      // no names: every player gets an automatic label like "Zug 2 #7"
      p = {
        id: crypto.randomUUID(), name: makeLabel(game, groupIndex), group: GROUPS[groupIndex], groupIndex,
        socketId: socket.id, connected: true, away: false, leaves: 0, awayMs: 0, awaySince: 0,
        score: 0, gained: 0, correctCount: 0, totalTime: 0, rank: 0, lastResult: null, lastResultIndex: -1,
      };
      game.players.set(p.id, p);
    }
    socket.join(game.pin);
    socket.data = { role: 'player', pin: game.pin, playerId: p.id };
    ack({ ok: true, token: p.id, name: p.name, group: p.group, pin: game.pin });
    sendPlayerState(game, p);
    emitLobby(game);
  });

  // wrong group chosen? can be changed as long as the game has not started
  socket.on('player:changeGroup', ({ group } = {}, ack = () => {}) => {
    const game = games.get(socket.data.pin);
    const p = game && socket.data.role === 'player' && game.players.get(socket.data.playerId);
    if (!p) return ack({ ok: false, error: 'Not in a game' });
    if (game.state !== 'lobby') return ack({ ok: false, error: 'The game has already started.' });
    const groupIndex = GROUPS.indexOf(String(group || ''));
    if (groupIndex < 0) return ack({ ok: false, error: 'Please choose your group.' });
    if (groupIndex !== p.groupIndex) {
      p.groupIndex = groupIndex;
      p.group = GROUPS[groupIndex];
      p.name = makeLabel(game, groupIndex, p);
      emitLobby(game);
    }
    ack({ ok: true, group: p.group, name: p.name });
  });

  // phone reports whether the quiz page is visible; also sent every few seconds as a heartbeat
  socket.on('player:presence', ({ hidden } = {}) => {
    const game = games.get(socket.data.pin);
    const p = game && socket.data.role === 'player' && game.players.get(socket.data.playerId);
    if (!p) return;
    if (hidden) markAway(game, p); else markBack(game, p);
  });

  socket.on('player:answer', (payload = {}, ack = () => {}) => {
    const game = games.get(socket.data.pin);
    const p = game && socket.data.role === 'player' && game.players.get(socket.data.playerId);
    if (!p || game.state !== 'question') return ack({ ok: false, error: 'No open question' });
    if (game.answers.has(p.id)) return ack({ ok: false, error: 'Already answered' });
    const now = Date.now();
    if (now > game.endsAt + GRACE_MS) return ack({ ok: false, error: 'Too late' });
    const q = game.questions[game.qIndex];
    let value;
    if (q.type === 'mc') {
      value = Number(payload.value);
      if (!Number.isInteger(value) || value < 0 || value >= q.options.length) return ack({ ok: false, error: 'Invalid answer' });
    } else {
      value = Number(String(payload.value).trim().replace(',', '.'));
      if (!Number.isFinite(value)) return ack({ ok: false, error: 'Please enter a number' });
    }
    const timeMs = clamp(now - game.startedAt, 0, q.timeLimit * 1000);
    game.answers.set(p.id, { value, timeMs });
    ack({ ok: true });
    // everyone connected has answered: close the question shortly after
    if (connectedCount(game) > 0 && game.answers.size >= connectedCount(game)) {
      const idx = game.qIndex;
      setTimeout(() => { if (game.qIndex === idx) endQuestion(game); }, 400);
    }
  });

  socket.on('disconnect', () => {
    const { role, pin, playerId } = socket.data || {};
    const game = games.get(pin);
    if (!game) return;
    if (role === 'player') {
      const p = game.players.get(playerId);
      if (p && p.socketId === socket.id) { p.connected = false; markAway(game, p); }
    }
    if (role === 'host' && game.hostSocketId === socket.id) game.hostSocketId = null;
  });
});

// drop abandoned games after 6 hours
setInterval(() => {
  for (const [pin, g] of games) if (Date.now() - g.createdAt > 6 * 60 * 60 * 1000) games.delete(pin);
}, 60 * 60 * 1000).unref();

// Clean shutdown (Railway sends SIGTERM on every redeploy/restart): stop accepting connections,
// then close the database before exiting so the native SQLite module is not torn down mid-flight.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  io.close();
  server.close(() => {
    try { db.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`Quiz server running on port ${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin   (password: ${ADMIN_PASSWORD === 'admin' ? 'admin  <- change with ADMIN_PASSWORD' : '(from ADMIN_PASSWORD)'})`);
  lanIps().forEach(ip => console.log(`  Phones on the same WiFi can use: http://${ip}:${PORT}`));
});
