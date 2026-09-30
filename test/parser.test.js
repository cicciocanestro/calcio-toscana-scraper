const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');

// Il parser usa il DOMParser globale (nel browser è nativo)
globalThis.DOMParser = DOMParser;

const parser = require('../src/parser');
const { STANDINGS_HTML, MATCHDAY_HTML } = require('./fixtures');

test('parseDayDateString estrae data e anno di riferimento', () => {
  assert.deepEqual(parser.parseDayDateString('19|09|2026 - 20|09|2026'), {
    defaultDate: '2026-09-19',
    defaultYear: '2026'
  });
  assert.deepEqual(parser.parseDayDateString('1/9/2026'), {
    defaultDate: '2026-09-01',
    defaultYear: '2026'
  });
  assert.equal(parser.parseDayDateString('').defaultDate, null);
  assert.equal(parser.parseDayDateString('da definire').defaultDate, null);
});

test('parseDateHeader converte le date in italiano', () => {
  assert.equal(parser.parseDateHeader('Sab. 19 settembre', '2026'), '2026-09-19');
  assert.equal(parser.parseDateHeader('Domenica 20 Settembre 2027', '2026'), '2027-09-20');
  assert.equal(parser.parseDateHeader('  Mer. 7 ott  ', '2026'), '2026-10-07');
  assert.equal(parser.parseDateHeader('da definire', '2026'), null);
  assert.equal(parser.parseDateHeader('', '2026'), null);
});

test('parseMatchdayHtml estrae giornata, date, risultati e marcatori', () => {
  const day = parser.parseMatchdayHtml(MATCHDAY_HTML, 4);

  assert.equal(day.dayNumber, 4);
  assert.equal(day.dayTitle, '4° Giornata');
  assert.equal(day.dayDate, '19|09|2026 - 20|09|2026');
  assert.equal(day.matches.length, 3);

  const [played, scheduled, postponed] = day.matches;

  // Partita giocata: punteggio, stato, data/ora e link
  assert.equal(played.homeTeam, 'Acquaviva');
  assert.equal(played.awayTeam, 'Resco Reggello');
  assert.equal(played.homeScore, 2);
  assert.equal(played.awayScore, 1);
  assert.equal(played.isPlayed, true);
  assert.equal(played.status, 'FINISHED');
  assert.equal(played.date, '2026-09-19');
  assert.equal(played.time, '15:30');
  assert.equal(played.dateTime, '2026-09-19T15:30:00');
  assert.match(played.matchLink, /acquaviva-resco-reggello$/);
  // I marcatori "Elimina" (pulsanti di editing) vanno scartati
  assert.deepEqual(played.homeScorers, ["M. Rossi (12' pt)"]);
  assert.deepEqual(played.awayScorers, ["L. Bianchi (30' st)"]);

  // Partita da giocare: nessun punteggio, usa la data dell'ultimo header
  assert.equal(scheduled.status, 'SCHEDULED');
  assert.equal(scheduled.isPlayed, false);
  assert.equal(scheduled.homeScore, null);
  assert.equal(scheduled.date, '2026-09-20');
  assert.equal(scheduled.dateTime, '2026-09-20T15:00:00');

  // Partita rinviata
  assert.equal(postponed.status, 'POSTPONED');
  assert.equal(postponed.isPlayed, false);
  // Senza orario valido si usa il fallback delle 15:00
  assert.equal(postponed.dateTime, '2026-09-20T15:00:00');
});

test('parseStandingsHtml estrae classifica, zone e gestisce le celle vuote', () => {
  const standings = parser.parseStandingsHtml(STANDINGS_HTML);

  // La riga "team_stats_row" deve essere ignorata
  assert.equal(standings.length, 4);
  assert.deepEqual(standings.map(s => s.position), [1, 2, 3, 4]);
  assert.deepEqual(standings.map(s => s.zone), ['promotion', 'playoff', 'playout', 'retrocession']);

  const [first, second] = standings;
  assert.equal(first.team, 'Montagnano 1966');
  assert.equal(first.points, 9);
  assert.equal(first.played, 3);
  assert.equal(first.won, 3);
  assert.equal(first.drawn, 0);
  assert.equal(first.lost, 0);
  assert.equal(first.goalsFor, 7);
  assert.equal(first.goalsAgainst, 0);
  assert.equal(first.goalDiff, 7);

  assert.equal(second.team, 'Acquaviva');
  assert.equal(second.goalsAgainst, 3);
  assert.equal(second.goalDiff, 2);

  // Celle "-": nessun NaN, tutti zeri (classe "pt" invece di "points")
  const empty = standings[3];
  assert.equal(empty.points, 0);
  assert.equal(empty.played, 0);
  assert.equal(empty.goalDiff, 0);
  assert.ok(standings.every(s => Object.values(s).every(v => v === v)), 'nessun valore NaN nella classifica');
});

test('il parser è utilizzabile anche in un contesto browser-like (iniezione in pagina)', () => {
  const source = fs.readFileSync(require.resolve('../src/parser'), 'utf-8');

  // Non deve contenere dipendenze Node: viene iniettato in pagina dallo scraper
  // (i commenti sono esclusi dal controllo)
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /require\(/, 'il parser non deve usare require()');

  // Simula il contesto della pagina: nessun module/exports, solo window + DOMParser
  const sandbox = { DOMParser, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const pageParser = sandbox.window.CalcioParser;
  assert.ok(pageParser, 'window.CalcioParser deve essere definito');
  assert.equal(pageParser.parseStandingsHtml(STANDINGS_HTML).length, 4);
  assert.equal(pageParser.parseMatchdayHtml(MATCHDAY_HTML, 1).matches.length, 3);
});
