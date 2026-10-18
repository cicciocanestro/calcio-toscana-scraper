#!/usr/bin/env node
/**
 * CLI per dump e restore dello snapshot JSONL versionato in git.
 *
 * Utilizzo:
 *   node bin/db-snapshot.js dump [--file percorso.jsonl]
 *   node bin/db-snapshot.js restore [--file percorso.jsonl]
 *   node bin/db-snapshot.js sync [--file percorso.jsonl]
 *   node bin/db-snapshot.js status
 */
const fs = require('fs');
const path = require('path');
const { DB_PATH, DB_SNAPSHOT_PATH } = require('../src/config');
const { initDatabase } = require('../src/db');
const { dumpSnapshot, restoreSnapshot, snapshotMatchesDatabase, SNAPSHOT_TABLES } = require('../src/db-snapshot');

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
 * Allinea il database locale allo snapshot versionato, ma solo se serve.
 *
 * Il criterio è il contenuto: se il checksum nell'header dello snapshot
 * descrive già lo stato del database non si tocca nulla. Il confronto fra
 * date di modifica resta come fallback per gli snapshot vecchi, privi di
 * checksum (file generati da versioni precedenti di questo script).
 *
 * @param {string} [snapshotFile] - percorso dello snapshot JSONL
 * @param {string} [dbPath]       - percorso del database SQLite
 * @returns {{ restored: boolean, count?: number, reason?: string }}
 */
function syncDatabase(snapshotFile = DB_SNAPSHOT_PATH, dbPath = DB_PATH) {
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

  const count = restoreSnapshot(db, snapshotFile);
  return { restored: true, count, reason: 'snapshot più recente' };
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
    const result = syncDatabase(snapshotFile);
    if (result.restored) {
      const detail = result.count ? ` (${result.count} record)` : '';
      console.log(`✔ [SYNC] Database allineato allo snapshot${detail} — ${result.reason}.`);
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

module.exports = { syncDatabase };
