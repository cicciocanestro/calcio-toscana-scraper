#!/usr/bin/env node
/**
 * CLI per dump e restore dello snapshot JSONL versionato in git.
 *
 * Utilizzo:
 *   node bin/db-snapshot.js dump [--file percorso.jsonl]
 *   node bin/db-snapshot.js restore [--file percorso.jsonl]
 *   node bin/db-snapshot.js sync [--file percorso.jsonl] [--force]
 *   node bin/db-snapshot.js status
 */
const fs = require('fs');
const path = require('path');
const { DB_PATH, DB_SNAPSHOT_PATH } = require('../src/config');
const { initDatabase } = require('../src/db');
const {
  dumpSnapshot,
  restoreSnapshot,
  snapshotMatchesDatabase,
  analyzeDivergence,
  SNAPSHOT_TABLES
} = require('../src/db-snapshot');

/**
 * Ultima scrittura del database, considerando anche i file WAL/SHM: con
 * `journal_mode=WAL` le modifiche passano da `calcio.sqlite-wal`, quindi il
 * solo mtime del file principale non basta a dire se il DB è aggiornato.
 */
function lastDatabaseWrite(dbPath) {
  let latest = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) latest = Math.max(latest, fs.statSync(file).mtimeMs);
  }
  return latest;
}

/**
 * Copia di sicurezza del database prima di una scrittura distruttiva.
 * Usa `VACUUM INTO`, che produce un file consistente anche con WAL attivo;
 * se non è disponibile ricade su una copia dei file.
 *
 * Il primo backup occupa `calcio.sqlite.bak`; se esiste già, il nuovo prende un
 * nome con timestamp. Così un ripristino successivo non sovrascrive l'unica
 * copia di sicurezza disponibile.
 *
 * @returns {string} percorso del backup
 */
function backupDatabase(db, dbPath) {
  const basePath = `${dbPath}.bak`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = fs.existsSync(basePath) ? `${dbPath}.${stamp}.bak` : basePath;

  try {
    const escaped = backupPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    return backupPath;
  } catch (e) {
    fs.copyFileSync(dbPath, backupPath);
    return backupPath;
  }
}

/** Elenca in modo compatto le tabelle con righe esclusive, es. "goals (12), matches (3)". */
function summarizeExclusiveRows(dbOnly) {
  return Object.entries(dbOnly)
    .map(([table, ids]) => `${table} (${ids.length})`)
    .join(', ');
}

/**
 * Allinea il database locale allo snapshot versionato, ma solo se serve e solo
 * se non si perde nulla.
 *
 * Ordine dei controlli:
 *  1. lo snapshot deve esistere;
 *  2. se il database manca viene ricreato (non c'è nulla da perdere);
 *  3. se il checksum coincide non si fa nulla;
 *  4. se il database contiene righe che lo snapshot non ha, il DB è più avanti:
 *     il ripristino le cancellerebbe, quindi si salta (serve `--force`);
 *  5. se il file del DB è stato scritto dopo lo snapshot, le differenze sono
 *     valori locali più recenti: si salta (serve `--force`);
 *  6. altrimenti il DB è indietro: backup e ripristino.
 *
 * @param {string} [snapshotFile] - percorso dello snapshot JSONL
 * @param {object} [options]
 * @param {string} [options.dbPath] - percorso del database SQLite
 * @param {boolean} [options.force] - ripristina anche se il DB ha righe esclusive
 * @returns {{ restored: boolean, skipped?: boolean, count?: number, reason: string,
 *             backup?: string, dbOnly?: object }}
 */
function syncDatabase(snapshotFile = DB_SNAPSHOT_PATH, options = {}) {
  const dbPath = options.dbPath || DB_PATH;
  const force = !!options.force;

  if (!fs.existsSync(snapshotFile)) {
    return { restored: false, reason: 'snapshot assente' };
  }

  if (!fs.existsSync(dbPath)) {
    // `initDatabase` ripristina già automaticamente un DB nuovo o vuoto
    initDatabase(dbPath);
    return { restored: true, reason: 'database assente' };
  }

  const db = initDatabase(dbPath);
  const sameContent = snapshotMatchesDatabase(db, snapshotFile);

  if (sameContent === true) {
    return { restored: false, reason: 'contenuto identico' };
  }

  // Snapshot senza checksum (formato precedente): si torna al confronto fra date,
  // considerando anche WAL/SHM perché con WAL le scritture finiscono lì.
  if (sameContent === null && fs.statSync(snapshotFile).mtimeMs <= lastDatabaseWrite(dbPath)) {
    return { restored: false, reason: 'già allineato' };
  }

  // Prima di distruggere dati: il DB ha righe che lo snapshot non contiene?
  const divergence = analyzeDivergence(db, snapshotFile);
  const exclusiveRows = Object.keys(divergence.dbOnly).length;

  if (exclusiveRows > 0) {
    if (!force) {
      // Nessuna scrittura: il backup serve solo se si distrugge qualcosa.
      return {
        restored: false,
        skipped: true,
        reason: `database più avanti dello snapshot (${summarizeExclusiveRows(divergence.dbOnly)})`,
        dbOnly: divergence.dbOnly
      };
    }
    const backup = backupDatabase(db, dbPath);
    const count = restoreSnapshot(db, snapshotFile);
    return {
      restored: true,
      count,
      reason: `contenuto diverso, ${exclusiveRows} tabelle con righe locali scartate (--force)`,
      backup
    };
  }

  // Nessuna riga esclusiva: le differenze sono solo di valori. Se il file del
  // database è stato scritto DOPO lo snapshot, quei valori sono più recenti di
  // quelli versionati (es. refresh dalla dashboard, db-import senza dump) e il
  // ripristino li riporterebbe indietro.
  if (!force && lastDatabaseWrite(dbPath) > fs.statSync(snapshotFile).mtimeMs) {
    return {
      restored: false,
      skipped: true,
      reason: 'valori locali più recenti dello snapshot'
    };
  }

  // Il DB è indietro: il ripristino non perde nulla.
  const backup = backupDatabase(db, dbPath);
  const count = restoreSnapshot(db, snapshotFile);
  return { restored: true, count, reason: 'contenuto diverso (DB indietro rispetto allo snapshot)', backup };
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  let snapshotFile = DB_SNAPSHOT_PATH;
  const fileIndex = args.indexOf('--file');
  if (fileIndex !== -1 && args[fileIndex + 1]) {
    snapshotFile = path.resolve(process.cwd(), args[fileIndex + 1]);
  }

  if (command === 'dump') {
    if (!fs.existsSync(DB_PATH)) {
      console.error(`✖ Database SQLite non trovato in: ${DB_PATH}. Esegui prima bin/db-import.js.`);
      process.exitCode = 1;
      return;
    }
    const db = initDatabase(DB_PATH);
    const count = dumpSnapshot(db, snapshotFile);
    console.log(`✔ [DUMP] Esportati ${count} record su: ${snapshotFile}`);
  } else if (command === 'restore') {
    if (!fs.existsSync(snapshotFile)) {
      console.error(`✖ File snapshot non trovato in: ${snapshotFile}`);
      process.exitCode = 1;
      return;
    }
    const db = initDatabase(DB_PATH);
    const count = restoreSnapshot(db, snapshotFile);
    console.log(`✔ [RESTORE] Ripristinati ${count} record da: ${snapshotFile}`);
  } else if (command === 'sync') {
    const result = syncDatabase(snapshotFile, { force: args.includes('--force') });

    if (result.restored) {
      const detail = result.count ? ` (${result.count} record)` : '';
      console.log(`✔ [SYNC] Database allineato allo snapshot${detail} — ${result.reason}.`);
      if (result.backup) console.log(`  Copia di sicurezza: ${result.backup}`);
    } else if (result.skipped) {
      console.warn(`⚠ [SYNC] Ripristino annullato: ${result.reason}.`);
      console.warn('  Il database contiene dati che lo snapshot non ha (es. refresh dalla dashboard');
      console.warn('  o db-import senza dump). Ripristinare li cancellerebbe.');
      console.warn('  Scelte possibili:');
      console.warn('   • esporta prima quello che c\'è:  npm run db:dump');
      console.warn('   • oppure forza (backup automatico): npm run db:sync -- --force');
      if (result.backup) console.warn(`  Copia del DB salvata in: ${result.backup}`);
    } else {
      console.log(`✔ [SYNC] Nessun ripristino necessario (${result.reason}).`);
    }
  } else if (command === 'status') {
    console.log('--- Stato Database & Snapshot ---');
    console.log(`DB File:        ${DB_PATH} (${fs.existsSync(DB_PATH) ? 'PRESENTE' : 'NON PRESENTE'})`);
    console.log(`Snapshot JSONL: ${snapshotFile} (${fs.existsSync(snapshotFile) ? 'PRESENTE' : 'NON PRESENTE'})`);

    if (fs.existsSync(DB_PATH)) {
      const db = initDatabase(DB_PATH);
      console.log('\nConteggio record su SQLite:');
      for (const t of SNAPSHOT_TABLES) {
        try {
          const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
          console.log(`  - ${t}: ${c}`);
        } catch (e) {
          console.log(`  - ${t}: non disponibile`);
        }
      }
    }
  } else {
    console.error(`Comando sconosciuto: ${command}. Usa: dump, restore, sync, status.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { syncDatabase, backupDatabase };
