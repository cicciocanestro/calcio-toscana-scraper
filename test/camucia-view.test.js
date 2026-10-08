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
 */

function match(homeTeam, awayTeam, homeScore = null, awayScore = null) {
  return {
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    isPlayed: homeScore !== null && awayScore !== null,
    status: homeScore === null ? 'SCHEDULED' : 'FINISHED',
    date: '2026-10-04',
    time: '15:30',
    dateTime: '2026-10-04T15:30:00',
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
    currentMatchDay: 1,
    totalMatchDays: 2,
    matchDays: [
      {
        dayNumber: 1, dayTitle: '1° Giornata', dayDate: '04|10|2026',
        matches: [
          match('Cortona Camucia Calcio', 'Acquaviva', 2, 1),
          match('Altra Squadra', 'Terza Squadra'),
          match('Acquaviva', 'Cortona Camucia Calcio') // trasferta: da escludere
        ]
      },
      {
        dayNumber: 2, dayTitle: '2° Giornata', dayDate: '11|10|2026',
        matches: [match('Cortona Camucia Calcio', 'Resco Reggello')]
      }
    ]
  },
  'seconda-i': {
    id: 'seconda-i',
    name: 'Seconda Categoria Toscana - Girone I',
    shortName: 'Seconda Cat. I',
    currentMatchDay: 1,
    totalMatchDays: 1,
    matchDays: [
      {
        dayNumber: 1, dayTitle: '1° Giornata', dayDate: '04|10|2026',
        matches: [
          match('Fratta Santa Caterina', 'Poppi'),
          match('Fratticciola', 'Bucine'),
          match('Bucine', 'Fratticciola') // trasferta
        ]
      }
    ]
  },
  'terza-arezzo': {
    id: 'terza-arezzo',
    name: 'Terza Categoria Arezzo - Girone Unico',
    shortName: 'Terza Cat. Arezzo',
    currentMatchDay: 1,
    totalMatchDays: 1,
    matchDays: [
      {
        dayNumber: 1, dayTitle: '1° Giornata', dayDate: '04|10|2026',
        matches: [
          match('Montecchio', 'Tuscar'),
          match('Monsigliolo', 'Badia Agnano'),
          match('Terontola', 'Montecchio') // trasferta
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

test('la scheda CC Camucia è collegata al pannello giusto', () => {
  const { document } = loadApp();

  const button = [...document.querySelectorAll('.sub-nav-btn')]
    .find(b => b.getAttribute('data-view') === 'camucia');

  assert.ok(button, 'esiste il pulsante nella sotto-navigazione');
  assert.match(button.textContent, /CC Camucia/);
  assert.ok(document.getElementById('view-camucia'), 'esiste il pannello della vista');
  assert.ok(document.getElementById('select-camucia-day'), 'esiste il selettore di giornata');

  // Deve restare l'ultima voce, dopo Esportazioni
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

test('collectCamuciaHomeMatches tiene solo le partite in casa, filtrabili per giornata', () => {
  const { ctx } = loadApp();

  const tutte = ctx.collectCamuciaHomeMatches(DATA['promozione-c'], null);
  // Lo spread riporta l'array nel realm del test (deepStrictEqual confronta i prototipi)
  assert.deepEqual([...tutte].map(x => x.match.homeTeam), ['Cortona Camucia Calcio', 'Cortona Camucia Calcio']);
  assert.ok(tutte.every(x => x.match.awayTeam !== 'Cortona Camucia Calcio'), 'nessuna trasferta');

  const prima = ctx.collectCamuciaHomeMatches(DATA['promozione-c'], 1);
  assert.equal(prima.length, 1);
  assert.equal(prima[0].match.awayTeam, 'Acquaviva');
});

test('la scheda aggrega i tre campionati e mostra una partita per squadra', async () => {
  const { ctx, document } = loadApp();

  await ctx.openCamuciaView();

  const container = document.getElementById('camucia-container');
  const cards = [...container.querySelectorAll('.match-card')];

  assert.deepEqual(
    cards.map(homeOf).sort(),
    ['Cortona Camucia Calcio', 'Fratta Santa Caterina', 'Fratticciola', 'Montecchio', 'Monsigliolo'].sort(),
    'una partita in casa per ognuna delle cinque squadre'
  );

  assert.ok(
    !cards.some(c => ctx.isCamuciaTeam(awayOf(c))),
    'le partite in trasferta non devono comparire'
  );

  // Un blocco per campionato, con il nome della competizione
  const etichette = [...container.querySelectorAll('.matchday-block .matchday-date')].map(e => e.textContent);
  assert.equal(etichette.length, 3);
  for (const frammento of ['Promozione C', 'Seconda Cat. I', 'Terza Cat. Arezzo']) {
    assert.ok(etichette.some(t => t.includes(frammento)), `manca il blocco di ${frammento}`);
  }
});

test('il selettore di giornata limita le partite mostrate', async () => {
  const { ctx, document } = loadApp();
  await ctx.openCamuciaView();

  // La giornata 2 esiste solo in Promozione, con una sola partita in casa
  vm.runInContext('camuciaSelectedDay = 2; renderCamuciaMatches();', ctx);

  const cards = [...document.querySelectorAll('#camucia-container .match-card')];
  assert.equal(cards.length, 1);
  assert.equal(homeOf(cards[0]), 'Cortona Camucia Calcio');
});
