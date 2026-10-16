// Second-monitor screen: live count of how many players joined each group.
// Open /groups?pin=123456 (the host screen has a button for it). Read-only, works in any browser.
const socket = io();
const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let pin = new URLSearchParams(location.search).get('pin') || '';
let title = '';

function askPin(error = '') {
  app.innerHTML = `
    <div style="max-width:420px;margin:0 auto;text-align:center">
      <h1>Group screen</h1>
      <input id="pin" inputmode="numeric" maxlength="6" placeholder="Game PIN" value="${esc(pin)}" style="font-size:1.6rem;text-align:center">
      <div style="height:12px"></div>
      <button class="primary" id="go" style="font-size:1.2rem">Show</button>
      <div style="color:#ffb4c0;min-height:1.4em;margin-top:8px;font-weight:600">${esc(error)}</div>
    </div>`;
  const go = () => { pin = document.getElementById('pin').value.trim(); join(); };
  document.getElementById('go').onclick = go;
  document.getElementById('pin').onkeydown = e => { if (e.key === 'Enter') go(); };
}

let last = { count: 0, groups: [], state: 'lobby' };
const events = []; // newest first

function cardNote(g, state) {
  if (state === 'lobby' || !g.left) return '';
  const back = Math.max(0, g.left - g.away);
  return `<em>${g.left} left${back ? ` · ${back} back` : ''}${g.away ? ` · <span class="awaynow">${g.away} away now</span>` : ''}</em>`;
}

function draw(payload) {
  last = payload;
  const { count, groups, state } = payload;
  const status = state === 'lobby' ? 'Waiting for players…' : state === 'ended' ? 'Game over' : 'Game running';
  app.innerHTML = `
    <div class="topbar"><span>${esc(title)}</span><span>PIN ${esc(pin)}</span><span>${status}</span></div>
    <div class="gcards">${groups.map((g, i) => `<div class="gcard" style="border-top-color:var(--g${i})"><b>${g.count}</b><span>${esc(g.name)}</span>${cardNote(g, state)}</div>`).join('')}</div>
    <div class="total">${count} player${count === 1 ? '' : 's'} joined</div>
    ${events.length ? `<div class="eventlog">${events.map(e => `<div class="ev ${e.kind}"><span>${e.time}</span> ${esc(e.text)}</div>`).join('')}</div>` : ''}`;
}

// someone left / came back while questions are running
function notice(kind, text) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  events.unshift({ kind, text, time });
  if (events.length > 8) events.pop();
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.appendChild(t);
  setTimeout(() => t.remove(), 6000);
  draw(last);
}
socket.on('player:left', ({ group, name }) => notice('left', `${group}: ${name} left the quiz`));
socket.on('player:returned', ({ group, name }) => notice('back', `${group}: ${name} is back`));

function join() {
  if (!pin) return askPin();
  socket.emit('display:join', { pin }, res => {
    if (!res.ok) return askPin(res.error);
    title = res.title;
    draw(res);
  });
}

socket.on('groups:update', draw);
// re-attach after a network blip or server restart
socket.on('connect', () => { if (pin) join(); });
if (!pin) askPin();
