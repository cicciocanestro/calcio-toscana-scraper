#!/usr/bin/env node
/**
 * CLI per dump e restore dello snapshot JSONL versionato in git.
 *
 * Utilizzo:
 *   node bin/db-snapshot.js dump [--file percorso.jsonl]
 *   node bin/db-snapshot.js restore [--file percorso.jsonl]
 *   node bin/db-snapshot.js status
 */
const fs = require('fs');
const path = require('path');
const { DB_PATH, DB_SNAPSHOT_PATH } = require('../src/config');
const { initDatabase } = require('../src/db');
const { dumpSnapshot, restoreSnapshot, SNAPSHOT_TABLES } = require('../src/db-snapshot');

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
    console.error(`Comando sconosciuto: ${command}. Usa: dump, restore, status.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
