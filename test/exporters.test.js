const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportSlug, exportToJson, exportToCsv, exportToIcs, buildCsv, buildIcs } = require('../src/exporters');
const { sampleLeagueData } = require('./fixtures');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calcio-test-'));
  return path.join(dir, name);
}

/** Rimuove il line folding RFC 5545 per poter controllare il testo logico. */
function unfold(ics) {
  return String(ics).replace(/\r\n /g, '');
}

test('exportSlug normalizza il nome squadra per il file', () => {
  assert.equal(exportSlug('Centro Storico Lebowski'), 'centro_storico_lebowski');
  assert.equal(exportSlug('Arezzo FA'), 'arezzo_fa');
  assert.equal(exportSlug('  Poppi  '), 'poppi');
  assert.equal(exportSlug(''), '');
});

test('exportToJson scrive il JSON completo e crea la cartella', () => {
  const data = sampleLeagueData();
  const out = tmpFile(path.join('nested', 'promozione-c.json'));

  exportToJson(data, out);

  assert.ok(fs.existsSync(out));
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf-8')), data);
});

test('exportToCsv usa BOM, separatore ";" e filtro squadra', () => {
  const data = sampleLeagueData();

  const all = tmpFile('all.csv');
  exportToCsv(data, all);
  const allText = fs.readFileSync(all, 'utf-8');
  assert.equal(allText.charCodeAt(0), 0xFEFF, 'deve iniziare con il BOM UTF-8');
  assert.match(allText.slice(1), /^Campionato;Categoria;Girone;Giornata_Num/);
  // 1 riga di intestazione + 2 partite
  assert.equal(allText.trim().split('\r\n').length, 3);
  // I campi con virgole/virgolette restano quotati
  assert.match(allText, /"Centro Storico Lebowski"/);
  assert.match(allText, /"M\. Rossi \(12' pt\)"/);

  const filtered = tmpFile('lebowski.csv');
  exportToCsv(data, filtered, { team: 'lebowski' });
  const filteredText = fs.readFileSync(filtered, 'utf-8');
  assert.equal(filteredText.trim().split('\r\n').length, 2, 'solo la partita del Lebowski');
  assert.match(filteredText, /Centro Storico Lebowski/);
  assert.doesNotMatch(filteredText, /Resco/);
});

test('exportToIcs genera un calendario valido, con un VEVENT per partita', () => {
  const data = sampleLeagueData();
  const out = tmpFile('all.ics');

  exportToIcs(data, out);
  const text = fs.readFileSync(out, 'utf-8');
  const logical = unfold(text);

  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(text, /END:VCALENDAR$/);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((text.match(/END:VEVENT/g) || []).length, 2);
  // Un UID distinto per evento
  const uids = [...text.matchAll(/UID:(.+)/g)].map(m => m[1].trim());
  assert.equal(new Set(uids).size, 2);

  assert.match(text, /DTSTART;TZID=Europe\/Rome:20260913T153000/);
  assert.match(text, /DTEND;TZID=Europe\/Rome:20260913T171500/);
  assert.match(text, /SUMMARY:Centro Storico Lebowski vs Acquaviva \(2-1\)/);
  assert.match(logical, /Marcatori Centro Storico Lebowski: M\. Rossi \(12' pt\)/);

  // Le virgole nei nomi squadra devono essere escapate nella SUMMARY
  assert.match(text, /SUMMARY:Resco\\, Reggello vs Squadra B/);
  assert.doesNotMatch(text, /SUMMARY:Resco, Reggello/);
});

test('exportToIcs filtra per squadra', () => {
  const data = sampleLeagueData();
  const out = tmpFile('lebowski.ics');

  exportToIcs(data, out, { team: 'Lebowski' });
  const text = fs.readFileSync(out, 'utf-8');

  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(text, /X-WR-CALNAME:Lebowski - Promozione C/);
});

test('buildCsv restituisce la stringa con BOM senza scrivere nulla', () => {
  const csv = buildCsv(sampleLeagueData());

  assert.equal(csv.charCodeAt(0), 0xFEFF, 'deve iniziare con il BOM UTF-8');
  assert.match(csv.slice(1), /^Campionato;Categoria;Girone;Giornata_Num/);
  assert.equal(csv.trim().split('\r\n').length, 3, 'intestazione + 2 partite');

  const filtered = buildCsv(sampleLeagueData(), { team: 'lebowski' });
  assert.equal(filtered.trim().split('\r\n').length, 2);
});

test('buildIcs rispetta i limiti di riga della RFC 5545', () => {
  const ics = buildIcs(sampleLeagueData());

  const troppoLunghe = ics.split('\r\n').filter(line => Buffer.byteLength(line, 'utf-8') > 75);
  assert.deepEqual(troppoLunghe, [], 'nessuna riga deve superare i 75 ottetti');

  // Le continuazioni del folding iniziano con uno spazio
  assert.match(ics, /\r\n /, 'il folding deve usare lo spazio iniziale');
});

test('buildIcs dichiara il fuso orario con VTIMEZONE', () => {
  const ics = buildIcs(sampleLeagueData());

  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Rome/);
  assert.match(ics, /BEGIN:DAYLIGHT\r\n[^]*?RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/);
  assert.match(ics, /BEGIN:STANDARD\r\n[^]*?RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/);
  assert.match(ics, /END:VTIMEZONE/);
  // Un solo VTIMEZONE anche con più eventi
  assert.equal((ics.match(/BEGIN:VTIMEZONE/g) || []).length, 1);
});

test('buildIcs escapa virgole e a capo nella descrizione', () => {
  const data = sampleLeagueData();
  // Nome squadra con virgola, come "Resco, Reggello" nel girone reale
  data.matchDays[0].matches[0].homeScorers = ['Rossi, Bianchi (12\' pt)'];

  const logical = unfold(buildIcs(data));
  const descrizione = logical.split('DESCRIPTION:')[1].split('\r\n')[0];

  assert.match(descrizione, /Rossi\\, Bianchi/, 'la virgola dei marcatori deve essere escapata');
  assert.doesNotMatch(descrizione, /Rossi, Bianchi/, 'nessuna virgola nuda nella descrizione');
  assert.match(descrizione, /\\n/, 'gli a capo vanno escapati come \\n');
});

test('buildIcs segna come TENTATIVE le partite rinviate', () => {
  const data = sampleLeagueData();
  data.matchDays[1].matches[0].status = 'POSTPONED';
  data.matchDays[1].matches[0].isPlayed = false;

  const ics = buildIcs(data);

  const statuses = ics.split('\r\n').filter(l => l.startsWith('STATUS:'));
  assert.deepEqual(statuses, ['STATUS:CONFIRMED', 'STATUS:TENTATIVE']);
});

test('buildIcs filtra per squadra anche in memoria', () => {
  const ics = buildIcs(sampleLeagueData(), { team: 'Lebowski' });

  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /X-WR-CALNAME:Lebowski - Promozione C/);
});

test('buildIcs normalizza un team passato come array invece di fallire', () => {
  // Regressione: Express passa ?team=a&team=b come array; gli exporter non
  // devono andare in errore (il server lo normalizza comunque a monte)
  assert.doesNotThrow(() => buildIcs(sampleLeagueData(), { team: ['Lebowski'] }));
  assert.doesNotThrow(() => buildCsv(sampleLeagueData(), { team: ['Lebowski'] }));
});
