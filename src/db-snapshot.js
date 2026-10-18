const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { DB_SNAPSHOT_PATH } = require('./config');

const SNAPSHOT_TABLES = [
  'leagues',
  'seasons',
  'teams',
  'team_aliases',
  'matchdays',
  'matches',
  'goals',
  'standings_snapshots'
];

/**
 * Esporta tutte le tabelle del database in un file JSON Lines ordinato e stabile.
 * Ogni riga ha la forma: { table: "nome_tabella", data: { ... } }
 *
 * @param {DatabaseSync} db - Istanza SQLite aperta
 * @param {string} [filePath] - Percorso del file snapshot JSONL (default: DB_SNAPSHOT_PATH)
 * @returns {number} Numero totale di record esportati
 */
function dumpSnapshot(db, filePath = DB_SNAPSHOT_PATH) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const dataLines = [];
  let totalRows = 0;
  for (const table of SNAPSHOT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all();
    for (const row of rows) {
      dataLines.push(JSON.stringify({ table, data: row }));
      totalRows++;
    }
  }

  const currentBody = dataLines.join('\n');
  let headerExportedAt = new Date().toISOString();

  if (fs.existsSync(filePath)) {
    try {
      const existingContent = fs.readFileSync(filePath, 'utf-8');
      const firstNewline = existingContent.indexOf('\n');
      if (firstNewline !== -1) {
        const firstLine = existingContent.slice(0, firstNewline);
        const existingBody = existingContent.slice(firstNewline + 1).replace(/\n$/, '');
        // Se il corpo dei dati (tabelle e righe) è identico al byte a quello già salvato,
        // preserviamo il vecchio exported_at dell'header per evitare diff fittizi in Git.
        if (existingBody === currentBody) {
          const parsed = JSON.parse(firstLine);
          if (parsed && parsed._type === 'header' && parsed.exported_at) {
            headerExportedAt = parsed.exported_at;
          }
        }
      }
    } catch (e) {}
  }

  const headerLine = JSON.stringify({ _type: 'header', version: 1, exported_at: headerExportedAt });
  const fullContent = `${headerLine}\n${currentBody}${currentBody.length > 0 ? '\n' : ''}`;

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, fullContent, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return totalRows;
}

/**
 * Ripristina il database SQLite partendo da un file snapshot JSONL.
 *
 * @param {DatabaseSync} db - Istanza SQLite aperta e inizializzata con schema DDL
 * @param {string} [filePath] - Percorso del file snapshot JSONL
 * @returns {number} Numero di record ripristinati
 */
function restoreSnapshot(db, filePath = DB_SNAPSHOT_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File snapshot non trovato: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(line => line.trim().length > 0);

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN TRANSACTION;');

  let restoredRows = 0;
  try {
    // Svuota le tabelle prima del restore e riallinea sqlite_sequence
    for (const table of [...SNAPSHOT_TABLES].reverse()) {
      db.prepare(`DELETE FROM ${table}`).run();
      try {
        db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
      } catch (e) {}
    }

    const stmtCache = new Map();

    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed._type === 'header') continue;

      const { table, data } = parsed;
      if (!SNAPSHOT_TABLES.includes(table)) continue;

      const keys = Object.keys(data);
      if (keys.length === 0) continue;

      let stmt = stmtCache.get(table);
      if (!stmt) {
        const placeholders = keys.map(() => '?').join(', ');
        const cols = keys.map(k => `"${k}"`).join(', ');
        stmt = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`);
        stmtCache.set(table, stmt);
      }

      const values = keys.map(k => data[k]);
      stmt.run(...values);
      restoredRows++;
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }

  return restoredRows;
}

module.exports = {
  SNAPSHOT_TABLES,
  dumpSnapshot,
  restoreSnapshot
};
