const test = require('node:test');
const assert = require('node:assert/strict');

const { CalendarScraper } = require('../src/scraper');
const { HttpScrapeError } = require('../src/http-scraper');
const { LEAGUES } = require('../src/config');
const { sampleLeagueData } = require('./fixtures');

/**
 * Scraper con percorso HTTP e browser strumentati: nessuna rete, nessuna
 * scrittura su disco.
 */
function instrumentedScraper(mode, httpImpl) {
  const calls = { http: [], browser: 0, persisted: [] };

  const httpScraper = {
    scrapeLeague: async (leagueConfig, options) => {
      calls.http.push({ id: leagueConfig.id, options });
      return httpImpl(leagueConfig, options);
    }
  };

  const scraper = new CalendarScraper({ mode, onProgress: () => {}, httpScraper });
  scraper.scrapeLeagueWithBrowser = async (leagueConfig) => {
    calls.browser++;
    return { ...sampleLeagueData(), id: leagueConfig.id, _viaBrowser: true };
  };
  scraper.persistLeagueData = (leagueConfig, data) => {
    calls.persisted.push({ id: leagueConfig.id, data });
    return data;
  };

  return { scraper, calls };
}

test('modalità http: usa solo richieste HTTP e salva i dati', async () => {
  const { scraper, calls } = instrumentedScraper('http', () => ({ ...sampleLeagueData(), _viaHttp: true }));

  const data = await scraper.scrapeLeagueLive(LEAGUES['promozione-c']);

  assert.equal(data._viaHttp, true);
  assert.equal(calls.http.length, 1);
  assert.equal(calls.browser, 0, 'il browser non deve essere usato');
  assert.equal(calls.persisted.length, 1, 'i dati devono essere persistiti');
  assert.equal(calls.persisted[0].data._viaHttp, true);
});

test('modalità browser: non tenta nemmeno la via HTTP', async () => {
  const { scraper, calls } = instrumentedScraper('browser', () => {
    throw new Error('non deve essere chiamato');
  });

  const data = await scraper.scrapeLeagueLive(LEAGUES['seconda-i']);

  assert.equal(data._viaBrowser, true);
  assert.equal(calls.http.length, 0);
  assert.equal(calls.browser, 1);
});

test('modalità auto: se HTTP fallisce si ripiega sul browser', async () => {
  const { scraper, calls } = instrumentedScraper('auto', () => {
    throw new HttpScrapeError('WAF: HTTP 403', { waf: true });
  });

  const data = await scraper.scrapeLeagueLive(LEAGUES['promozione-c']);

  assert.equal(data._viaBrowser, true);
  assert.equal(calls.http.length, 1);
  assert.equal(calls.browser, 1, 'il browser deve essere usato come riserva');
  assert.equal(calls.persisted.length, 1, 'vengono persistiti i dati del browser');
  assert.equal(calls.persisted[0].data._viaBrowser, true);
});

test('modalità auto: anche un errore non-WAF fa scattare il fallback', async () => {
  const { scraper, calls } = instrumentedScraper('auto', () => {
    throw new Error('fetch failed');
  });

  const data = await scraper.scrapeLeagueLive(LEAGUES['terza-arezzo']);

  assert.equal(data._viaBrowser, true);
  assert.equal(calls.browser, 1);
});

test('modalità http: l\'errore viene propagato senza usare il browser', async () => {
  const { scraper, calls } = instrumentedScraper('http', () => {
    throw new HttpScrapeError('WAF: HTTP 403', { waf: true });
  });

  await assert.rejects(() => scraper.scrapeLeagueLive(LEAGUES['promozione-c']), /WAF/);
  assert.equal(calls.browser, 0);
  assert.equal(calls.persisted.length, 0);
});

test('una modalità non valida ricade su auto', () => {
  assert.equal(new CalendarScraper({ mode: 'pippo' }).mode, 'auto');
  assert.equal(new CalendarScraper({ mode: 'http' }).mode, 'http');
  assert.equal(new CalendarScraper({ mode: 'browser' }).mode, 'browser');
  assert.equal(new CalendarScraper().mode, 'auto');
});

test('la modalità può arrivare dalla variabile d\'ambiente SCRAPER_MODE', () => {
  const previous = process.env.SCRAPER_MODE;
  try {
    process.env.SCRAPER_MODE = 'browser';
    assert.equal(new CalendarScraper().mode, 'browser');

    // L'opzione esplicita ha la precedenza sull'ambiente
    assert.equal(new CalendarScraper({ mode: 'http' }).mode, 'http');
  } finally {
    if (previous === undefined) delete process.env.SCRAPER_MODE;
    else process.env.SCRAPER_MODE = previous;
  }
});

test('scrapeLeague fornisce allo scraper HTTP i dati precedenti dalla cache', async () => {
  const { scraper, calls } = instrumentedScraper('http', () => ({ ...sampleLeagueData() }));

  // forceRefresh evita la scorciatoia della cache ma i dati precedenti
  // vengono comunque letti e passati per i controlli di regressione
  await scraper.scrapeLeague('promozione-c', { forceRefresh: true });

  assert.equal(calls.http.length, 1);
  const previous = calls.http[0].options.previousData;
  assert.ok(previous, 'previousData deve essere presente');
  assert.ok(Array.isArray(previous.standings) && previous.standings.length > 0);
  assert.ok(Array.isArray(previous.matchDays) && previous.matchDays.length > 0);
});

test('le opzioni dello scraper HTTP vengono passate (onProgress, concurrency)', () => {
  const progress = () => {};
  const scraper = new CalendarScraper({
    onProgress: progress,
    httpOptions: { concurrency: 8, retries: 2 }
  });

  assert.equal(scraper.httpOptions.concurrency, 8);
  assert.equal(scraper.httpOptions.retries, 2);
  assert.equal(scraper.userDataDir, undefined);
});

test('userDataDir può essere forzato da opzione o variabile d\'ambiente', () => {
  const previous = process.env.CHROME_USER_DATA_DIR;
  try {
    assert.equal(new CalendarScraper({ userDataDir: '/tmp/profilo' }).userDataDir, '/tmp/profilo');

    process.env.CHROME_USER_DATA_DIR = '/tmp/da-env';
    assert.equal(new CalendarScraper().userDataDir, '/tmp/da-env');
  } finally {
    if (previous === undefined) delete process.env.CHROME_USER_DATA_DIR;
    else process.env.CHROME_USER_DATA_DIR = previous;
  }
});

test('la diagnostica registra quale percorso ha prodotto i dati', async () => {
  const viaHttp = instrumentedScraper('http', () => ({ ...sampleLeagueData() }));
  await viaHttp.scraper.produceLeagueData(LEAGUES['promozione-c']);
  let last = viaHttp.scraper.getDiagnostics().lastScrapes['promozione-c'];
  assert.equal(last.path, 'http');
  assert.ok(Number.isFinite(last.durationMs));
  assert.equal(last.error, null);

  const fallback = instrumentedScraper('auto', () => {
    throw new HttpScrapeError('WAF: HTTP 403', { waf: true });
  });
  await fallback.scraper.produceLeagueData(LEAGUES['promozione-c']);
  last = fallback.scraper.getDiagnostics().lastScrapes['promozione-c'];
  assert.equal(last.path, 'browser-fallback');
  assert.match(last.error, /WAF/);

  const forced = instrumentedScraper('browser', () => ({}));
  await forced.scraper.produceLeagueData(LEAGUES['promozione-c']);
  assert.equal(forced.scraper.getDiagnostics().lastScrapes['promozione-c'].path, 'browser');

  const diagnostics = forced.scraper.getDiagnostics();
  assert.equal(diagnostics.mode, 'browser');
  assert.equal(diagnostics.node, process.version);
});
