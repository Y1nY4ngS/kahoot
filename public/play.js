const socket = io();
const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHAPES = ['▲', '◆', '●', '■', '★', '⬢'];

let GROUPS = ['KDO Zug', 'Zug 1', 'Zug 2', 'Zug 3', 'Zug 4']; // replaced by the server's list on load

let me = null; // { pin, name, token, group }
try { me = JSON.parse(localStorage.getItem('qp_player') || 'null'); } catch (e) { me = null; }
const urlPin = new URLSearchParams(location.search).get('pin') || '';
let joined = false;
let chosenGroup = (me && me.group) || '';

function render(html) { app.innerHTML = html; }
// big colored banner with the group name, readable from a distance
const groupBanner = (huge = false) => {
  if (!me || !me.group) return '';
  const i = Math.max(0, GROUPS.indexOf(me.group));
  return `<div class="gbanner ${huge ? 'huge' : ''}" style="background:var(--g${i});color:var(--gt${i})">${esc(me.group)}</div>`;
};
const groupTag = () => (me && me.group ? `<span class="grouptag">${esc(me.group)}</span>` : '');

function showJoin(error = '') {
  const pin = urlPin || (me && me.pin) || '';
  render(`
    <div class="logo">Join the quiz</div>
    <div class="panel">
      <input id="pin" inputmode="numeric" maxlength="6" placeholder="Game PIN" value="${esc(pin)}">
      <div style="height:14px"></div>
      <div class="grouplabel">Your group</div>
      <div class="grpgrid" id="grps">${GROUPS.map(g =>
        `<button type="button" class="grp ${g === chosenGroup ? 'sel' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>
      <div style="height:14px"></div>
      <button class="primary" id="go" style="width:100%;font-size:1.3rem">Join</button>
      <div class="error" id="err">${esc(error)}</div>
    </div>`);
  const go = () => {
    if (!chosenGroup) return showError('Please choose your group.');
    join(document.getElementById('pin').value.trim(), chosenGroup);
  };
  document.querySelectorAll('#grps .grp').forEach(b => {
    b.onclick = () => {
      chosenGroup = b.dataset.g;
      document.querySelectorAll('#grps .grp').forEach(x => x.classList.toggle('sel', x === b));
      showError('');
    };
  });
  document.getElementById('go').onclick = go;
  document.getElementById('pin').onkeydown = e => { if (e.key === 'Enter') go(); };
  if (!pin) document.getElementById('pin').focus();
}

function showError(msg) {
  const err = document.getElementById('err');
  if (err) err.textContent = msg;
}

function join(pin, group) {
  const token = me && me.pin === pin ? me.token : null;
  socket.emit('player:join', { pin, token, group }, res => {
    if (!res.ok) { joined = false; return showJoin(res.error); }
    joined = true;
    me = { pin: res.pin, name: res.name, token: res.token, group: res.group };
    chosenGroup = res.group;
    localStorage.setItem('qp_player', JSON.stringify(me));
    if (document.hidden) socket.emit('player:presence', { hidden: true });
  });
}

// automatic re-join after a network blip or phone sleep
socket.on('connect', () => { if (joined && me) join(me.pin, me.group); });

function renderLobby() {
  render(`<div class="logo">You're in!</div>
    ${groupBanner(true)}
    <div class="panel">
    <p>Waiting for the host to start…</p>
    <button class="ghost" id="change" style="margin-top:6px">Wrong group? Change it</button></div>`);
  document.getElementById('change').onclick = () => showChangeGroup();
}

// pick another group (only possible until the host starts the game)
function showChangeGroup(error = '') {
  render(`<div class="logo">Choose your group</div>
    <div class="panel">
      <div class="grpgrid" id="grps">${GROUPS.map(g =>
        `<button type="button" class="grp ${g === me.group ? 'sel' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>
      <div class="error" id="err">${esc(error)}</div>
      <button class="ghost" id="back">Cancel</button>
    </div>`);
  document.getElementById('back').onclick = renderLobby;
  document.querySelectorAll('#grps .grp').forEach(b => {
    b.onclick = () => socket.emit('player:changeGroup', { group: b.dataset.g }, res => {
      if (!res.ok) return showChangeGroup(res.error);
      me.group = res.group; me.name = res.name; chosenGroup = res.group;
      localStorage.setItem('qp_player', JSON.stringify(me));
      renderLobby();
    });
  });
}

socket.on('player:state', ({ state }) => {
  if (state === 'lobby') renderLobby();
  else render(`${groupBanner()}<div class="panel"><div class="big">Get ready</div><p>Next question is coming up…</p></div>`);
});

let barTimer = null;
socket.on('question', q => {
  const opts = q.type === 'mc'
    ? `<div class="grid ${q.options.length > 4 ? 'many' : ''}">${q.options.map((o, i) =>
        `<button class="opt${i}" data-i="${i}">${SHAPES[i]}<span class="opt-label">${esc(o)}</span></button>`).join('')}</div>`
    : `<div class="panel">
         <input class="num" id="num" inputmode="decimal" placeholder="Your number" autocomplete="off">
         <div style="height:12px"></div>
         <button class="primary" id="send" style="width:100%;font-size:1.3rem">Send</button>
         <div class="error" id="err"></div>
       </div>`;
  render(`
    ${groupBanner()}
    <div style="opacity:.85;font-weight:700">Question ${q.index + 1} / ${q.total}</div>
    <div class="bar"><i id="bar"></i></div>
    <div class="qtext">${esc(q.text)}</div>
    ${opts}`);

  const bar = document.getElementById('bar');
  bar.style.transition = 'none';
  bar.style.width = (q.remainingMs / q.timeLimitMs * 100) + '%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${q.remainingMs}ms linear`;
    bar.style.width = '0%';
  }));

  if (q.answered) return locked();

  if (q.type === 'mc') {
    app.querySelectorAll('button[data-i]').forEach(b => {
      b.onclick = () => submit(Number(b.dataset.i));
    });
  } else {
    const num = document.getElementById('num');
    const send = () => submit(num.value);
    document.getElementById('send').onclick = send;
    num.onkeydown = e => { if (e.key === 'Enter') send(); };
  }
});

function submit(value) {
  socket.emit('player:answer', { value }, res => {
    if (res && res.ok) return locked();
    const err = document.getElementById('err');
    if (err) err.textContent = res && res.error ? res.error : 'Could not send';
    if (res && (res.error === 'Too late' || res.error === 'No open question')) locked('Too late!');
  });
}

function locked(msg) {
  render(`${groupBanner()}<div class="panel"><div class="big">${esc(msg || 'Answer locked in')}</div><p>Waiting for the others…</p></div>`);
}

// Between questions players see NO points, correct/wrong or ranking, just a waiting screen.
// Rankings (groups by average) are only shown at the very end.
socket.on('question:result', () => {
  render(`
    ${groupBanner()}
    <div class="panel">
      <div class="big">Ready for the next question</div>
      <p>Answers are in. Keep this page open.</p>
    </div>`);
});

socket.on('game:over', r => {
  render(`
    <div class="logo">Game over</div>
    <div class="panel">
      <div class="groupbig">${esc(r.group)}</div>
      <div class="big">#${r.groupRank}</div>
      <div>Group average <b>${r.groupAvg}</b> points</div>
    </div>
    <div class="panel"><b>Group ranking</b>${r.groups.map(g =>
      `<div class="grank ${g.name === r.group ? 'me' : ''}"><span>${g.rank}. ${esc(g.name)}</span><span>${g.avg} <small>(${g.players})</small></span></div>`).join('')}</div>`);
  joined = false;
  localStorage.removeItem('qp_player');
});

// Tell the server when the quiz page is left (home button, other app, locked screen) and when it is back.
let hiddenAt = 0;
const sendPresence = () => { if (joined && socket.connected) socket.emit('player:presence', { hidden: document.hidden }); };
function comeBack() {
  // After a while in the background the connection is usually dead although the phone doesn't know yet
  // (it would take ~30 s to notice). So reconnect right away; the rejoin marks the player as back.
  if (joined && hiddenAt && Date.now() - hiddenAt > 2000) { hiddenAt = 0; socket.disconnect().connect(); }
  else { hiddenAt = 0; sendPresence(); }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); sendPresence(); } else comeBack();
});
window.addEventListener('pageshow', comeBack); // page restored from the browser's back/forward cache
window.addEventListener('focus', () => { if (!document.hidden) sendPresence(); });
window.addEventListener('pagehide', () => { if (joined) socket.emit('player:presence', { hidden: true }); });
setInterval(sendPresence, 5000); // heartbeat so a missed message never leaves a player stuck as "away"

function start() {
  // auto-join if we have a saved session for this PIN (page reload)
  if (me && me.token && (!urlPin || urlPin === me.pin)) {
    joined = true;
    socket.emit('player:join', { pin: me.pin, token: me.token, group: me.group }, res => {
      if (!res.ok) { joined = false; showJoin(); }
      else if (document.hidden) socket.emit('player:presence', { hidden: true });
    });
    render('<div class="logo">Reconnecting…</div>');
  } else {
    showJoin();
  }
}

fetch('/api/groups').then(r => r.json()).then(g => { if (Array.isArray(g) && g.length) GROUPS = g; }).catch(() => {}).finally(start);
