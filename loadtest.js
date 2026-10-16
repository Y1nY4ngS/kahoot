// Full-game load test: creates a quiz, hosts a game, joins N bots spread over the groups, plays every question,
// then checks the group counters, the per-group averages and the saved results.
// Usage: node loadtest.js [players=200]     (server must be running; BASE / ADMIN_PASSWORD env supported)
const { io } = require('socket.io-client');
const { scoreMultipleChoice, scoreNumber } = require('./scoring');

const BASE = process.env.BASE || 'http://localhost:3000';
const PW = process.env.ADMIN_PASSWORD || 'admin';
const N = parseInt(process.argv[2] || '200', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, method = 'GET', body) => fetch(BASE + p, {
  method, headers: { 'Content-Type': 'application/json', 'x-admin-password': PW },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json());

(async () => {
  const GROUPS = await fetch(BASE + '/api/groups').then(r => r.json());
  const quiz = await api('/api/quizzes', 'POST', { title: 'Loadtest' });
  const questions = [
    { type: 'mc', text: 'Pick the second one', options: ['A', 'B', 'C', 'D'], correct: 1, timeLimit: 10 },
    { type: 'number', text: 'Guess 2016', answer: 2016, tolerance: 10, timeLimit: 10 },
    { type: 'mc', text: 'Pick the first one', options: ['A', 'B', 'C'], correct: 0, timeLimit: 10 },
  ];
  await api(`/api/quizzes/${quiz.id}`, 'PUT', { title: 'Loadtest', questions });

  const host = io(BASE);
  await new Promise(r => host.on('connect', r));
  const info = await new Promise(r => host.emit('host:create', { quizId: quiz.id, password: PW }, r));
  if (!info.ok) throw new Error(info.error);
  console.log(`Game PIN ${info.pin}, groups: ${GROUPS.join(', ')}`);

  // second-monitor group screen
  const display = io(BASE);
  await new Promise(r => display.on('connect', r));
  const dinfo = await new Promise(r => display.emit('display:join', { pin: info.pin }, r));
  if (!dinfo.ok) throw new Error('display could not join: ' + dinfo.error);
  let lastDisplay = dinfo;
  display.on('groups:update', u => { lastDisplay = u; });
  const displayEvents = { left: 0, returned: 0 };
  display.on('player:left', () => displayEvents.left++);
  display.on('player:returned', () => displayEvents.returned++);

  // a player without a group must be rejected
  const probe = io(BASE, { transports: ['websocket'] });
  await new Promise(r => probe.on('connect', r));
  const noGroup = await new Promise(r => probe.emit('player:join', { pin: info.pin, name: 'NoGroup' }, r));
  const badGroup = await new Promise(r => probe.emit('player:join', { pin: info.pin, name: 'NoGroup', group: 'Zug 9' }, r));
  probe.close();

  console.log(`Joining ${N} bots...`);
  const bots = [];
  const overResults = [];
  const expectedCounts = Object.fromEntries(GROUPS.map(g => [g, 0]));
  let answerAcks = 0, answerRejects = 0, joinFailures = 0;
  for (let i = 0; i < N; i++) {
    const s = io(BASE, { transports: ['websocket'] });
    const group = GROUPS[i % GROUPS.length];
    const bot = { s, i, name: `Bot${i}`, group };
    s.on('question', q => {
      const delay = 200 + Math.random() * 2500;
      setTimeout(() => {
        let value;
        if (q.type === 'mc') value = Math.random() < 0.6 ? (q.index === 0 ? 1 : 0) : Math.floor(Math.random() * q.options.length);
        else value = Math.round(2016 + (Math.random() - 0.5) * 24);
        s.emit('player:answer', { value }, res => { res.ok ? answerAcks++ : answerRejects++; });
      }, delay);
    });
    s.on('question:result', r => { if (Object.keys(r).length) bot.sawResultData = true; });
    s.on('game:over', r => overResults.push({ name: bot.name, ...r }));
    bots.push(bot);
    await new Promise(r => s.on('connect', r));
    const res = await new Promise(r => s.emit('player:join', { pin: info.pin, name: bot.name, group }, r));
    if (res.ok) expectedCounts[group]++; else joinFailures++;
    if (i % 50 === 49) await sleep(50);
  }
  console.log(`${N - joinFailures} bots joined.`);

  // a player who picked the wrong group moves to another one while still in the lobby
  const chg = await new Promise(r => bots[0].s.emit('player:changeGroup', { group: GROUPS[1] }, r));
  if (chg.ok) { expectedCounts[GROUPS[0]]--; expectedCounts[GROUPS[1]]++; bots[0].group = GROUPS[1]; }
  await sleep(600);

  const displayAfterChange = lastDisplay.groups[1].count === expectedCounts[GROUPS[1]];
  const displayCounts = Object.fromEntries(lastDisplay.groups.map(g => [g.name, g.count]));
  console.log('Group screen counts:', GROUPS.map(g => `${g}=${displayCounts[g]}`).join(', '));

  const done = new Promise(resolve => host.on('game:ended', resolve));
  let hostSawRanking = false;
  let hostGotLeaveNotice = false;
  host.on('player:left', () => { hostGotLeaveNotice = true; });
  host.on('host:results', async r => {
    if (r.top) hostSawRanking = true;
    console.log(`Q${r.index + 1} done: ${r.answered}/${r.players} answered`);
    await sleep(300);
    host.emit('host:next');
  });
  // during the first question one bot leaves the page and another tries to change group
  let lateChange = { ok: true };
  let scripted = false;
  bots[1].s.on('question', () => {
    if (scripted) return;
    scripted = true;
    setTimeout(() => bots[1].s.emit('player:presence', { hidden: true }), 500);
    setTimeout(() => bots[1].s.emit('player:presence', { hidden: false }), 1500); // comes back
    setTimeout(() => bots[2].s.emit('player:changeGroup', { group: GROUPS[0] }, r => { lateChange = r; }), 600);
  });
  host.emit('host:start');
  const ended = await Promise.race([done, sleep(60000).then(() => null)]);
  if (!ended) throw new Error('Game did not finish in 60s');

  await sleep(500);
  const csv = await fetch(`${BASE}/api/games/${ended.gameId}/csv`, { headers: { 'x-admin-password': PW } }).then(r => r.text());
  const gcsv = await fetch(`${BASE}/api/games/${ended.gameId}/groups.csv`, { headers: { 'x-admin-password': PW } }).then(r => r.text());
  const lines = csv.trim().split('\n');
  console.log(`Game ended. Saved game #${ended.gameId}, players CSV rows: ${lines.length - 1}`);
  console.log(`Answers accepted: ${answerAcks}, rejected: ${answerRejects}`);
  console.log(`Players that received final standings: ${overResults.length}/${N}`);
  console.log('Group ranking (average points):');
  ended.groups.forEach(g => console.log(`  ${g.rank}. ${g.name}  avg ${g.avg}  (${g.players} players, total ${g.total})`));

  // expected averages recomputed independently from the saved players CSV
  const sums = {}, cnts = {};
  const scores = [];
  lines.slice(1).forEach(l => {
    const c = l.split(',').map(x => x.replace(/^"|"$/g, ''));
    const group = c[2], score = Number(c[3]);
    sums[group] = (sums[group] || 0) + score; cnts[group] = (cnts[group] || 0) + 1; scores.push(score);
  });
  const avgOk = ended.groups.every(g => cnts[g.name] === g.players
    && Math.abs(g.avg - Math.round((sums[g.name] / cnts[g.name]) * 10) / 10) < 0.001);
  const gRows = gcsv.trim().split('\n').slice(1).map(l => l.split(',').map(x => x.replace(/^"|"$/g, '')));
  const awayRow = gRows.find(c => c[1] === bots[1].group) || [];
  const awaySeconds = Number(awayRow[6]);
  console.log(`Time away (${bots[1].group}): ${awayRow[6]} s = ${awayRow[7]}`);
  const awayOk = awaySeconds >= 1 && awaySeconds <= 4;
  const sortedOk = ended.groups.every((g, i, a) => i === 0 || a[i - 1].avg >= g.avg);

  const maxPossible = questions.length * 1000;
  const checks = {
    'players CSV has one row per player': lines.length - 1 === N,
    'groups CSV has one row per group': gcsv.trim().split('\n').length - 1 === ended.groups.length,
    'all bots got final standings': overResults.length === N,
    'no individual data sent to players or host': !ended.top && overResults.every(r => !('rank' in r) && !('score' in r)),
    'scores within max': scores.every(x => x <= maxPossible),
    'join without group rejected': !noGroup.ok,
    'join with unknown group rejected': !badGroup.ok,
    'group screen counts match joins': GROUPS.every(g => displayCounts[g] === expectedCounts[g]),
    'group averages correct': avgOk,
    'groups sorted by average': sortedOk,
    'no ranking sent to host during game': !hostSawRanking,
    'no points/rank sent to players between questions': !bots.some(b => b.sawResultData),
    'group change works in the lobby': chg.ok && displayAfterChange,
    'group change rejected once the game started': !lateChange.ok,
    'leaving player counted for its group': (ended.groups.find(g => g.name === bots[1].group) || {}).left >= 1,
    'group screen shows who left': lastDisplay.groups.some(g => g.left >= 1),
    'groups CSV has summed time away (~1 s for the bot that left)': awayOk,
    'group screen got leave + return notices': displayEvents.left >= 1 && displayEvents.returned >= 1,
    'returning player recognised (nobody away at the end)': lastDisplay.groups.every(g => g.away === 0),
    'main host screen gets no leave notice': !hostGotLeaveNotice,
    'scoring formulas': scoreMultipleChoice(0, 10000) === 1000 && scoreMultipleChoice(10000, 10000) === 500
      && scoreNumber(2016, 2016, 10) === 1000 && scoreNumber(2011, 2016, 10) === 250 && scoreNumber(2026, 2016, 10) === 0,
  };
  for (const [name, pass] of Object.entries(checks)) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');

  await api(`/api/quizzes/${quiz.id}`, 'DELETE');
  bots.forEach(b => b.s.close());
  host.close();
  display.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
