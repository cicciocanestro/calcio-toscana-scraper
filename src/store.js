const fs = require('fs');
const path = require('path');
const { LEAGUES, CACHE_TTL_MS, EXPORT_DIR, DB_PATH } = require('./config');
const { exportToJson, exportToCsv, exportToIcs } = require('./exporters');
const { initDatabase } = require('./db');
const { importLeagueDocument, reconstructLeagueDocument } = require('./db-sync');

/**
 * Interfaccia base per il layer di memorizzazione / cache dei dati di campionato.
 */
class BaseStore {
  getLeague(leagueId, maxAgeMs = CACHE_TTL_MS) {
    throw new Error('Not implemented');
  }

  getCacheStatus(leagueId, maxAgeMs = CACHE_TTL_MS) {
    throw new Error('Not implemented');
  }

  saveLeague(leagueConfig, leagueData) {
    throw new Error('Not implemented');
  }
}

/**
 * Implementazione basata su file JSON (compatibile al 100% con la struttura originaria).
 */
class JsonStore extends BaseStore {
  constructor(options = {}) {
    super();
    this.leagues = options.leagues || LEAGUES;
    this.exportDir = options.exportDir || EXPORT_DIR;
  }

  cacheAgeMs(leagueId, data) {
    const stamp = data ? Date.parse(data.lastUpdated || '') : NaN;
    if (Number.isFinite(stamp)) return Math.max(0, Date.now() - stamp);

    const league = this.leagues[leagueId];
    if (!league || !league.cacheFile || !fs.existsSync(league.cacheFile)) return Infinity;
    return Date.now() - fs.statSync(league.cacheFile).mtimeMs;
  }

  getLeague(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const league = this.leagues[leagueId];
    if (!league || !league.cacheFile || !fs.existsSync(league.cacheFile)) return null;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(league.cacheFile, 'utf-8'));
    } catch (err) {
      return null;
    }

    if (maxAgeMs !== null && maxAgeMs !== undefined && this.cacheAgeMs(leagueId, data) > maxAgeMs) {
      return null;
    }

    return data;
  }

  getCacheStatus(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const league = this.leagues[leagueId];
    const empty = { exists: false, isStale: false, ageMs: null, lastUpdated: null };
    if (!league || !league.cacheFile || !fs.existsSync(league.cacheFile)) return empty;

    try {
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(league.cacheFile, 'utf-8'));
      } catch (err) {
        // Cache non leggibile, usa mtime
      }

      const ageMs = this.cacheAgeMs(leagueId, data);
      const stamp = data ? Date.parse(data.lastUpdated || '') : NaN;

      return {
        exists: true,
        isStale: ageMs > maxAgeMs,
        ageMs,
        lastUpdated: Number.isFinite(stamp)
          ? new Date(stamp).toISOString()
          : fs.statSync(league.cacheFile).mtime.toISOString()
      };
    } catch (err) {
      return empty;
    }
  }

  saveLeague(leagueConfig, leagueData) {
    if (leagueConfig.cacheFile) {
      exportToJson(leagueData, leagueConfig.cacheFile);
    }
    if (this.exportDir) {
      exportToCsv(leagueData, path.join(this.exportDir, `${leagueConfig.id}.csv`));
      exportToIcs(leagueData, path.join(this.exportDir, `${leagueConfig.id}.ics`));
      exportToJson(leagueData, path.join(this.exportDir, `${leagueConfig.id}.json`));
    }
    return leagueData;
  }
}

/**
 * Implementazione basata su SQLite:
 * memorizza i dati relazionali (partite, squadre, marcatori, snapshot) e
 * rigenera all'occorrenza i file JSON/CSV/ICS di output per preservare la totale compatibilità.
 */
class SqliteStore extends BaseStore {
  constructor(options = {}) {
    super();
    this.leagues = options.leagues || LEAGUES;
    this.exportDir = options.exportDir || EXPORT_DIR;
    this.dbPath = options.dbPath || DB_PATH;
    this.syncExports = options.syncExports !== false; // scrive anche i file statici di export/cache
    this._db = options.db || null;
  }

  get db() {
    if (!this._db) {
      this._db = initDatabase(this.dbPath);
    }
    return this._db;
  }

  cacheAgeMs(leagueId, data) {
    const stamp = data ? Date.parse(data.lastUpdated || '') : NaN;
    if (Number.isFinite(stamp)) return Math.max(0, Date.now() - stamp);

    try {
      const row = this.db.prepare('SELECT last_updated FROM leagues WHERE id = ?').get(leagueId);
      const dbStamp = row && row.last_updated ? Date.parse(row.last_updated) : NaN;
      if (Number.isFinite(dbStamp)) return Math.max(0, Date.now() - dbStamp);
    } catch (e) {}

    return Infinity;
  }

  getLeague(leagueId, maxAgeMs = CACHE_TTL_MS) {
    try {
      const doc = reconstructLeagueDocument(this.db, leagueId);
      if (!doc) return null;

      if (maxAgeMs !== null && maxAgeMs !== undefined && this.cacheAgeMs(leagueId, doc) > maxAgeMs) {
        return null;
      }
      return doc;
    } catch (err) {
      return null;
    }
  }

  getCacheStatus(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const empty = { exists: false, isStale: false, ageMs: null, lastUpdated: null };
    try {
      const row = this.db.prepare('SELECT last_updated FROM leagues WHERE id = ?').get(leagueId);
      if (!row || !row.last_updated) {
        return empty;
      }

      const stamp = Date.parse(row.last_updated);
      const ageMs = Number.isFinite(stamp) ? Math.max(0, Date.now() - stamp) : Infinity;

      return {
        exists: true,
        isStale: ageMs > maxAgeMs,
        ageMs,
        lastUpdated: Number.isFinite(stamp) ? new Date(stamp).toISOString() : row.last_updated
      };
    } catch (err) {
      return empty;
    }
  }

  saveLeague(leagueConfig, leagueData) {
    // 1. Inserimento transazionale su SQLite
    importLeagueDocument(this.db, leagueData);

    // 2. Sincronizzazione file cache ed export su disco per GitHub Pages e download client
    if (this.syncExports) {
      if (leagueConfig.cacheFile) {
        exportToJson(leagueData, leagueConfig.cacheFile);
      }
      if (this.exportDir) {
        exportToCsv(leagueData, path.join(this.exportDir, `${leagueConfig.id}.csv`));
        exportToIcs(leagueData, path.join(this.exportDir, `${leagueConfig.id}.ics`));
        exportToJson(leagueData, path.join(this.exportDir, `${leagueConfig.id}.json`));
      }
    }

    return leagueData;
  }
}

/**
 * Crea o restituisce lo store appropriato in base all'ambiente o all'opzione richiesta.
 * @param {string} [type] - 'sqlite' o 'json' (default: variabile STORE_TYPE o 'json')
 */
function createStore(type = process.env.STORE_TYPE || 'json', options = {}) {
  if (type === 'sqlite') {
    return new SqliteStore(options);
  }
  return new JsonStore(options);
}

// Istanza predefinita (configurabile da env STORE_TYPE)
const defaultStore = createStore();

module.exports = {
  BaseStore,
  JsonStore,
  SqliteStore,
  createStore,
  defaultStore
};
