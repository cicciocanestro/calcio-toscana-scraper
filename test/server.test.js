const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, normalizeTeamParam, safeTokenEquals, createRateLimiter } = require('../src/server');
const { CalendarScraper } = require('../src/scraper');
const { LEAGUES, EXPORT_DIR } = require('../src/config');
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

test('normalizeTeamParam riduce un array a una stringa e limita la lunghezza', () => {
  assert.equal(normalizeTeamParam(undefined), null);
  assert.equal(normalizeTeamParam(''), null);
  assert.equal(normalizeTeamParam('   '), null);
  assert.equal(normalizeTeamParam('Arezzo FA'), 'Arezzo FA');
  assert.equal(normalizeTeamParam('  Lebowski  '), 'Lebowski');
  // Express passa ?team=a&team=b come array
  assert.equal(normalizeTeamParam(['primo', 'secondo']), 'primo');
  assert.equal(normalizeTeamParam('x'.repeat(500)).length, 100);
});

test('un filtro squadra passato come array non provoca più un 500', withServer(async (base) => {
  // Regressione: options.team.toLowerCase su un array lanciava un TypeError
  const res = await fetch(`${base}/api/leagues/promozione-c/export/csv?team=lebowski&team=altro`);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);

  const body = await res.text();
  assert.match(body, /Centro Storico Lebowski/);
  assert.doesNotMatch(body, /Acquaviva vs/);
}));

test('gli export rispondono con il contenuto giusto e senza file temporanei', async () => {
  const before = fs.readdirSync(EXPORT_DIR).sort();

  await withServer(async (base) => {
    const json = await fetch(`${base}/api/leagues/promozione-c/export/json`);
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /application\/json/);
    assert.equal((await json.json()).id, 'promozione-c');

    const csv = await fetch(`${base}/api/leagues/promozione-c/export/csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="promozione-c\.csv"/);
    assert.match(await csv.text(), /Campionato;Categoria;Girone/);

    const ics = await fetch(`${base}/api/leagues/promozione-c/export/ics`);
    assert.equal(ics.status, 200);
    assert.match(ics.headers.get('content-type'), /text\/calendar/);
    const icsBody = await ics.text();
    assert.match(icsBody, /BEGIN:VCALENDAR/);
    assert.match(icsBody, /BEGIN:VTIMEZONE/);
    assert.equal(
      icsBody.split('\r\n').filter(l => Buffer.byteLength(l, 'utf-8') > 75).length,
      0,
      'nessuna riga oltre i 75 ottetti'
    );
  })();

  assert.deepEqual(
    fs.readdirSync(EXPORT_DIR).sort(),
    before,
    'gli export HTTP non devono scrivere in data/exports'
  );
});

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

test('la scadenza della cache si basa su lastUpdated, non sull\'mtime del file', () => {
  // Regressione: un `git clone` (build di Render, checkout della CI) riscrive
  // gli mtime a "adesso". Se la scadenza dipendesse dall'mtime, dopo ogni
  // deploy la cache committata sembrerebbe fresca per tutto il TTL.
  const league = LEAGUES['promozione-c'];
  const originalCacheFile = league.cacheFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-age-'));
  const file = path.join(dir, 'promozione-c.json');

  try {
    const scraper = new CalendarScraper({ onProgress: () => {} });

    // Dati vecchi di 10 ore, ma file appena scritto (mtime = adesso)
    const old = { ...sampleLeagueData(), lastUpdated: new Date(Date.now() - 10 * 3600 * 1000).toISOString() };
    fs.writeFileSync(file, JSON.stringify(old));
    league.cacheFile = file;

    const oldStatus = scraper.getCacheStatus('promozione-c');
    assert.equal(oldStatus.exists, true);
    assert.equal(oldStatus.isStale, true, 'dati vecchi con mtime fresco devono risultare scaduti');
    assert.equal(oldStatus.lastUpdated, old.lastUpdated, 'lastUpdated deve venire dai dati, non dall\'mtime');
    assert.ok(oldStatus.ageMs > 9 * 3600 * 1000);
    assert.equal(scraper.getCachedLeague('promozione-c'), null, 'il TTL deve scartare i dati vecchi');

    // Dati freschi, ma file con mtime di 10 ore fa: non deve risultare scaduto
    const fresh = { ...sampleLeagueData(), lastUpdated: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(fresh));
    const past = new Date(Date.now() - 10 * 3600 * 1000);
    fs.utimesSync(file, past, past);

    const freshStatus = scraper.getCacheStatus('promozione-c');
    assert.equal(freshStatus.isStale, false, 'un mtime vecchio non deve scadere dati freschi');
    assert.ok(scraper.getCachedLeague('promozione-c'), 'i dati freschi devono restare disponibili');
  } finally {
    league.cacheFile = originalCacheFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    assert.equal((await fetch(`${base}/api/leagues/refresh-all`, { method: 'POST' })).status, 401);

    // Token sbagliato -> rifiutato
    assert.equal(
      (await fetch(`${base}/api/leagues/promozione-c?refresh=true`, { headers: { 'x-refresh-token': 'nope' } })).status,
      401
    );
    assert.equal(
      (await fetch(`${base}/api/leagues/refresh-all`, { method: 'POST', headers: { 'x-refresh-token': 'nope' } })).status,
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

test('GET /api/diagnostics espone lo stato della pubblicazione su GitHub', withServer(async (base) => {
  const body = await (await fetch(`${base}/api/diagnostics`)).json();

  assert.equal(typeof body.github.publishConfigured, 'boolean');
  assert.ok('repo' in body.github && 'branch' in body.github && 'tokenFrom' in body.github);
  assert.ok(!('token' in body.github), 'il token non deve essere esposto');
}));

test('GET /api/health è un health check leggero', withServer(async (base) => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptime, 'number');
}));

test('un refresh manuale chiede al workflow GitHub di pubblicare i dati', () => {
  const dispatched = [];
  let notify;
  const once = new Promise(resolve => { notify = resolve; });

  return withServer(async (base) => {
    const res = await fetch(`${base}/api/leagues/refresh-all`, { method: 'POST' });
    assert.equal(res.status, 202, 'la risposta al client resta immediata');

    await once;
    assert.equal(dispatched.length, 1, 'una sola richiesta di pubblicazione per refresh');
    assert.match(dispatched[0], /tutti i campionati/);
  }, {
    scraper: fakeScraper(),
    dispatchUpdate: async (reason) => { dispatched.push(reason); notify(); return { dispatched: true }; }
  })();
});

test('il refresh manuale di un singolo campionato avvia il workflow', () => {
  const dispatched = [];

  return withServer(async (base) => {
    const res = await fetch(`${base}/api/leagues/promozione-c/refresh?sync=true`, { method: 'POST' });
    assert.equal(res.status, 200);

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0], /promozione-c/);
  }, {
    scraper: fakeScraper(),
    dispatchUpdate: async (reason) => { dispatched.push(reason); }
  })();
});

test('lo scraping forzato via GET (percorso della CI) non avvia il workflow', () => {
  const dispatched = [];

  return withServer(async (base) => {
    const res = await fetch(`${base}/api/leagues/promozione-c?refresh=true`);
    assert.equal(res.status, 200);

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(dispatched.length, 0, 'la CI non deve innescare il workflow: si creerebbe un ciclo');
  }, {
    scraper: fakeScraper(),
    dispatchUpdate: async (reason) => { dispatched.push(reason); }
  })();
});

test('safeTokenEquals confronta i token a tempo costante', () => {
  assert.equal(safeTokenEquals('segreto-di-test', 'segreto-di-test'), true);
  assert.equal(safeTokenEquals('segreto-di-test', 'segreto-di-tes7'), false);
  assert.equal(safeTokenEquals('corto', 'molto piu lungo'), false);
  assert.equal(safeTokenEquals(undefined, 'segreto'), false);
  assert.equal(safeTokenEquals('', 'segreto'), false);
  assert.equal(safeTokenEquals('', ''), true);
});

test('createRateLimiter blocca oltre la soglia e isola gli IP', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2 });

  const statuses = [];
  const makeRes = () => ({
    setHeader: () => {},
    status(code) { this.code = code; return this; },
    json() { statuses.push(this.code); return this; }
  });

  let passed = 0;
  const next = () => { passed++; };

  limiter({ ip: '10.0.0.1' }, makeRes(), next);
  limiter({ ip: '10.0.0.1' }, makeRes(), next);
  limiter({ ip: '10.0.0.1' }, makeRes(), next); // oltre la soglia

  assert.equal(passed, 2, 'solo le prime due passano');
  assert.deepEqual(statuses, [429]);

  // Un IP diverso non è penalizzato
  limiter({ ip: '10.0.0.2' }, makeRes(), next);
  assert.equal(passed, 3);
});

test('l\'export è protetto dal rate limit', async () => {
  const app = createServer({
    autoRevalidate: false,
    scraper: fakeScraper(),
    exportRateLimit: { windowMs: 60000, max: 2 }
  });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const first = await fetch(`${base}/api/leagues/promozione-c/export/json`);
    const second = await fetch(`${base}/api/leagues/promozione-c/export/json`);
    const third = await fetch(`${base}/api/leagues/promozione-c/export/json`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429, 'oltre la soglia deve rispondere 429');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
