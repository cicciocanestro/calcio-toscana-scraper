const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');

/**
 * La dashboard è un unico file browser (public/app.js) senza export. Per
 * testarla si carica index.html in linkedom e si esegue app.js in una sandbox,
 * con un `fetch` finto che restituisce dati sintetici: i test restano così
 * deterministici e indipendenti dai dati reali in cache.
 *
 * I dati riproducono la situazione reale: la stessa "4ª Giornata" cade su
 * weekend diversi nei tre campionati (3-4 ottobre in Promozione, 10-11 ottobre
 * in Seconda e Terza).
 */

function match(homeTeam, awayTeam, date, homeScore = null, awayScore = null) {
  return {
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    isPlayed: homeScore !== null && awayScore !== null,
    status: homeScore === null ? 'SCHEDULED' : 'FINISHED',
    date,
    time: '15:30',
    dateTime: `${date}T15:30:00`,
    homeScorers: [],
    awayScorers: [],
    matchLink: ''
  };
}

const DATA = {
  'promozione-c': {
    id: 'promozione-c',
    name: 'Promozione Toscana - Girone C',
    shortName: 'Promozione C',
    currentMatchDay: 4,
    totalMatchDays: 5,
    matchDays: [
      {
        dayNumber: 4, dayTitle: '4° Giornata', dayDate: '03|10|2026 - 04|10|2026',
        matches: [
          match('Cortona Camucia Calcio', 'Acquaviva', '2026-10-03', 2, 1),
          match('Altra Squadra', 'Terza Squadra', '2026-10-04'),
          match('Acquaviva', 'Cortona Camucia Calcio', '2026-10-04') // trasferta
        ]
      },
      {
        dayNumber: 5, dayTitle: '5° Giornata', dayDate: '10|10|2026 - 11|10|2026',
        matches: [match('Cortona Camucia Calcio', 'Resco Reggello', '2026-10-10')]
      }
    ]
  },
  'seconda-i': {
    id: 'seconda-i',
    name: 'Seconda Categoria Toscana - Girone I',
    shortName: 'Seconda Cat. I',
    currentMatchDay: 4,
    totalMatchDays: 4,
    matchDays: [
      {
        dayNumber: 4, dayTitle: '4° Giornata', dayDate: '10|10|2026 - 11|10|2026',
        matches: [
          match('Fratta Santa Caterina', 'Poppi', '2026-10-10'),
          match('Fratticciola', 'Bucine', '2026-10-11'),
          match('Bucine', 'Fratticciola', '2026-10-11') // trasferta
        ]
      }
    ]
  },
  'terza-arezzo': {
    id: 'terza-arezzo',
    name: 'Terza Categoria Arezzo - Girone Unico',
    shortName: 'Terza Cat. Arezzo',
    currentMatchDay: 4,
    totalMatchDays: 4,
    matchDays: [
      {
        dayNumber: 4, dayTitle: '4° Giornata', dayDate: '11|10|2026',
        matches: [
          match('Montecchio', 'Tuscar', '2026-10-11'),
          match('Monsigliolo', 'Badia Agnano', '2026-10-11'),
          match('Terontola', 'Montecchio', '2026-10-11') // trasferta
        ]
      }
    ]
  }
};

/** Carica index.html + app.js in una sandbox con linkedom e un fetch finto. */
function loadApp(payloads = DATA) {
  const { document, window } = parseHTML(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'));

  const ctx = {
    document,
    window,
    fetch: async (url) => {
      const found = String(url).match(/leagues\/([a-z0-9-]+)|cache\/([a-z0-9-]+)\.json/);
      const id = found && (found[1] || found[2]);
      const body = id ? payloads[id] : null;
      return body ? { ok: true, json: async () => body } : { ok: false, json: async () => ({}) };
    },
    Blob: class {},
    URL: { createObjectURL: () => 'blob:finto', revokeObjectURL: () => {} },
    console, Date, setTimeout, clearTimeout
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

  return { ctx, document };
}

const homeOf = (card) => card.querySelector('.team-row.home .team-name').textContent;
const awayOf = (card) => card.querySelector('.team-row.away .team-name').textContent;

/** Seleziona il weekend che inizia in una certa data, come farebbe l'utente. */
function selectWeekend(ctx, fromDate) {
  const weekend = ctx.camuciaWeekendOptions().find(w => w.from === fromDate);
  assert.ok(weekend, `nessun weekend che inizia il ${fromDate}`);

  vm.runInContext(
    `camuciaSelectedWeekend = ${JSON.stringify(weekend.key)};` +
    'populateCamuciaWeekendSelector(); renderCamuciaMatches();',
    ctx
  );
  return weekend;
}

test('la scheda CC Camucia è collegata al pannello giusto ed è l\'ultima voce', () => {
  const { document } = loadApp();

  const button = [...document.querySelectorAll('.sub-nav-btn')]
    .find(b => b.getAttribute('data-view') === 'camucia');

  assert.ok(button, 'esiste il pulsante nella sotto-navigazione');
  assert.match(button.textContent, /CC Camucia/);
  assert.ok(document.getElementById('view-camucia'), 'esiste il pannello della vista');
  assert.ok(document.getElementById('select-camucia-weekend'), 'esiste il selettore di weekend');

  const voci = [...document.querySelectorAll('.sub-nav-btn')].map(b => b.getAttribute('data-view'));
  assert.deepEqual(voci, ['calendar', 'standings', 'team', 'export', 'camucia']);
});

test('isCamuciaTeam riconosce le cinque squadre e ignora le altre', () => {
  const { ctx } = loadApp();

  for (const nome of ['Cortona Camucia Calcio', 'Fratta Santa Caterina', 'Fratticciola', 'Montecchio', 'Monsigliolo']) {
    assert.equal(ctx.isCamuciaTeam(nome), true, `${nome} deve essere riconosciuta`);
  }
  for (const nome of ['Resco Reggello', 'Poppi', 'Terontola', 'Montagnano 1966', '']) {
    assert.equal(ctx.isCamuciaTeam(nome), false, `${nome} non deve essere riconosciuta`);
  }
});

test('isoWeekKey mette nello stesso gruppo sabato e domenica, e separa i weekend', () => {
  const { ctx } = loadApp();

  assert.equal(ctx.isoWeekKey('2026-10-03'), ctx.isoWeekKey('2026-10-04'), 'sabato e domenica');
  assert.equal(ctx.isoWeekKey('2026-10-10'), ctx.isoWeekKey('2026-10-11'), 'sabato e domenica');
  assert.notEqual(ctx.isoWeekKey('2026-10-03'), ctx.isoWeekKey('2026-10-10'), 'weekend diversi');
  // Anche a cavallo di un mese
  assert.equal(ctx.isoWeekKey('2026-10-31'), ctx.isoWeekKey('2026-11-01'));

  assert.equal(ctx.isoWeekKey(''), null);
  assert.equal(ctx.isoWeekKey('non-una-data'), null);
});

test('formatDateRange produce etichette italiane leggibili', () => {
  const { ctx } = loadApp();

  assert.equal(ctx.formatDateRange('2026-10-10', '2026-10-11'), '10–11 ottobre 2026');
  assert.equal(ctx.formatDateRange('2026-10-11', '2026-10-11'), '11 ottobre 2026');
  assert.equal(ctx.formatDateRange('2026-09-28', '2026-10-04'), '28 settembre – 4 ottobre 2026');
  assert.equal(ctx.formatDateRange('', ''), '');
});

test('collectCamuciaBlocks tiene solo le partite in casa e filtra per weekend', () => {
  const { ctx } = loadApp();
  const leagues = [{ data: DATA['promozione-c'] }];

  const tutte = ctx.collectCamuciaBlocks(leagues, null);
  assert.equal(tutte.length, 2, 'una giornata per weekend');
  assert.ok(tutte.every(b => b.matches.every(m => ctx.isCamuciaTeam(m.homeTeam))), 'nessuna trasferta');

  const weekendDiOttobre = ctx.collectCamuciaBlocks(leagues, ctx.isoWeekKey('2026-10-10'));
  assert.equal(weekendDiOttobre.length, 1);
  assert.equal(weekendDiOttobre[0].matches.length, 1);
  assert.equal(weekendDiOttobre[0].matches[0].awayTeam, 'Resco Reggello');
});

test('camuciaWeekendOptions elenca i weekend con etichetta, in ordine di data', () => {
  const { ctx } = loadApp();

  // Popola lo stato come farebbe l'apertura della scheda
  return ctx.loadCamuciaLeagues().then(() => {
    const options = ctx.camuciaWeekendOptions();

    assert.equal(options.length, 2);
    assert.deepEqual([...options].map(w => w.label), ['3–4 ottobre 2026', '10–11 ottobre 2026']);
    assert.deepEqual([...options].map(w => w.from), ['2026-10-03', '2026-10-10']);
  });
});

test('defaultCamuciaWeekend sceglie il prossimo weekend, altrimenti l\'ultimo', () => {
  const { ctx } = loadApp();

  const passato = { key: 'A', from: '2020-01-04', to: '2020-01-05' };
  const futuro = { key: 'B', from: '2099-01-03', to: '2099-01-04' };

  assert.equal(ctx.defaultCamuciaWeekend([passato, futuro]), 'B');
  assert.equal(ctx.defaultCamuciaWeekend([passato]), 'A', 'se sono tutti passati si usa l\'ultimo');
  assert.equal(ctx.defaultCamuciaWeekend([]), null);
});

test('la scheda raggruppa per weekend le partite dei tre campionati', async () => {
  const { ctx, document } = loadApp();
  await ctx.openCamuciaView();

  const container = document.getElementById('camucia-container');
  const weekend = selectWeekend(ctx, '2026-10-10');

  // Intestazione del weekend
  const heading = container.querySelector('.weekend-heading');
  assert.ok(heading, 'c\'è l\'intestazione del weekend');
  assert.equal(heading.textContent, weekend.label);
  assert.equal(heading.textContent, '10–11 ottobre 2026');

  // Una partita in casa per ognuna delle cinque squadre, da tutti e tre i campionati
  const cards = [...container.querySelectorAll('.match-card')];
  assert.deepEqual(
    cards.map(homeOf).sort(),
    ['Cortona Camucia Calcio', 'Fratta Santa Caterina', 'Fratticciola', 'Montecchio', 'Monsigliolo'].sort()
  );
  assert.ok(!cards.some(c => ctx.isCamuciaTeam(awayOf(c))), 'le trasferte non devono comparire');

  // Un blocco per campionato, con la giornata come informazione secondaria
  const blocchi = [...container.querySelectorAll('.matchday-block')];
  assert.equal(blocchi.length, 3);
  assert.deepEqual(
    blocchi.map(b => b.querySelector('.matchday-title').textContent).sort(),
    ['Promozione C', 'Seconda Cat. I', 'Terza Cat. Arezzo'].sort()
  );
  assert.ok(
    blocchi.every(b => /Giornata/.test(b.querySelector('.matchday-date').textContent)),
    'ogni blocco riporta la propria giornata'
  );
});

test('i weekend diversi non si mescolano', async () => {
  const { ctx, document } = loadApp();
  await ctx.openCamuciaView();

  const container = document.getElementById('camucia-container');

  // Weekend del 3-4 ottobre: solo il Cortona Camucia gioca in casa
  selectWeekend(ctx, '2026-10-03');
  let cards = [...container.querySelectorAll('.match-card')];
  assert.equal(cards.length, 1);
  assert.equal(homeOf(cards[0]), 'Cortona Camucia Calcio');
  assert.equal(container.querySelector('.weekend-heading').textContent, '3–4 ottobre 2026');

  // Weekend del 10-11 ottobre: cinque partite in casa
  selectWeekend(ctx, '2026-10-10');
  cards = [...container.querySelectorAll('.match-card')];
  assert.equal(cards.length, 5);
});

test('il selettore elenca i weekend e l\'opzione "tutti" li mostra tutti', async () => {
  const { ctx, document } = loadApp();
  await ctx.openCamuciaView();

  const select = document.getElementById('select-camucia-weekend');
  const voci = [...select.querySelectorAll('option')].map(o => o.textContent);

  assert.equal(voci[0], 'Tutti i weekend');
  assert.deepEqual(voci.slice(1), ['3–4 ottobre 2026', '10–11 ottobre 2026']);

  // "Tutti i weekend" mostra entrambi, ciascuno con la sua intestazione
  vm.runInContext('camuciaSelectedWeekend = null; renderCamuciaMatches();', ctx);

  const headings = [...document.querySelectorAll('#camucia-container .weekend-heading')].map(h => h.textContent);
  assert.deepEqual(headings, ['3–4 ottobre 2026', '10–11 ottobre 2026']);

  const cards = [...document.querySelectorAll('#camucia-container .match-card')];
  assert.equal(cards.length, 6, '1 partita nel primo weekend + 5 nel secondo');
});
