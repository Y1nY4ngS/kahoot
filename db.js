// SQLite storage for quizzes (questions) and final results.
// Live game state is kept in memory in server.js, the DB is only for persistence.
const Database = require('better-sqlite3');
const path = require('path');

const fs = require('fs');

const dbFile = process.env.DB_FILE || path.join(__dirname, 'quiz.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true }); // e.g. /data if the volume folder is missing
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER,
  title TEXT,
  played_at TEXT,
  player_count INTEGER
);
CREATE TABLE IF NOT EXISTS results (
  game_id INTEGER,
  rank INTEGER,
  name TEXT,
  score INTEGER,
  correct_count INTEGER,
  group_name TEXT,
  times_left INTEGER DEFAULT 0,
  away_ms INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS group_results (
  game_id INTEGER,
  rank INTEGER,
  group_name TEXT,
  players INTEGER,
  total_score INTEGER,
  avg_score REAL,
  left_players INTEGER DEFAULT 0,
  away_ms INTEGER DEFAULT 0
);
`);

// older quiz.db files get the newer columns automatically
function addColumn(table, column, type) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
addColumn('results', 'group_name', 'TEXT');
addColumn('results', 'times_left', 'INTEGER DEFAULT 0');
addColumn('group_results', 'left_players', 'INTEGER DEFAULT 0');
addColumn('results', 'away_ms', 'INTEGER DEFAULT 0');
addColumn('group_results', 'away_ms', 'INTEGER DEFAULT 0');

const now = () => new Date().toISOString();

function listQuizzes() {
  return db.prepare('SELECT id, title, data, updated_at FROM quizzes ORDER BY id DESC').all()
    .map(r => ({ id: r.id, title: r.title, count: JSON.parse(r.data).length, updated_at: r.updated_at }));
}

function getQuiz(id) {
  const r = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id);
  return r ? { id: r.id, title: r.title, questions: JSON.parse(r.data) } : null;
}

function createQuiz(title) {
  const info = db.prepare('INSERT INTO quizzes (title, data, updated_at) VALUES (?, ?, ?)').run(title, '[]', now());
  return getQuiz(info.lastInsertRowid);
}

function updateQuiz(id, title, questions) {
  db.prepare('UPDATE quizzes SET title = ?, data = ?, updated_at = ? WHERE id = ?')
    .run(title, JSON.stringify(questions), now(), id);
  return getQuiz(id);
}

function deleteQuiz(id) {
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(id);
}

const saveGameTx = db.transaction((quizId, title, ranking, groupRanking) => {
  const info = db.prepare('INSERT INTO games (quiz_id, title, played_at, player_count) VALUES (?, ?, ?, ?)')
    .run(quizId, title, now(), ranking.length);
  const gameId = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO results (game_id, rank, name, score, correct_count, group_name, times_left, away_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ranking.forEach((p, i) => ins.run(gameId, i + 1, p.name, p.score, p.correctCount, p.group, p.leaves || 0, Math.round(p.awayMs || 0)));
  const insG = db.prepare('INSERT INTO group_results (game_id, rank, group_name, players, total_score, avg_score, left_players, away_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  groupRanking.forEach(g => insG.run(gameId, g.rank, g.name, g.players, g.total, g.avg, g.left || 0, Math.round(g.awayMs || 0)));
  return gameId;
});

function saveGame(quizId, title, ranking, groupRanking = []) {
  return saveGameTx(quizId, title, ranking, groupRanking);
}

function listGames() {
  return db.prepare('SELECT * FROM games ORDER BY id DESC LIMIT 50').all();
}

function getGame(id) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(id);
}

function getResults(gameId) {
  return db.prepare('SELECT rank, name, group_name, score, correct_count, times_left, away_ms FROM results WHERE game_id = ? ORDER BY rank').all(gameId);
}

function getGroupResults(gameId) {
  return db.prepare('SELECT rank, group_name, players, total_score, avg_score, left_players, away_ms FROM group_results WHERE game_id = ? ORDER BY rank').all(gameId);
}

const close = () => db.close();

module.exports = { close, listQuizzes, getQuiz, createQuiz, updateQuiz, deleteQuiz, saveGame, listGames, getGame, getResults, getGroupResults };
