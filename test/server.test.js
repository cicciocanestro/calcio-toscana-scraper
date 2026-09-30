const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../src/server');
const { CalendarScraper } = require('../src/scraper');
const { sampleLeagueData } = require('./fixtures');

// Scraper finto: permette di testare le rotte (token, revalidation) senza
// browser né rete.
function fakeScraper(options = {}) {
  const calls = [];
  return {
    calls,
    getCacheStatus: () => options.status || { exists: true, isStale: true, ageMs: 99999999, lastUpdated: '2026-01-01T00:00:00.000Z' },
    getCachedLeague: () => sampleLeagueData(),
    scrapeLeague: async (id, opts = {}) => {
      calls.push({ id, opts });
      return { ...sampleLeagueData(), id, isStale: !opts.forceRefresh };
    }
  };
}

// autoRevalidate: false -> i test non avviano mai scraping/browser in background
function withServer(run, options = {}) {
  return async () => {
    const app = createServer({ autoRevalidate: false, ...options });
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await run(base);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

test('la dashboard viene servita da public/', withServer(async (base) => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /app\.js/);

  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
}));

test('i file interni del progetto NON sono esposti staticamente', withServer(async (base) => {
  for (const path of ['/package.json', '/package-lock.json', '/src/server.js', '/src/config.js', '/bin/cli.js', '/Dockerfile', '/.git/config']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `${path} non deve essere raggiungibile (status ${res.status})`);
  }
}));

test('i dati di cache ed export restano raggiungibili sotto /data', withServer(async (base) => {
  const cache = await fetch(`${base}/data/cache/promozione-c.json`);
  assert.equal(cache.status, 200);
  const payload = await cache.json();
  assert.equal(payload.id, 'promozione-c');
  assert.ok(Array.isArray(payload.standings));

  const ics = await fetch(`${base}/data/exports/promozione-c.ics`);
  assert.equal(ics.status, 200);
  assert.match(await ics.text(), /BEGIN:VCALENDAR/);
}));

test('GET /api/leagues riporta stato cache e metadati', withServer(async (base) => {
  const res = await fetch(`${base}/api/leagues`);
  assert.equal(res.status, 200);

  const list = await res.json();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(l => l.id), ['promozione-c', 'seconda-i', 'terza-arezzo']);

  for (const league of list) {
    assert.equal(league.isCached, true, `${league.id} dovrebbe essere in cache`);
    assert.equal(typeof league.isStale, 'boolean');
    assert.ok(league.teamsCount > 0);
    assert.ok(league.lastUpdated);
  }
}));

test('GET /api/leagues/:id risponde dalla cache senza scraping', withServer(async (base) => {
  const res = await fetch(`${base}/api/leagues/seconda-i`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.id, 'seconda-i');
  assert.ok(data.standings.length > 0);
  assert.ok(data.matchDays.length > 0);
}));

test('id o formato non validi non provocano scraping', withServer(async (base) => {
  assert.equal((await fetch(`${base}/api/leagues/non-esiste`)).status, 404);
  assert.equal((await fetch(`${base}/api/leagues/seconda-i/export/pdf`)).status, 400);
  assert.equal((await fetch(`${base}/api/leagues/non-esiste/export/ics`)).status, 404);
}));

test('il costruttore dello scraper non cerca Chrome (ricerca lazy)', () => {
  const scraper = new CalendarScraper();
  assert.equal(scraper.chromePath, null, 'nessun browser deve essere risolto nel costruttore');

  // Un percorso esplicito viene usato così com\'è, senza verifiche all\'avvio
  const custom = new CalendarScraper({ chromePath: '/finto/chrome' });
  assert.equal(custom.resolveChromePath(), '/finto/chrome');

  // createServer() non deve dipendere dalla presenza di un browser
  assert.doesNotThrow(() => createServer({ autoRevalidate: false }));
});

test('se lo scraping fallisce si usa la cache scaduta invece di propagare l\'errore', async () => {
  const scraper = new CalendarScraper({ onProgress: () => {} });
  scraper.scrapeLeagueLive = async () => {
    throw new Error('bloccato dal WAF');
  };

  const data = await scraper.scrapeLeague('promozione-c', { forceRefresh: true });

  assert.equal(data.isStale, true);
  assert.equal(data.id, 'promozione-c');
  assert.ok(data.standings.length > 0);
  assert.ok(data.matchDays.length > 0);
});

test('cacheFirst non avvia mai lo scraping', async () => {
  let liveCalls = 0;
  const scraper = new CalendarScraper({ onProgress: () => {} });
  scraper.scrapeLeagueLive = async () => {
    liveCalls += 1;
    throw new Error('non deve essere chiamato');
  };

  const data = await scraper.scrapeLeague('promozione-c', { cacheFirst: true });

  assert.equal(liveCalls, 0);
  assert.equal(data.id, 'promozione-c');
  assert.ok(data.standings.length > 0);
});

test('getCacheStatus riporta correttamente cache assente e presente', () => {
  const scraper = new CalendarScraper({ onProgress: () => {} });

  assert.deepEqual(scraper.getCacheStatus('non-esiste'), {
    exists: false,
    isStale: false,
    ageMs: null,
    lastUpdated: null
  });

  const status = scraper.getCacheStatus('promozione-c');
  assert.equal(status.exists, true);
  assert.equal(typeof status.ageMs, 'number');
  assert.equal(typeof status.isStale, 'boolean');
  assert.ok(status.lastUpdated);
});

test('con REFRESH_TOKEN attivo l\'aggiornamento forzato richiede il token', async () => {
  const previous = process.env.REFRESH_TOKEN;
  process.env.REFRESH_TOKEN = 'segreto-di-test';

  const scraper = fakeScraper();
  const app = createServer({ autoRevalidate: false, scraper });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Scraping forzato senza token -> rifiutato
    assert.equal((await fetch(`${base}/api/leagues/promozione-c?refresh=true`)).status, 401);
    assert.equal((await fetch(`${base}/api/leagues/promozione-c/refresh`, { method: 'POST' })).status, 401);

    // Token sbagliato -> rifiutato
    assert.equal(
      (await fetch(`${base}/api/leagues/promozione-c?refresh=true`, { headers: { 'x-refresh-token': 'nope' } })).status,
      401
    );

    // Nessuno scraping forzato deve essere partito
    assert.equal(scraper.calls.filter(c => c.opts.forceRefresh).length, 0);

    // Lettura normale dalla cache: sempre permessa
    assert.equal((await fetch(`${base}/api/leagues/promozione-c`)).status, 200);

    // Con il token corretto lo scraping forzato viene eseguito
    const ok = await fetch(`${base}/api/leagues/promozione-c?refresh=true`, { headers: { 'x-refresh-token': 'segreto-di-test' } });
    assert.equal(ok.status, 200);
    const forced = scraper.calls.filter(c => c.opts.forceRefresh);
    assert.equal(forced.length, 1);
    assert.equal(forced[0].id, 'promozione-c');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.REFRESH_TOKEN;
    else process.env.REFRESH_TOKEN = previous;
  }
});

test('con cache scaduta la risposta è immediata e parte l\'aggiornamento in background', async () => {
  const scraper = fakeScraper();
  const app = createServer({ scraper }); // autoRevalidate attivo (default)
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/leagues/promozione-c`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).isStale, true, 'la prima risposta usa la cache scaduta');

    // Lascia partire la promise di revalidation in background
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 20));

    const forced = scraper.calls.filter(c => c.opts.forceRefresh);
    assert.equal(forced.length, 1, 'deve partire un aggiornamento in background');
    assert.equal(forced[0].id, 'promozione-c');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('le richieste di revalidation dello stesso campionato non si duplicano', async () => {
  let resolveScrape;
  const started = new Promise(resolve => { resolveScrape = resolve; });
  const scraper = fakeScraper();
  const originalScrape = scraper.scrapeLeague;
  scraper.scrapeLeague = async (id, opts) => {
    resolveScrape();
    await new Promise(resolve => setTimeout(resolve, 30));
    return originalScrape(id, opts);
  };

  const app = createServer({ scraper });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await Promise.all([
      fetch(`${base}/api/leagues/promozione-c`),
      fetch(`${base}/api/leagues/promozione-c`),
      fetch(`${base}/api/leagues/promozione-c`)
    ]);

    await started;
    await new Promise(resolve => setTimeout(resolve, 60));

    const forced = scraper.calls.filter(c => c.opts.forceRefresh);
    assert.equal(forced.length, 1, 'un solo scraping per campionato anche con più richieste');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});


test('GET /api/diagnostics riporta modalità, commit e stato cache', withServer(async (base) => {
  const res = await fetch(`${base}/api/diagnostics`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.service, 'calcio-toscana-scraper');
  assert.equal(body.mode, 'auto');
  assert.ok(Array.isArray(body.cache) && body.cache.length === 3);
  assert.ok(body.cache.every(c => typeof c.exists === 'boolean'));
}));
