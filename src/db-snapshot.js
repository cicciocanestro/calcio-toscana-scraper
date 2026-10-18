const fs = require('fs');
const readline = require('readline');
const path = require('path');
const crypto = require('crypto');
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
 * Costruisce il corpo dello snapshot leggendo tutte le tabelle in ordine stabile.
 *
 * @param {DatabaseSync} db
 * @returns {{ body: string, totalRows: number }}
 */
function buildSnapshotBody(db) {
  const dataLines = [];
  let totalRows = 0;
  for (const table of SNAPSHOT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all();
    for (const row of rows) {
      dataLines.push(JSON.stringify({ table, data: row }));
      totalRows++;
    }
  }
  return { body: dataLines.join('\n'), totalRows };
}

/** Impronta del contenuto, usata per capire se DB e snapshot coincidono. */
function checksumOf(text) {
  return crypto.createHash('sha1').update(text, 'utf-8').digest('hex');
}

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

  const { body: currentBody, totalRows } = buildSnapshotBody(db);
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

  const headerLine = JSON.stringify({
    _type: 'header',
    version: 1,
    exported_at: headerExportedAt,
    rows: totalRows,
    checksum: checksumOf(currentBody)
  });
  const fullContent = `${headerLine}\n${currentBody}${currentBody.length > 0 ? '\n' : ''}`;

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, fullContent, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return totalRows;
}

/**
 * Legge il corpo dello snapshot da disco, senza header.
 *
 * @returns {string|null} contenuto del corpo, oppure null se il file non è
 *                        leggibile o non ha l'header previsto
 */
function readSnapshotBody(filePath = DB_SNAPSHOT_PATH) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstNewline = content.indexOf('\n');
    if (firstNewline === -1) return null;

    const header = JSON.parse(content.slice(0, firstNewline));
    if (!header || header._type !== 'header') return null;

    return content.slice(firstNewline + 1).replace(/\n$/, '');
  } catch (e) {
    return null;
  }
}

/**
 * Dice se lo snapshot su disco descrive esattamente il contenuto del database.
 *
 * Confronta il CORPO effettivamente presente su disco con quello ricostruito
 * dal DB: non si fida del checksum dichiarato nell'header, così un file
 * modificato a mano o frutto di un merge (corpo cambiato, header vecchio) non
 * risulta "identico" per errore.
 *
 * @returns {boolean|null} true/false, oppure null se il file non è leggibile
 */
function snapshotMatchesDatabase(db, filePath = DB_SNAPSHOT_PATH) {
  const fileBody = readSnapshotBody(filePath);
  if (fileBody === null) return null;

  try {
    const { body } = buildSnapshotBody(db);
    return checksumOf(body) === checksumOf(fileBody);
  } catch (e) {
    return null;
  }
}

/**
 * Colonne che registrano *quando* il dato è stato osservato: il valore più
 * recente dice se un database è più avanti di uno snapshot.
 */
const FRESHNESS_COLUMNS = {
  leagues: 'last_updated',
  standings_snapshots: 'captured_at',
  matches: 'score_updated_at'
};

/**
 * Timestamp più recente presente in un elenco di righe dello snapshot.
 *
 * Le date sono ISO 8601 in UTC, quindi il confronto lessicografico coincide
 * con quello cronologico.
 *
 * @param {Array<{table: string, data: object}>} entries
 * @returns {string|null}
 */
function latestTimestamp(entries) {
  let latest = null;

  for (const entry of entries) {
    const column = entry && entry.table ? FRESHNESS_COLUMNS[entry.table] : null;
    if (!column || !entry.data) continue;

    const value = entry.data[column];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (latest === null || value > latest) latest = value;
  }

  return latest;
}

/** Righe del corpo dello snapshot, già parsate. */
function parseSnapshotBody(body) {
  const entries = [];
  for (const line of String(body || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed._type !== 'header' && parsed.table) entries.push(parsed);
    } catch (e) {
      // Riga illeggibile: la ignoriamo, come fa il resto del modulo
    }
  }
  return entries;
}

/**
 * Confronta "quanto è avanti" il database rispetto allo snapshot, guardando i
 * timestamp dei dati (ultima classifica, ultimo punteggio, ultimo aggiornamento
 * del campionato).
 *
 * Questo è il criterio giusto per capire se un ripristino riporterebbe indietro
 * qualcosa: le date dei file non servono, perché aprire la connessione SQLite
 * riscrive comunque `-wal` e `-shm` e renderebbe il DB "più recente" a ogni
 * comando.
 *
 * @returns {{ dbLatest: string|null, snapshotLatest: string|null, dbAhead: boolean }}
 */
function compareFreshness(db, filePath = DB_SNAPSHOT_PATH) {
  const fileBody = readSnapshotBody(filePath);
  if (fileBody === null) {
    return { dbLatest: null, snapshotLatest: null, dbAhead: false };
  }

  const { body } = buildSnapshotBody(db);
  const dbLatest = latestTimestamp(parseSnapshotBody(body));
  const snapshotLatest = latestTimestamp(parseSnapshotBody(fileBody));

  const dbAhead = dbLatest !== null && (snapshotLatest === null || dbLatest > snapshotLatest);

  return { dbLatest, snapshotLatest, dbAhead };
}

/**
 * Chiavi "naturali" per tabella: identificano una riga in modo stabile fra
 * import diversi.
 *
 * Gli `id` AUTOINCREMENT non sono identità: ogni `db-import` che rigenera i
 * gol assegna id nuovi alle stesse righe logiche, e confrontarli farebbe
 * sembrare "più avanti" un DB che contiene solo gli stessi dati con id diversi.
 * Dove lo schema ha un vincolo UNIQUE usiamo quello; altrimenti l'id.
 */
const NATURAL_KEYS = {
  leagues: ['id'],
  seasons: ['league_id', 'label'],
  teams: ['slug'],
  team_aliases: ['alias'],
  matchdays: ['season_id', 'day_number'],
  matches: ['source_key'],
  goals: ['match_id', 'team_id', 'ordinal'],
  standings_snapshots: ['season_id', 'matchday_number', 'team_id']
};

/**
 * Chiave stabile di una riga, come stringa confrontabile fra DB e snapshot.
 * @returns {string|null} null se la riga non ha le colonne necessarie
 */
function naturalKeyOf(table, row) {
  const columns = NATURAL_KEYS[table];
  if (!columns || !row) return null;

  const parts = [];
  for (const column of columns) {
    const value = row[column];
    if (value === undefined || value === null) return null;
    parts.push(String(value));
  }
  return parts.join('|');
}

/**
 * Confronta le righe del database con quelle dello snapshot usando le chiavi
 * naturali.
 *
 * Serve a capire in che direzione va la divergenza prima di un `restore`:
 * `restoreSnapshot` svuota le tabelle, quindi ogni riga presente solo nel DB
 * andrebbe persa per sempre. `dbOnly` elenca proprio quelle righe.
 *
 * @returns {{ dbOnly: Object<string, string[]>, snapshotOnly: Object<string, string[]> }}
 */
function analyzeDivergence(db, filePath = DB_SNAPSHOT_PATH) {
  const dbOnly = {};
  const snapshotOnly = {};
  if (!fs.existsSync(filePath)) return { dbOnly, snapshotOnly };

  // Chiavi naturali dello snapshot, raggruppate per tabella
  const snapshotKeys = new Map(SNAPSHOT_TABLES.map(t => [t, new Set()]));
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (!parsed || parsed._type === 'header' || !parsed.table) continue;
    const keys = snapshotKeys.get(parsed.table);
    const key = keys ? naturalKeyOf(parsed.table, parsed.data) : null;
    if (keys && key) keys.add(key);
  }

  for (const table of SNAPSHOT_TABLES) {
    const keys = snapshotKeys.get(table);
    if (!keys) continue;

    let dbKeys = [];
    try {
      dbKeys = db.prepare(`SELECT * FROM ${table}`).all()
        .map(row => naturalKeyOf(table, row))
        .filter(key => key !== null);
    } catch (e) {
      continue;
    }

    const missingInSnapshot = dbKeys.filter(key => !keys.has(key));
    if (missingInSnapshot.length > 0) dbOnly[table] = missingInSnapshot;

    const dbKeySet = new Set(dbKeys);
    const missingInDb = [...keys].filter(key => !dbKeySet.has(key));
    if (missingInDb.length > 0) snapshotOnly[table] = missingInDb;
  }

  return { dbOnly, snapshotOnly };
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
  NATURAL_KEYS,
  naturalKeyOf,
  buildSnapshotBody,
  dumpSnapshot,
  snapshotMatchesDatabase,
  readSnapshotBody,
  compareFreshness,
  latestTimestamp,
  analyzeDivergence,
  restoreSnapshot
};
