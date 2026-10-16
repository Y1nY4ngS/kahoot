const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
let quiz = null; // { id, title, questions }
let dirty = false;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-password': localStorage.getItem('qp_pw') || '', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    const pw = prompt('Admin password:');
    if (pw === null) throw new Error('cancelled');
    localStorage.setItem('qp_pw', pw);
    return api(path, opts);
  }
  return res;
}

async function loadList() {
  const quizzes = await (await api('/api/quizzes')).json();
  document.getElementById('quizList').innerHTML = quizzes.map(q => `
    <div class="qitem ${quiz && quiz.id === q.id ? 'active' : ''}" data-id="${q.id}">
      <span>${esc(q.title)}</span><small>${q.count} Q</small>
    </div>`).join('') || '<p style="opacity:.7">No quizzes yet.</p>';
  document.querySelectorAll('#quizList .qitem').forEach(el => el.onclick = () => openQuiz(el.dataset.id));

  const games = await (await api('/api/games')).json();
  document.getElementById('gameList').innerHTML = games.slice(0, 10).map(g => `
    <div class="qitem" style="cursor:default"><span>${esc(g.title)}<br><small>${new Date(g.played_at).toLocaleString()} · ${g.player_count} players</small></span>
      <span><button class="small" data-csv="groups" data-g="${g.id}">Groups CSV</button> <button class="small" data-csv="players" data-g="${g.id}">Players CSV</button></span></div>`).join('') || '<p style="opacity:.7">None yet.</p>';
  document.querySelectorAll('#gameList button[data-csv]').forEach(btn => btn.onclick = async () => {
    const groups = btn.dataset.csv === 'groups';
    const res = await api(`/api/games/${btn.dataset.g}/${groups ? 'groups.csv' : 'csv'}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `${groups ? 'groups' : 'players'}-game-${btn.dataset.g}.csv`; a.click();
    URL.revokeObjectURL(url);
  });
}

async function openQuiz(id) {
  if (dirty && !confirm('You have unsaved changes. Discard them?')) return;
  quiz = await (await api(`/api/quizzes/${id}`)).json();
  dirty = false;
  renderEditor();
  loadList();
}

function blankMC() { return { type: 'mc', text: '', options: ['', '', '', ''], correct: 0, timeLimit: 20 }; }
function blankNum() { return { type: 'number', text: '', answer: 0, tolerance: '', timeLimit: 30 }; }

function renderEditor() {
  const ed = document.getElementById('editor');
  if (!quiz) { ed.innerHTML = '<p>Create or select a quiz on the left.</p>'; return; }
  ed.innerHTML = `
    <div class="card">
      <label>Quiz title</label>
      <input id="title" value="${esc(quiz.title)}">
      <div class="row">
        <button class="primary" id="save" style="background:var(--bg);color:#fff">Save</button>
        <button class="primary" id="start" style="background:var(--accent);color:#fff">▶ Save &amp; start game</button>
        <button class="danger" id="del">Delete quiz</button>
        <span id="status"></span>
      </div>
    </div>
    <div id="questions"></div>
    <div class="row">
      <button class="primary" id="addMC" style="background:var(--bg);color:#fff">+ Multiple choice</button>
      <button class="primary" id="addNum" style="background:var(--bg);color:#fff">+ Number guess</button>
    </div>`;

  document.getElementById('title').oninput = e => { quiz.title = e.target.value; dirty = true; };
  document.getElementById('save').onclick = save;
  document.getElementById('start').onclick = async () => {
    // open the tab right away (inside the click) so Safari/Chrome don't block it as a pop-up, then save and point it at the host page
    const w = window.open('', '_blank');
    if (!(await save())) { if (w) w.close(); return; }
    const url = `/host?quiz=${quiz.id}`;
    if (w) w.location.href = url; else location.href = url;
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm('Delete this quiz permanently?')) return;
    await api(`/api/quizzes/${quiz.id}`, { method: 'DELETE' });
    quiz = null; dirty = false; renderEditor(); loadList();
  };
  document.getElementById('addMC').onclick = () => { quiz.questions.push(blankMC()); dirty = true; renderQuestions(); scrollEnd(); };
  document.getElementById('addNum').onclick = () => { quiz.questions.push(blankNum()); dirty = true; renderQuestions(); scrollEnd(); };
  renderQuestions();
}

function scrollEnd() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }

function renderQuestions() {
  const box = document.getElementById('questions');
  box.innerHTML = quiz.questions.map((q, i) => `
    <div class="card" data-i="${i}">
      <div class="row" style="margin-top:0">
        <span class="tag">${q.type === 'mc' ? 'Multiple choice' : 'Number guess'}</span>
        <b>Question ${i + 1}</b>
        <span class="grow"></span>
        <button class="small" data-act="up">↑</button>
        <button class="small" data-act="down">↓</button>
        <button class="small" data-act="dup">Duplicate</button>
        <button class="small" data-act="rm">Delete</button>
      </div>
      <label>Question text</label>
      <textarea rows="2" data-f="text">${esc(q.text)}</textarea>
      ${q.type === 'mc' ? mcFields(q, i) : numFields(q)}
      <div class="row">
        <div><label>Time limit (seconds)</label><input type="number" min="5" max="120" data-f="timeLimit" value="${esc(q.timeLimit)}" style="width:120px"></div>
      </div>
    </div>`).join('') || '<p>No questions yet. Add one below.</p>';

  box.querySelectorAll('.card').forEach(card => {
    const i = Number(card.dataset.i);
    const q = quiz.questions[i];
    card.querySelectorAll('[data-f]').forEach(inp => {
      inp.oninput = () => { q[inp.dataset.f] = inp.value; dirty = true; };
    });
    card.querySelectorAll('[data-o]').forEach(inp => {
      inp.oninput = () => { q.options[Number(inp.dataset.o)] = inp.value; dirty = true; };
    });
    card.querySelectorAll('input[type=radio]').forEach(r => {
      r.onchange = () => { q.correct = Number(r.value); dirty = true; };
    });
    card.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = () => {
        const a = btn.dataset.act;
        if (a === 'rm') quiz.questions.splice(i, 1);
        if (a === 'dup') quiz.questions.splice(i + 1, 0, JSON.parse(JSON.stringify(q)));
        if (a === 'up' && i > 0) [quiz.questions[i - 1], quiz.questions[i]] = [quiz.questions[i], quiz.questions[i - 1]];
        if (a === 'down' && i < quiz.questions.length - 1) [quiz.questions[i + 1], quiz.questions[i]] = [quiz.questions[i], quiz.questions[i + 1]];
        if (a === 'addopt') { if (q.options.length < 6) q.options.push(''); }
        if (a === 'rmopt') { if (q.options.length > 2) { q.options.pop(); if (q.correct >= q.options.length) q.correct = 0; } }
        dirty = true;
        renderQuestions();
      };
    });
  });
}

function mcFields(q, i) {
  return `
    <label style="display:block;margin-top:10px">Answers (select the correct one)</label>
    ${q.options.map((o, k) => `
      <div class="optrow">
        <span class="dot" style="background:${COLORS[k]}"></span>
        <input type="radio" name="correct-${i}" value="${k}" ${q.correct === k ? 'checked' : ''} title="Correct answer">
        <input data-o="${k}" value="${esc(o)}" placeholder="Answer ${k + 1}">
      </div>`).join('')}
    <div class="row">
      <button class="small" data-act="addopt">+ Answer</button>
      <button class="small" data-act="rmopt">− Answer</button>
    </div>`;
}

function numFields(q) {
  return `
    <div class="row">
      <div><label>Correct number</label><input type="number" step="any" data-f="answer" value="${esc(q.answer)}" style="width:180px"></div>
      <div><label>Tolerance (optional)</label><input type="number" step="any" min="0" data-f="tolerance" value="${esc(q.tolerance || '')}" placeholder="auto" style="width:180px"></div>
    </div>
    <div class="hintt">Scoring: accuracy × speed. A guess loses points in a straight line the further it is off, down to 0 at the tolerance, then a faster answer scores more (last second = half of the points, like multiple choice). Leave tolerance empty to use 100% of the correct number: 10% off → 90% of the points, 25% off → 75%, 50% off → 50%.
      Example: year 2016 with tolerance 10 → guess 2014 answered instantly gives 800 points, 2011 gives 500.</div>`;
}

async function save() {
  const status = document.getElementById('status');
  const res = await api(`/api/quizzes/${quiz.id}`, {
    method: 'PUT',
    body: JSON.stringify({ title: quiz.title, questions: quiz.questions }),
  });
  if (!res.ok) { status.textContent = 'Save failed'; return false; }
  const saved = await res.json();
  const dropped = quiz.questions.length - saved.questions.length;
  quiz = saved;
  dirty = false;
  renderEditor();
  document.getElementById('status').innerHTML = `<span class="save-ok">Saved${dropped ? ` (${dropped} incomplete question${dropped > 1 ? 's' : ''} skipped: every question needs a text, multiple choice needs 2 answers, number guess needs the correct number)` : ''}</span>`;
  loadList();
  return true;
}

document.getElementById('newQuiz').onclick = async () => {
  const title = prompt('Quiz title:', 'My quiz');
  if (!title) return;
  const q = await (await api('/api/quizzes', { method: 'POST', body: JSON.stringify({ title }) })).json();
  quiz = q; dirty = false;
  renderEditor(); loadList();
};

window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

loadList().catch(() => {});
