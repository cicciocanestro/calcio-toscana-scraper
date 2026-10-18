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
const { dumpSnapshot, restoreSnapshot } = require('../src/db-snapshot');
const { syncDatabase } = require('../bin/db-snapshot');
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

test('syncDatabase ripristina solo quando il database è disallineato dallo snapshot', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-sync-test-'));
  const dbPath = path.join(tempDir, 'calcio.sqlite');
  const snapFile = path.join(tempDir, 'snapshot.jsonl');

  try {
    // 1. Snapshot assente: non c'è nulla da ripristinare
    assert.deepEqual(syncDatabase(snapFile, dbPath), { restored: false, reason: 'snapshot assente' });

    // 2. Creo DB e snapshot allineati
    const db = initDatabase(dbPath);
    importLeagueDocument(db, sampleLeagueData());
    dumpSnapshot(db, snapFile);

    // Il dump non deve far scattare un ripristino: il checksum combacia già.
    assert.equal(syncDatabase(snapFile, dbPath).restored, false, 'dopo il dump DB e snapshot sono allineati');
    assert.equal(syncDatabase(snapFile, dbPath).reason, 'contenuto identico');

    // 3. Un `git pull` che cambia i dati rende il DB obsoleto anche se il mtime
    //    non è affidabile: il criterio è il contenuto, non la data.
    const db2 = initDatabase(dbPath);
    db2.prepare('UPDATE leagues SET name = ? WHERE id = ?').run('Nome Divergente', 'promozione-c');
    const stale = syncDatabase(snapFile, dbPath);
    assert.equal(stale.restored, true, 'con contenuto diverso il DB va ripristinato');
    assert.ok(stale.count > 0, 'deve restituire il numero di record ripristinati');

    // 4. Ripetuto: ora il contenuto coincide di nuovo
    assert.equal(syncDatabase(snapFile, dbPath).restored, false);

    // 5. DB assente: viene ricreato dallo snapshot
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    const recreated = syncDatabase(snapFile, dbPath);
    assert.equal(recreated.restored, true);
    assert.equal(recreated.reason, 'database assente');
    assert.ok(fs.existsSync(dbPath), 'il database deve essere ricreato');
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
