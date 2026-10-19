const socket = io();
const app = document.getElementById('app');
const controls = document.getElementById('controls');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHAPES = ['▲', '◆', '●', '■', '★', '⬢'];

const pw = localStorage.getItem('qp_pw');
const params = new URLSearchParams(location.search);
let game = null;
let primary = null; // current primary action { label, event }
let timerInterval = null;

function setControls(label, event, hint) {
  primary = event ? { label, event } : null;
  controls.innerHTML = `
    <span class="hint">${hint || ''}</span>
    ${event ? `<button class="primary" id="main" style="font-size:1.3rem">${label}</button>` : '<span></span>'}`;
  if (event) document.getElementById('main').onclick = () => socket.emit(event);
}

document.addEventListener('keydown', e => {
  if ((e.code === 'Space' || e.key === 'Enter') && primary && document.activeElement === document.body) {
    e.preventDefault();
    socket.emit(primary.event);
  }
});

function onGame(res) {
  if (!res.ok) {
    sessionStorage.removeItem('qp_hostpin');
    app.innerHTML = `<div class="panel warn">${esc(res.error)}</div><p><a href="/admin" style="color:#fff">Back to admin</a></p>`;
    return;
  }
  game = res;
  sessionStorage.setItem('qp_hostpin', res.pin);
  if (params.get('quiz')) history.replaceState(null, '', '/host');
  if (res.state === 'lobby') renderLobby([], res.groups);
}

const gcardsHtml = groups => (groups || []).map((g, i) =>
  `<div class="gcard" style="border-top-color:var(--g${i})"><b>${g.count}</b><span>${esc(g.name)}</span></div>`).join('');

function init() {
  if (!pw) { location.href = '/admin'; return; }
  const quiz = params.get('quiz');
  const pin = sessionStorage.getItem('qp_hostpin');
  if (quiz) {
    sessionStorage.removeItem('qp_hostpin');
    socket.emit('host:create', { quizId: quiz, password: pw }, onGame);
  } else if (pin) {
    socket.emit('host:resume', { pin, password: pw }, onGame);
  } else {
    location.href = '/admin';
  }
}

let first = true;
socket.on('connect', () => {
  if (first) { first = false; init(); return; }
  // reconnect: re-attach to the running game
  const pin = sessionStorage.getItem('qp_hostpin');
  if (pin) socket.emit('host:resume', { pin, password: pw }, res => { if (res.ok) game = res; });
});

/* ---------- lobby ---------- */
function renderLobby(names, groups) {
  clearInterval(timerInterval);
  const lan = /^(localhost|127\.)/.test(new URL(game.joinUrl).hostname);
  app.innerHTML = `
    <div class="topbar"><span>${esc(game.title)} · ${game.total} questions</span><span id="count">${(groups || []).reduce((a, g) => a + g.count, 0)} joined</span></div>
    <div class="lobby">
      <div>
        <div style="font-size:1.6rem;opacity:.85">Join at <b>${esc(new URL(game.joinUrl).host)}</b> with PIN</div>
        <div class="pinbig">${esc(game.pin)}</div>
        <div style="font-size:1.2rem;opacity:.7;margin:1.5vh 0">or scan the QR code</div>
        ${lan ? '<div class="warn">This link only works on this computer. Set PUBLIC_URL or use your network address.</div>' : ''}
        <div class="gcards" id="gcards" style="margin-top:2vh">${gcardsHtml(groups)}</div>
        <div style="margin-top:2vh"><button class="ghost" id="openGroups" title="Opens the group counter in a new window">Second monitor</button></div>
      </div>
      <img src="${game.qr}" alt="QR code to join">
    </div>`;
  document.getElementById('openGroups').onclick = e => { window.open(game.displayUrl, 'groupscreen'); e.currentTarget.blur(); };
  setControls('Start game', 'host:start', 'Space / Enter = start');
}

socket.on('lobby:update', ({ count, groups }) => {
  if (!game) return;
  const c = document.getElementById('count');
  if (!c) return;
  c.textContent = `${count} joined`;
  document.getElementById('gcards').innerHTML = gcardsHtml(groups);
});

/* ---------- question ---------- */
socket.on('question', q => {
  if (!game) return;
  clearInterval(timerInterval);
  const endAt = performance.now() + q.remainingMs;
  const opts = q.type === 'mc'
    ? `<div class="opts">${q.options.map((o, i) => `<div class="opt opt${i}"><span>${SHAPES[i]}</span><span>${esc(o)}</span></div>`).join('')}</div>`
    : `<div class="stat"><b>#</b>Type your guess on your phone</div>`;
  app.innerHTML = `
    <div class="topbar"><span>Question ${q.index + 1} / ${q.total}</span><span class="toptitle">${esc(game.title)}</span><span class="timer" id="t"></span></div>
    <div class="bar"><i id="bar"></i></div>
    <div class="qtext">${esc(q.text)}</div>
    ${opts}
    <div class="answers" id="ans">0 answered</div>`;
  const bar = document.getElementById('bar');
  const t = document.getElementById('t');
  const tick = () => {
    const left = Math.max(0, endAt - performance.now());
    t.textContent = Math.ceil(left / 1000);
    bar.style.width = (left / q.timeLimitMs * 100) + '%';
  };
  tick();
  timerInterval = setInterval(tick, 100);
  setControls('Skip / show results', 'host:skip', 'Space / Enter = end question now');
});

socket.on('answer:count', ({ answered, players }) => {
  const a = document.getElementById('ans');
  if (a) a.textContent = `${answered} / ${players} answered`;
});

/* ---------- results ---------- */
socket.on('host:results', r => {
  clearInterval(timerInterval);
  let body = '';
  if (r.type === 'mc') {
    const max = Math.max(1, ...r.dist);
    body = `<div class="opts">${r.options.map((o, i) => `
      <div class="opt opt${i} ${i === r.correct ? '' : 'dim'}">
        <span>${i === r.correct ? '✔' : SHAPES[i]}</span><span>${esc(o)}</span><span class="cnt">${r.dist[i]}</span>
      </div>`).join('')}</div>`;
  } else {
    body = `
      <div class="stat">Correct answer<b>${esc(r.answer)}</b></div>
      <div class="stat" style="font-size:1.4rem">Median guess: ${r.median === null ? '–' : esc(r.median)}</div>`;
  }
  app.innerHTML = `
    <div class="topbar"><span>Question ${r.index + 1} / ${r.total}</span><span class="toptitle">${esc(r.title || game.title)}</span><span>${r.answered} / ${r.players} answered</span></div>
    <div class="qtext">${esc(r.text)}</div>
    ${body}`;
  setControls(r.isLast ? 'Final results' : 'Next question', 'host:next', 'Space / Enter = continue');
});

/* ---------- end ---------- */
socket.on('game:ended', async e => {
  clearInterval(timerInterval);
  // final ranking = groups by AVERAGE points per player (sum of the group's points / players in the group)
  const [a, b, c] = e.groups;
  const pod = (g, cls) => g ? `<div class="${cls}"><span>${g.rank}</span>${esc(g.name)}<small>Ø ${g.avg}</small><small>${g.players} players</small></div>` : '';
  app.innerHTML = `
    <div class="topbar"><span>Game over · ${e.count} players</span></div>
    <h1 style="text-align:center;font-size:3rem">Group ranking (average points)</h1>
    <div class="podium">${pod(b, 'p2')}${pod(a, 'p1')}${pod(c, 'p3')}</div>
    <div class="lb grouprank">${e.groups.slice(3).map(g => `<div class="lbrow"><span>${g.rank}. ${esc(g.name)}</span><span>Ø ${g.avg}<small>${g.players} players</small></span></div>`).join('')}</div>`;
  controls.innerHTML = `<span class="hint">Results saved${e.gameId ? ` (game #${e.gameId})` : ''}</span>
    <span>${e.gameId ? '<button class="primary" id="csvG">Groups CSV</button> <button class="primary" id="csv">Players CSV</button> ' : ''}<a href="/admin"><button class="ghost">Back to admin</button></a></span>`;
  primary = null;
  sessionStorage.removeItem('qp_hostpin');
  const download = async (path, filename) => {
    const res = await fetch(path, { headers: { 'x-admin-password': pw } });
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    URL.revokeObjectURL(url);
  };
  if (e.gameId) {
    document.getElementById('csv').onclick = () => download(`/api/games/${e.gameId}/csv`, `players-game-${e.gameId}.csv`);
    document.getElementById('csvG').onclick = () => download(`/api/games/${e.gameId}/groups.csv`, `groups-game-${e.gameId}.csv`);
  }
});
