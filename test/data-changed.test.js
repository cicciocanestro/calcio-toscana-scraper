const test = require('node:test');
const assert = require('node:assert/strict');

const { sportsFingerprint, diffAgainstPrevious, stableStringify } = require('../bin/data-changed');
const { sampleLeagueData } = require('./fixtures');

test('sportsFingerprint ignora i campi volatili', () => {
  const a = sampleLeagueData();
  const b = sampleLeagueData();

  b.lastUpdated = '2099-01-01T00:00:00.000Z';
  b.isStale = true;

  assert.equal(sportsFingerprint(a), sportsFingerprint(b));
});

test('sportsFingerprint non dipende dall\'ordine delle chiavi', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ x: [1, { b: 2, a: 1 }] }), stableStringify({ x: [1, { a: 1, b: 2 }] }));
});

test('sportsFingerprint cambia quando cambia un risultato o la classifica', () => {
  const base = sampleLeagueData();

  const score = sampleLeagueData();
  score.matchDays[0].matches[0].homeScore = 3;
  assert.notEqual(sportsFingerprint(base), sportsFingerprint(score));

  const points = sampleLeagueData();
  points.standings[0].points = 7;
  assert.notEqual(sportsFingerprint(base), sportsFingerprint(points));

  const team = sampleLeagueData();
  team.matchDays[0].matches[0].homeTeam = 'Altra Squadra';
  assert.notEqual(sportsFingerprint(base), sportsFingerprint(team));

  // Anche i loghi sono dati: un cambio di URL è una modifica reale
  const logo = sampleLeagueData();
  logo.matchDays[0].matches[0].homeLogo = 'https://example.com/nuovo.png';
  assert.notEqual(sportsFingerprint(base), sportsFingerprint(logo));
});

test('diffAgainstPrevious riconosce dati invariati, cambiati e nuovi', () => {
  const previous = sampleLeagueData();

  // Identico a meno del timestamp -> invariato
  const same = { ...sampleLeagueData(), lastUpdated: '2026-12-31T23:59:59.000Z' };
  let result = diffAgainstPrevious({ 'promozione-c': same }, () => previous);
  assert.deepEqual(result.unchanged, ['promozione-c']);
  assert.deepEqual(result.changed, []);
  assert.equal(result.isChanged, false);

  // Un gol in più -> cambiato
  const different = sampleLeagueData();
  different.matchDays[1].matches[0].awayScore = 4;
  different.matchDays[1].matches[0].isPlayed = true;
  result = diffAgainstPrevious({ 'promozione-c': different }, () => previous);
  assert.deepEqual(result.changed, ['promozione-c']);
  assert.equal(result.isChanged, true);

  // Nessuna versione precedente (primo run) -> cambiato
  result = diffAgainstPrevious({ 'promozione-c': previous }, () => null);
  assert.deepEqual(result.changed, ['promozione-c']);

  // Dati correnti illeggibili -> cambiato
  result = diffAgainstPrevious({ 'promozione-c': null }, () => previous);
  assert.deepEqual(result.changed, ['promozione-c']);
});

test('diffAgainstPrevious gestisce più campionati con esiti diversi', () => {
  const first = sampleLeagueData();
  const second = { ...sampleLeagueData(), id: 'seconda-i' };
  const secondChanged = JSON.parse(JSON.stringify(second));
  secondChanged.standings[0].points = 3;

  const result = diffAgainstPrevious(
    { 'promozione-c': { ...first, lastUpdated: '2099-01-01T00:00:00.000Z' }, 'seconda-i': secondChanged },
    (id) => (id === 'promozione-c' ? first : second)
  );

  assert.deepEqual(result.unchanged, ['promozione-c']);
  assert.deepEqual(result.changed, ['seconda-i']);
  assert.equal(result.isChanged, true);
});
