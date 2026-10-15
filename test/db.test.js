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

    // File esportati su disco sincronizzati
    assert.ok(fs.existsSync(path.join(tempDir, 'promozione-c.json')));
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
