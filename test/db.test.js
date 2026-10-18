const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LEAGUES, DB_PATH } = require('../src/config');
const { initDatabase } = require('../src/db');
const { importLeagueDocument, reconstructLeagueDocument, parseScorer } = require('../src/db-sync');
const { sportsFingerprint } = require('../bin/data-changed');
const { SqliteStore, createStore } = require('../src/store');
const {
  dumpSnapshot,
  restoreSnapshot,
  analyzeDivergence,
  snapshotMatchesDatabase,
  compareFreshness
} = require('../src/db-snapshot');
const { syncDatabase, lastDatabaseWrite } = require('../bin/db-snapshot');
const { sampleLeagueData } = require('./fixtures');

test('SQLite database contiene le tabelle e i vincoli corretti', () => {
  const db = initDatabase(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert.ok(tables.includes('leagues'));
  assert.ok(tables.includes('seasons'));
  assert.ok(tables.includes('teams'));
  assert.ok(tables.includes('matches'));
  assert.ok(tables.includes('goals'));
  assert.ok(tables.includes('standings_snapshots'));

  const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map(v => v.name);
  assert.ok(views.includes('v_top_scorers'));
});

test('Parità sportiva al 100%: il documento ricostruito dal DB matcha perfettamente il JSON su disco', () => {
  const db = initDatabase(DB_PATH);

  for (const id of Object.keys(LEAGUES)) {
    const originalFile = LEAGUES[id].cacheFile;
    assert.ok(fs.existsSync(originalFile), `file cache ${originalFile} deve esistere`);

    const originalJson = JSON.parse(fs.readFileSync(originalFile, 'utf-8'));
    const reconstructed = reconstructLeagueDocument(db, id);

    assert.ok(reconstructed, `documento per ${id} deve essere ricostruito`);
    assert.equal(reconstructed.id, originalJson.id);
    assert.equal(reconstructed.name, originalJson.name);
    assert.equal(reconstructed.currentMatchDay, originalJson.currentMatchDay);
    assert.equal(reconstructed.standings.length, originalJson.standings.length);
    assert.equal(reconstructed.matchDays.length, originalJson.matchDays.length);

    // Confronto sportsFingerprint: le classifiche e tutte le partite devono essere identiche
    const originalFp = sportsFingerprint(originalJson);
    const reconstructedFp = sportsFingerprint(reconstructed);

    assert.equal(reconstructedFp, originalFp, `l'impronta sportiva per ${id} deve essere identica al 100%`);
  }
});

test('La vista v_top_scorers aggrega correttamente i marcatori dai match', () => {
  const db = initDatabase(DB_PATH);
  const scorers = db.prepare('SELECT player_name, team_name, total_goals FROM v_top_scorers ORDER BY total_goals DESC LIMIT 10').all();
  assert.ok(scorers.length > 0);
  assert.ok(scorers[0].total_goals >= scorers[1].total_goals);
});

test('SqliteStore salva su database e rilegge il documento identico', () => {
  const memoryDb = initDatabase(':memory:');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-store-test-'));

  try {
    const store = new SqliteStore({
      db: memoryDb,
      exportDir: tempDir,
      syncExports: true
    });

    const sample = JSON.parse(fs.readFileSync(LEAGUES['promozione-c'].cacheFile, 'utf-8'));
    sample.lastUpdated = new Date().toISOString();
    const leagueCfg = {
      ...LEAGUES['promozione-c'],
      cacheFile: path.join(tempDir, 'promozione-c.json')
    };

    // Salva tramite lo store
    store.saveLeague(leagueCfg, sample);

    // Verifica persistenza su SQLite
    const status = store.getCacheStatus('promozione-c');
    assert.equal(status.exists, true);
    assert.equal(status.isStale, false);
    assert.ok(status.lastUpdated);

    // Rilettura e confronto parità
    const loaded = store.getLeague('promozione-c');
    assert.ok(loaded);
    assert.equal(sportsFingerprint(loaded), sportsFingerprint(sample));

    // File esportati su disco sincronizzati (CSV e ICS)
    assert.ok(fs.existsSync(path.join(tempDir, 'promozione-c.csv')));
    assert.ok(fs.existsSync(path.join(tempDir, 'promozione-c.ics')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('createStore istanzia lo store corretto per tipologia', () => {
  const jsonStore = createStore('json');
  assert.equal(jsonStore.constructor.name, 'JsonStore');

  const sqliteStore = createStore('sqlite');
  assert.equal(sqliteStore.constructor.name, 'SqliteStore');
});

test('dumpSnapshot e restoreSnapshot preservano fedelmente i dati', () => {
  const sourceDb = initDatabase(DB_PATH);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-snapshot-test-'));
  const snapFile = path.join(tempDir, 'test-snapshot.jsonl');

  try {
    // 1. Dump da database sorgente
    const countDump = dumpSnapshot(sourceDb, snapFile);
    assert.ok(countDump > 0);
    assert.ok(fs.existsSync(snapFile));

    // 2. Restore su un database SQLite nuovo
    const newDb = initDatabase(':memory:');
    const countRestored = restoreSnapshot(newDb, snapFile);
    assert.equal(countRestored, countDump);

    // 3. Verifica corrispondenza parità per tutti i campionati
    for (const id of Object.keys(LEAGUES)) {
      const docOriginal = reconstructLeagueDocument(sourceDb, id);
      const docRestored = reconstructLeagueDocument(newDb, id);
      assert.equal(sportsFingerprint(docRestored), sportsFingerprint(docOriginal));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('importLeagueDocument preserva i marcatori in caso di regressione e non gonfia gli ID dei gol', () => {
  const db = initDatabase(':memory:');
  const initial = sampleLeagueData();

  importLeagueDocument(db, initial);
  const firstIds = db.prepare('SELECT id, player_raw FROM goals ORDER BY id ASC').all();
  assert.equal(firstIds.length, 1);

  // Re-import identico: gli ID dei gol non devono aumentare
  importLeagueDocument(db, initial);
  const secondIds = db.prepare('SELECT id, player_raw FROM goals ORDER BY id ASC').all();
  assert.deepEqual(secondIds, firstIds, 'nessun nuovo ID AUTOINCREMENT se i marcatori sono invariati');

  // Regressione: la partita giocata arriva come non giocata e senza marcatori
  const regressed = sampleLeagueData();
  regressed.matchDays[0].matches[0].isPlayed = false;
  regressed.matchDays[0].matches[0].status = 'SCHEDULED';
  regressed.matchDays[0].matches[0].homeScore = null;
  regressed.matchDays[0].matches[0].awayScore = null;
  regressed.matchDays[0].matches[0].homeScorers = [];

  importLeagueDocument(db, regressed);
  const reconstructed = reconstructLeagueDocument(db, 'promozione-c');
  assert.equal(reconstructed.matchDays[0].matches[0].isPlayed, true);
  assert.deepEqual(reconstructed.matchDays[0].matches[0].homeScorers, ["M. Rossi (12' pt)"]);
});

test('importLeagueDocument aggiorna score_updated_at solo se il punteggio cambia', () => {
  const db = initDatabase(':memory:');
  const initial = sampleLeagueData();
  initial.lastUpdated = '2026-10-18T10:00:00.000Z';

  importLeagueDocument(db, initial);
  const row1 = db.prepare('SELECT score_updated_at FROM matches LIMIT 1').get();
  assert.equal(row1.score_updated_at, '2026-10-18T10:00:00.000Z');

  // Secondo import con stesso punteggio ma lastUpdated successivo
  const unchanged = sampleLeagueData();
  unchanged.lastUpdated = '2026-10-18T12:00:00.000Z';
  importLeagueDocument(db, unchanged);

  const row2 = db.prepare('SELECT score_updated_at FROM matches LIMIT 1').get();
  assert.equal(row2.score_updated_at, '2026-10-18T10:00:00.000Z', 'score_updated_at non deve cambiare se il punteggio è identico');

  // Terzo import con punteggio cambiato (era 2-1 in sampleLeagueData, lo cambiamo in 3-1)
  const changed = sampleLeagueData();
  changed.lastUpdated = '2026-10-18T14:00:00.000Z';
  changed.matchDays[0].matches[0].homeScore = 3;
  importLeagueDocument(db, changed);

  const row3 = db.prepare('SELECT score_updated_at FROM matches LIMIT 1').get();
  assert.equal(row3.score_updated_at, '2026-10-18T14:00:00.000Z', 'score_updated_at deve aggiornarsi quando il punteggio cambia');
});

test('getSeasonFromLeagueData ricava la stagione dalla prima data valida di partita anche d estate', () => {
  const { getSeasonFromLeagueData } = require('../src/config');
  // Simuliamo uno scrape del 15 luglio 2027 che contiene ancora le partite di settembre 2026
  const data = sampleLeagueData();
  data.lastUpdated = '2027-07-15T12:00:00.000Z';
  data.matchDays[0].matches[0].date = '2026-09-13';

  const season = getSeasonFromLeagueData(data);
  assert.equal(season, '2026/27', 'deve ancorare la stagione alla data delle partite (2026/27) e non alla data estiva');
});

test('importLeagueDocument non aggiorna captured_at se la classifica è identica', () => {
  const db = initDatabase(':memory:');
  const initial = sampleLeagueData();
  initial.lastUpdated = '2026-10-18T10:00:00.000Z';

  importLeagueDocument(db, initial);
  const row1 = db.prepare('SELECT captured_at FROM standings_snapshots LIMIT 1').get();
  assert.equal(row1.captured_at, '2026-10-18T10:00:00.000Z');

  // Re-import a parità di punti/partite
  const unchanged = sampleLeagueData();
  unchanged.lastUpdated = '2026-10-18T12:00:00.000Z';
  importLeagueDocument(db, unchanged);

  const row2 = db.prepare('SELECT captured_at FROM standings_snapshots LIMIT 1').get();
  assert.equal(row2.captured_at, '2026-10-18T10:00:00.000Z', 'captured_at non deve cambiare se la classifica è identica');
});

test('reconstructLeagueDocument sceglie la stagione is_current anche se ha meno partite', () => {
  const db = initDatabase(':memory:');
  const dOld = sampleLeagueData();
  // Simula vecchia stagione con 2 partite
  importLeagueDocument(db, dOld, { seasonLabel: '2025/26' });

  // Simula nuova stagione is_current con 1 sola partita
  const dNew = sampleLeagueData();
  dNew.matchDays[0].matches = [dNew.matchDays[0].matches[0]];
  importLeagueDocument(db, dNew, { seasonLabel: '2026/27' });

  const reconstructed = reconstructLeagueDocument(db, 'promozione-c');
  assert.equal(reconstructed.matchDays[0].matches.length, 1, 'deve ricostruire la stagione is_current (2026/27) e non la vecchia anche se ha meno partite');
});

test('dumpSnapshot aggiorna exported_at solo se i dati nel dump sono effettivamente cambiati', () => {
  const db = initDatabase(':memory:');
  const initial = sampleLeagueData();
  importLeagueDocument(db, initial);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-snapshot-exported-'));
  const snapFile = path.join(tempDir, 'test-snap.jsonl');

  try {
    dumpSnapshot(db, snapFile);
    const firstLine1 = fs.readFileSync(snapFile, 'utf-8').split('\n')[0];
    const exp1 = JSON.parse(firstLine1).exported_at;

    // Secondo dump a parità di dati nel DB
    dumpSnapshot(db, snapFile);
    const firstLine2 = fs.readFileSync(snapFile, 'utf-8').split('\n')[0];
    const exp2 = JSON.parse(firstLine2).exported_at;
    assert.equal(exp2, exp1, 'exported_at deve rimanere invariato se i dati non sono cambiati');

    // Modifica dati nel DB. Attendiamo qualche millisecondo: `exported_at` ha
    // risoluzione al millisecondo e due dump istantanei darebbero lo stesso valore.
    db.prepare('UPDATE leagues SET name = ? WHERE id = ?').run('Nuovo Nome', 'promozione-c');
    const wait = Date.now() + 5;
    while (Date.now() < wait) { /* attesa attiva di pochi ms */ }
    dumpSnapshot(db, snapFile);
    const firstLine3 = fs.readFileSync(snapFile, 'utf-8').split('\n')[0];
    const exp3 = JSON.parse(firstLine3).exported_at;
    assert.notEqual(exp3, exp1, 'exported_at deve aggiornarsi quando il database cambia');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('syncDatabase riallinea il DB quando è indietro rispetto allo snapshot', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-sync-test-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    // 1. Snapshot assente: non c'è nulla da ripristinare
    assert.deepEqual(syncDatabase(snapFile, { dbPath }), { restored: false, reason: 'snapshot assente' });

    // 2. Creo DB e snapshot allineati
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Il dump non deve far scattare un ripristino: il checksum combacia già.
    assert.equal(syncDatabase(snapFile, { dbPath }).restored, false, 'dopo il dump DB e snapshot sono allineati');
    assert.equal(syncDatabase(snapFile, { dbPath }).reason, 'contenuto identico');

    // 3. Simula un `git pull` che porta dati nuovi: lo snapshot viene
    //    riscritto DOPO l'ultima scrittura del DB, quindi il DB è indietro.
    const db2 = initDatabase(dbPath);
    db2.prepare('UPDATE leagues SET name = ? WHERE id = ?').run('Nome Divergente', 'promozione-c');
    const afterPull = new Date(Date.now() + 5000);
    fs.utimesSync(snapFile, afterPull, afterPull);

    const stale = syncDatabase(snapFile, { dbPath });
    assert.equal(stale.restored, true, 'con il DB indietro e nessuna riga esclusiva va ripristinato');
    assert.ok(stale.count > 0, 'deve restituire il numero di record ripristinati');
    assert.match(stale.reason, /contenuto diverso/);
    assert.ok(stale.backup && fs.existsSync(stale.backup), 'prima di sovrascrivere deve creare un backup');

    // 4. Ripetuto: ora il contenuto coincide di nuovo
    assert.equal(syncDatabase(snapFile, { dbPath }).restored, false);

    // 5. DB assente: viene ricreato dallo snapshot
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    const recreated = syncDatabase(snapFile, { dbPath });
    assert.equal(recreated.restored, true);
    assert.equal(recreated.reason, 'database assente');
    assert.ok(fs.existsSync(dbPath), 'il database deve essere ricreato');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('syncDatabase non cancella un DB più avanti dello snapshot (senza --force)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-sync-ahead-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Riga presente solo nel DB: simula un refresh dalla dashboard (o un
    // db-import) senza il `dump` successivo.
    const row = db.prepare('SELECT * FROM standings_snapshots LIMIT 1').get();
    db.prepare(`
      INSERT INTO standings_snapshots (
        season_id, matchday_number, team_id, position, points, played, won,
        drawn, lost, goals_for, goals_against, goal_diff, zone, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.season_id, 99, row.team_id, row.position, row.points, row.played,
      row.won, row.drawn, row.lost, row.goals_for, row.goals_against,
      row.goal_diff, row.zone, row.captured_at);

    const before = db.prepare('SELECT COUNT(*) AS c FROM standings_snapshots').get().c;

    // Senza --force: rifiuta e non tocca nulla
    const skipped = syncDatabase(snapFile, { dbPath });
    assert.equal(skipped.restored, false, 'non deve ripristinare un DB più avanti');
    assert.equal(skipped.skipped, true);
    assert.match(skipped.reason, /più avanti dello snapshot/);
    assert.ok(skipped.dbOnly.standings_snapshots.length > 0, 'deve elencare le righe esclusive');

    const after = initDatabase(dbPath).prepare('SELECT COUNT(*) AS c FROM standings_snapshots').get().c;
    assert.equal(after, before, 'i dati del DB devono restare intatti');

    // Con --force: ripristina, ma solo dopo aver salvato una copia
    const forced = syncDatabase(snapFile, { dbPath, force: true });
    assert.equal(forced.restored, true);
    assert.ok(forced.backup && fs.existsSync(forced.backup), 'il backup deve esistere');
    assert.match(forced.reason, /--force/);

    const restored = initDatabase(dbPath).prepare('SELECT COUNT(*) AS c FROM standings_snapshots').get().c;
    assert.ok(restored < before, 'con --force il DB torna allo snapshot');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parseScorer riconosce autogol con (Aut.) e minuti di recupero', () => {
  const aut = parseScorer("M. Rossi (Aut.) (15' pt)");
  assert.equal(aut.isOwnGoal, 1);
  assert.equal(aut.name, 'M. Rossi');
  assert.equal(aut.minute, '15');
  assert.equal(aut.half, 'pt');

  const injury = parseScorer("L. Bianchi (45+2' pt)");
  assert.equal(injury.minute, '45+2');
  assert.equal(injury.half, 'pt');
});

test('syncDatabase non ripristina valori locali più recenti dello snapshot (senza --force)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-sync-values-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Scrittura locale DOPO il dump (es. refresh dalla dashboard, db-import
    // senza dump): il DB porta un timestamp dei dati più recente.
    db.prepare('UPDATE leagues SET last_updated = ? WHERE id = ?').run('2027-06-01T00:00:00.000Z', 'promozione-c');

    const skipped = syncDatabase(snapFile, { dbPath });
    assert.equal(skipped.restored, false, 'i valori più recenti non vanno sovrascritti');
    assert.equal(skipped.skipped, true);
    assert.match(skipped.reason, /valori locali più recenti/);

    const lastUpdated = initDatabase(dbPath).prepare('SELECT last_updated FROM leagues WHERE id = ?').get('promozione-c');
    assert.equal(lastUpdated.last_updated, '2027-06-01T00:00:00.000Z', 'il valore locale deve sopravvivere');

    // Con --force si torna allo snapshot, ma il backup conserva il valore locale
    const forced = syncDatabase(snapFile, { dbPath, force: true });
    assert.equal(forced.restored, true);
    assert.ok(forced.backup && fs.existsSync(forced.backup));

    const restored = initDatabase(dbPath).prepare('SELECT last_updated FROM leagues WHERE id = ?').get('promozione-c');
    assert.notEqual(restored.last_updated, '2027-06-01T00:00:00.000Z', 'con --force torna il valore dello snapshot');

    // Il backup è interrogabile e contiene il valore locale
    const backupDb = initDatabase(forced.backup);
    const backupRow = backupDb.prepare('SELECT last_updated FROM leagues WHERE id = ?').get('promozione-c');
    assert.equal(backupRow.last_updated, '2027-06-01T00:00:00.000Z', 'il backup deve contenere i dati scartati');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('il backup non sovrascrive quello precedente: usa un nome con timestamp', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-sync-backup-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Primo ripristino forzato
    db.prepare('UPDATE leagues SET current_match_day = ? WHERE id = ?').run(9, 'promozione-c');
    const first = syncDatabase(snapFile, { dbPath, force: true });
    assert.ok(first.backup);
    assert.match(first.backup, /\.bak$/);

    // Secondo ripristino forzato: il backup precedente deve restare
    db.prepare('UPDATE leagues SET current_match_day = ? WHERE id = ?').run(8, 'promozione-c');
    const second = syncDatabase(snapFile, { dbPath, force: true });
    assert.ok(second.backup);
    assert.notEqual(second.backup, first.backup, 'il secondo backup deve avere un nome diverso');
    assert.ok(fs.existsSync(first.backup), 'il primo backup non deve essere cancellato');
    assert.ok(fs.existsSync(second.backup));

    // Entrambi conservano il valore che avevano al momento del salvataggio
    const firstDay = initDatabase(first.backup).prepare('SELECT current_match_day FROM leagues WHERE id = ?').get('promozione-c');
    const secondDay = initDatabase(second.backup).prepare('SELECT current_match_day FROM leagues WHERE id = ?').get('promozione-c');
    assert.equal(firstDay.current_match_day, 9);
    assert.equal(secondDay.current_match_day, 8);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('analyzeDivergence usa le chiavi naturali: gli id rigenerati non sono "DB più avanti"', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-natural-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Simula un re-import: i gol vengono cancellati e reinseriti con id nuovi,
    // esattamente ciò che succede quando un marcatore cambia.
    const goal = db.prepare('SELECT * FROM goals LIMIT 1').get();
    db.prepare('DELETE FROM goals').run();
    db.prepare(`
      INSERT INTO goals (match_id, team_id, player_raw, player_name, minute, half, is_penalty, is_own_goal, ordinal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(goal.match_id, goal.team_id, goal.player_raw, goal.player_name,
      goal.minute, goal.half, goal.is_penalty, goal.is_own_goal, goal.ordinal);

    const newId = db.prepare('SELECT id FROM goals LIMIT 1').get().id;
    assert.notEqual(newId, goal.id, 'il test deve davvero cambiare l\'id');

    const divergence = analyzeDivergence(db, snapFile);
    assert.deepEqual(divergence.dbOnly, {}, 'la stessa riga logica non è un dato esclusivo del DB');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('analyzeDivergence segnala una riga logica davvero assente dallo snapshot', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-natural-miss-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Nuova squadra: slug assente dallo snapshot
    db.prepare('INSERT INTO teams (name, slug, logo_url) VALUES (?, ?, ?)').run('Squadra Nuova', 'squadra_nuova', '');

    const divergence = analyzeDivergence(db, snapFile);
    assert.deepEqual(divergence.dbOnly.teams, ['squadra_nuova'], 'la chiave naturale deve finire nel report');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('syncDatabase non viene ingannato dall\'apertura del DB (nessuna euristica sui mtime)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-sync-open-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    // 1. DB e snapshot allineati, poi chiusura pulita della connessione
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);
    db.close();

    // 2. `git pull` porta uno snapshot diverso e più recente dei dati locali
    const snapshotText = fs.readFileSync(snapFile, 'utf-8').replace(
      /"(last_updated|captured_at|score_updated_at)":\s*"[^"]*"/g,
      '"$1":"2027-09-09T10:00:00.000Z"'
    );
    fs.writeFileSync(snapFile, snapshotText, 'utf-8');

    // 3. Un altro processo (server, test, CLI) ha già aperto il DB: l'apertura
    //    riscrive `-wal` e `-shm`, che risultano quindi "adesso".
    const previous = initDatabase(dbPath);

    // 4. Il criterio è il contenuto: i timestamp del DB sono più vecchi dello
    //    snapshot, quindi il DB è indietro e va ripristinato, anche se i file
    //    `-wal`/`-shm` sono stati toccati un istante fa.
    const result = syncDatabase(snapFile, { dbPath });

    assert.equal(result.restored, true, 'il DB è indietro: deve ripristinare');
    assert.equal(result.skipped, undefined);
    assert.match(result.reason, /contenuto diverso/);

    const lastUpdated = initDatabase(dbPath).prepare('SELECT last_updated FROM leagues WHERE id = ?').get('promozione-c');
    assert.equal(lastUpdated.last_updated, '2027-09-09T10:00:00.000Z', 'i dati dello snapshot devono essere applicati');
    previous.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('compareFreshness confronta i timestamp dei dati, non le date dei file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-freshness-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Allineati: nessuno è avanti
    const aligned = compareFreshness(db, snapFile);
    assert.equal(aligned.dbAhead, false);
    assert.equal(aligned.dbLatest, aligned.snapshotLatest);

    // Il DB riceve un dato osservato più tardi: è avanti
    db.prepare('UPDATE matches SET score_updated_at = ? WHERE id = (SELECT MIN(id) FROM matches)')
      .run('2027-05-05T10:00:00.000Z');
    const ahead = compareFreshness(db, snapFile);
    assert.equal(ahead.dbAhead, true, 'un punteggio più recente rende il DB avanti');
    assert.equal(ahead.dbLatest, '2027-05-05T10:00:00.000Z');

    // Se lo snapshot ha timestamp più recenti, il DB è indietro
    const snapshotText = fs.readFileSync(snapFile, 'utf-8').replace(
      /"(last_updated|captured_at|score_updated_at)":\s*"[^"]*"/g,
      '"$1":"2027-09-09T10:00:00.000Z"'
    );
    fs.writeFileSync(snapFile, snapshotText, 'utf-8');
    const behind = compareFreshness(db, snapFile);
    assert.equal(behind.dbAhead, false, 'con lo snapshot più recente il DB è indietro');
    assert.equal(behind.snapshotLatest, '2027-09-09T10:00:00.000Z');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('snapshotMatchesDatabase confronta il corpo su disco, non il checksum dichiarato', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-snap-body-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    assert.equal(snapshotMatchesDatabase(db, snapFile), true, 'appena scritto deve combaciare');

    // Modifica del corpo lasciando intatto l'header (come un merge o una modifica a mano):
    // il checksum nell'header descrive ancora il DB, ma il file non è più lo stesso.
    const content = fs.readFileSync(snapFile, 'utf-8');
    const firstNewline = content.indexOf('\n');
    const header = content.slice(0, firstNewline);
    const body = content.slice(firstNewline + 1);
    fs.writeFileSync(snapFile, header + '\n' + body.replace('Promozione Toscana - Girone C', 'Nome Alterato'), 'utf-8');

    assert.equal(
      snapshotMatchesDatabase(db, snapFile),
      false,
      'un corpo diverso non deve risultare identico solo perché l\'header non è stato aggiornato'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
