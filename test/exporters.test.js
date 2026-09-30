const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportSlug, exportToJson, exportToCsv, exportToIcs } = require('../src/exporters');
const { sampleLeagueData } = require('./fixtures');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calcio-test-'));
  return path.join(dir, name);
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
  assert.match(text, /Marcatori Centro Storico Lebowski: M\. Rossi \(12' pt\)/);

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
