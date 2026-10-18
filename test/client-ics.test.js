const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');

/**
 * Il calendario scaricato dai pulsanti della dashboard è generato lato browser
 * da public/app.js: è un duplicato dell'exporter Node, quindi va verificato a
 * parte per evitare che i due si allontanino.
 */
function loadApp() {
  const { document, window } = parseHTML(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));

  const ctx = {
    document,
    window,
    TextEncoder,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    Blob: class {},
    URL: { createObjectURL: () => 'blob:finto', revokeObjectURL: () => {} },
    console, Date, setTimeout, clearTimeout
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

  return ctx;
}

function sampleData() {
  return {
    id: 'promozione-c',
    name: 'Promozione Toscana - Girone C',
    shortName: 'Promozione C',
    matchDays: [
      {
        dayNumber: 4,
        dayTitle: '4° Giornata',
        dayDate: '03|10|2026',
        matches: [
          {
            homeTeam: 'Resco, Reggello',
            awayTeam: 'Squadra B',
            homeScore: 2,
            awayScore: 1,
            isPlayed: true,
            status: 'FINISHED',
            date: '2026-10-03',
            time: '15:30',
            dateTime: '2026-10-03T15:30:00',
            homeScorers: ["Rossi, Bianchi (12' pt)"],
            awayScorers: [],
            matchLink: ''
          }
        ]
      }
    ]
  };
}

const unfold = (ics) => ics.replace(/\r\n /g, '');

test('il calendario generato nel browser rispetta la RFC 5545', () => {
  const ctx = loadApp();
  const ics = ctx.generateClientIcs(sampleData());

  const troppoLunghe = ics.split('\r\n').filter(l => Buffer.byteLength(l, 'utf-8') > 75);
  assert.deepEqual(troppoLunghe, [], 'nessuna riga oltre i 75 ottetti');
  assert.match(ics, /\r\n /, 'il folding usa lo spazio iniziale');

  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Rome/);
  assert.match(ics, /END:VTIMEZONE/);

  const logical = unfold(ics);
  assert.match(logical, /SUMMARY:Resco\\, Reggello vs Squadra B/);
  assert.match(logical, /Rossi\\, Bianchi/, 'le virgole dei marcatori vanno escapate');
  assert.doesNotMatch(logical, /Rossi, Bianchi/, 'nessuna virgola nuda nella descrizione');
  assert.match(logical, /\\n/, 'gli a capo vanno escapati');
});

test('il calendario del browser segna come TENTATIVE le partite rinviate', () => {
  const ctx = loadApp();
  const data = sampleData();

  data.matchDays[0].matches[0].isPlayed = false;
  data.matchDays[0].matches[0].status = 'POSTPONED';
  data.matchDays[0].matches[0].homeScore = null;
  data.matchDays[0].matches[0].awayScore = null;

  const statuses = ctx.generateClientIcs(data).split('\r\n').filter(l => l.startsWith('STATUS:'));
  assert.deepEqual(statuses, ['STATUS:TENTATIVE']);
});

test('il calendario del browser usa lo stesso default orario dell\'export', () => {
  const ctx = loadApp();
  const data = sampleData();
  // Partita in programma senza orario indicato dalla pagina
  data.matchDays[0].matches[0].isPlayed = false;
  data.matchDays[0].matches[0].status = 'SCHEDULED';
  data.matchDays[0].matches[0].homeScore = null;
  data.matchDays[0].matches[0].awayScore = null;
  data.matchDays[0].matches[0].time = '';
  data.matchDays[0].matches[0].dateTime = '2026-10-03T15:30:00';

  const logical = unfold(ctx.generateClientIcs(data));
  assert.match(logical, /Partita in programma alle 15:30/, 'il default è 15:30');
  assert.match(logical, /DTSTART;TZID=Europe\/Rome:20261003T153000/);

  // Partita alle 15:00 esatte (minuti = 00): deve restare 15:00 e non slittare a 15:30
  data.matchDays[0].matches[0].time = '15:00';
  data.matchDays[0].matches[0].dateTime = '2026-10-03T15:00:00';
  const logical1500 = unfold(ctx.generateClientIcs(data));
  assert.match(logical1500, /DTSTART;TZID=Europe\/Rome:20261003T150000/);
  assert.match(logical1500, /DTEND;TZID=Europe\/Rome:20261003T164500/);
});

test('safeExternalUrl nel browser scarta schemi pericolosi e URL con a capo', () => {
  const ctx = loadApp();
  const valid = ctx.safeExternalUrl('https://www.tuttocampo.it/Partita/1');

  assert.equal(typeof ctx.safeExternalUrl, 'function', 'la funzione deve essere disponibile nel browser');
  assert.equal(valid, 'https://www.tuttocampo.it/Partita/1');
  assert.equal(ctx.safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(ctx.safeExternalUrl('data:text/html,<b>'), '');
  assert.equal(ctx.safeExternalUrl('/relativo'), '');
  assert.equal(ctx.safeExternalUrl('https://esempio.it/x\r\nX-INJECT:1'), '', 'i a capo vanno rifiutati');
  assert.equal(ctx.safeExternalUrl(''), '');
  assert.equal(ctx.safeExternalUrl(null), '');
});

test('il .ics del browser non contiene un matchLink con schema pericoloso', () => {
  const ctx = loadApp();
  const data = sampleData();
  data.matchDays[0].matches[0].matchLink = 'javascript:alert(1)';

  const ics = ctx.generateClientIcs(data);
  assert.doesNotMatch(ics, /javascript:/);
});
