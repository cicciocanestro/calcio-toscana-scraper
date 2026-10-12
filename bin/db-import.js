#!/usr/bin/env node
/**
 * Script di migrazione / importazione dei dati JSON della cache verso SQLite.
 *
 * Utilizzo:
 *   node bin/db-import.js
 *   node bin/db-import.js --db data/db/calcio.sqlite
 */
const fs = require('fs');
const path = require('path');
const { LEAGUES, DB_PATH, ROOT_DIR } = require('../src/config');
const { initDatabase } = require('../src/db');
const { importLeagueDocument } = require('../src/db-sync');

function main() {
  const args = process.argv.slice(2);
  let dbTarget = DB_PATH;
  const dbIndex = args.indexOf('--db');
  if (dbIndex !== -1 && args[dbIndex + 1]) {
    dbTarget = path.resolve(process.cwd(), args[dbIndex + 1]);
  }

  console.log(`[DB-IMPORT] Inizializzazione database SQLite su: ${dbTarget}`);
  const db = initDatabase(dbTarget);

  let totalImported = 0;
  for (const id of Object.keys(LEAGUES)) {
    const leagueCfg = LEAGUES[id];
    const cachePath = leagueCfg.cacheFile;

    if (!fs.existsSync(cachePath)) {
      console.warn(`[DB-IMPORT] File cache mancante per ${id} (${cachePath}), saltato.`);
      continue;
    }

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const data = JSON.parse(raw);
      importLeagueDocument(db, data);
      console.log(`✔ [DB-IMPORT] ${leagueCfg.name} importato con successo nel database.`);
      totalImported++;
    } catch (err) {
      console.error(`✖ [DB-IMPORT] Errore durante l'importazione di ${id}:`, err);
      process.exitCode = 1;
    }
  }

  // Statistiche finali
  const counts = {
    leagues: db.prepare('SELECT COUNT(*) AS c FROM leagues').get().c,
    teams: db.prepare('SELECT COUNT(*) AS c FROM teams').get().c,
    matches: db.prepare('SELECT COUNT(*) AS c FROM matches').get().c,
    goals: db.prepare('SELECT COUNT(*) AS c FROM goals').get().c
  };

  console.log('\n--- Riepilogo Database ---');
  console.log(`Campionati: ${counts.leagues}`);
  console.log(`Squadre:     ${counts.teams}`);
  console.log(`Partite:     ${counts.matches}`);
  console.log(`Marcatori:   ${counts.goals}`);

  const topScorers = db.prepare('SELECT player_name, team_name, total_goals FROM v_top_scorers LIMIT 5').all();
  if (topScorers.length > 0) {
    console.log('\nTop 5 Marcatori (prima vista analitica):');
    topScorers.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.player_name} (${s.team_name}) - ${s.total_goals} gol`);
    });
  }

  console.log('\n[DB-IMPORT] Operazione completata.');
}

if (require.main === module) {
  main();
}
