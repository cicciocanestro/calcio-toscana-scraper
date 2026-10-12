const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { DB_PATH, DB_DIR, DB_SNAPSHOT_PATH } = require('./config');

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- Anagrafica campionati
CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  category TEXT NOT NULL,
  girone TEXT NOT NULL,
  region TEXT NOT NULL,
  province TEXT DEFAULT '',
  url TEXT NOT NULL,
  round_id TEXT NOT NULL,
  current_match_day INTEGER DEFAULT 1,
  total_match_days INTEGER DEFAULT 30,
  last_updated TEXT
);

-- Stagioni sportive (es. 2026/27)
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  is_current INTEGER DEFAULT 1,
  UNIQUE(league_id, label)
);

-- Squadre
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  logo_url TEXT,
  comune TEXT
);

-- Alias squadra (nomi alternativi o variazioni)
CREATE TABLE IF NOT EXISTS team_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  alias TEXT UNIQUE NOT NULL,
  source TEXT DEFAULT 'tuttocampo'
);

-- Giornate del campionato
CREATE TABLE IF NOT EXISTS matchdays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL,
  day_title TEXT NOT NULL,
  day_date TEXT,
  UNIQUE(season_id, day_number)
);

-- Partite
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  matchday_number INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  home_score INTEGER,
  away_score INTEGER,
  is_played INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  date TEXT,
  time TEXT,
  date_time TEXT,
  match_link TEXT NOT NULL,
  source_key TEXT UNIQUE NOT NULL,
  score_updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_matches_season_day ON matches(season_id, matchday_number);
CREATE INDEX IF NOT EXISTS idx_matches_home_team ON matches(home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away_team ON matches(away_team_id);

-- Marcatori ed eventi gol
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_raw TEXT NOT NULL,
  player_name TEXT NOT NULL,
  minute TEXT,
  half TEXT,
  is_penalty INTEGER DEFAULT 0,
  is_own_goal INTEGER DEFAULT 0,
  ordinal INTEGER DEFAULT 1,
  UNIQUE(match_id, team_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_goals_player ON goals(player_name);
CREATE INDEX IF NOT EXISTS idx_goals_team ON goals(team_id);

-- Snapshot classifica
CREATE TABLE IF NOT EXISTS standings_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  matchday_number INTEGER NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  position INTEGER NOT NULL,
  points INTEGER NOT NULL,
  played INTEGER NOT NULL,
  won INTEGER NOT NULL,
  drawn INTEGER NOT NULL,
  lost INTEGER NOT NULL,
  goals_for INTEGER NOT NULL,
  goals_against INTEGER NOT NULL,
  goal_diff INTEGER NOT NULL,
  zone TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE(season_id, matchday_number, team_id)
);

CREATE INDEX IF NOT EXISTS idx_standings_season_day ON standings_snapshots(season_id, matchday_number);

-- Vista classifica marcatori aggregata
CREATE VIEW IF NOT EXISTS v_top_scorers AS
SELECT
  g.player_name,
  t.name AS team_name,
  m.season_id,
  l.id AS league_id,
  l.name AS league_name,
  COUNT(g.id) AS total_goals,
  SUM(g.is_penalty) AS penalties
FROM goals g
JOIN matches m ON g.match_id = m.id
JOIN seasons s ON m.season_id = s.id
JOIN leagues l ON s.league_id = l.id
JOIN teams t ON g.team_id = t.id
WHERE g.is_own_goal = 0
GROUP BY g.player_name, t.id, m.season_id
ORDER BY total_goals DESC;
`;

/**
 * Inizializza il database SQLite con lo schema DDL.
 * Se il file di database non esiste su disco ma è presente lo snapshot JSONL,
 * effettua automaticamente il ripristino veloce (ideale per Render/CI effimeri).
 *
 * @param {string} [dbPath] - Percorso del file database (default: DB_PATH)
 * @param {object} [options]
 * @param {boolean} [options.autoRestore=true] - Ripristina automaticamente da snapshot se il db è nuovo
 * @returns {DatabaseSync} Istanza del database aperta
 */
function initDatabase(dbPath = DB_PATH, options = {}) {
  const isMemory = dbPath === ':memory:';
  const autoRestore = options.autoRestore !== false;

  let isNew = false;
  if (!isMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    isNew = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  if (isNew && autoRestore && !isMemory && fs.existsSync(DB_SNAPSHOT_PATH)) {
    try {
      // Lazy load per evitare dipendenze circolari
      const { restoreSnapshot } = require('./db-snapshot');
      restoreSnapshot(db, DB_SNAPSHOT_PATH);
    } catch (err) {
      console.warn('[DB] Avviso durante auto-restore da snapshot:', err.message);
    }
  }

  return db;
}

module.exports = {
  SCHEMA_SQL,
  initDatabase
};
