const test = require('node:test');
const assert = require('node:assert/strict');

const { CalendarScraper } = require('../src/scraper');
const { HttpScrapeError } = require('../src/http-scraper');
const { LEAGUES } = require('../src/config');
const { sampleLeagueData } = require('./fixtures');

const SESSION = {
  tckk: 'AAAA1111',
  roundID: 'TO.P.C',
  totalDays: 30,
  currentDay: 3,
  cookies: 'PHPSESSID=abc; aws-waf-token=xyz',
  userAgent: 'UA-di-prova'
};

const wafError = () => new HttpScrapeError('WAF: HTTP 202', { waf: true });

/**
 * Scraper con percorso HTTP, bootstrap e browser strumentati:
 * nessuna rete, nessuna scrittura su disco.
 */
function instrumentedScraper(mode, httpImpl, bootstrapImpl) {
  const calls = { http: [], browser: 0, bootstrap: 0, persisted: [] };

  const httpScraper = {
    scrapeLeague: async (leagueConfig, options = {}) => {
      calls.http.push({ id: leagueConfig.id, session: options.session || null });
      return httpImpl(leagueConfig, options);
    }
  };

  const scraper = new CalendarScraper({ mode, onProgress: () => {}, httpScraper });

  scraper.browserBootstrap = async (leagueConfig) => {
    calls.bootstrap++;
    if (bootstrapImpl) return bootstrapImpl(leagueConfig);
    return { ...SESSION };
  };

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
  assert.equal(calls.bootstrap, 0, 'nessun bootstrap in modalità http');
  assert.equal(calls.persisted.length, 1, 'i dati devono essere persistiti');
  assert.equal(scraper.getDiagnostics().lastScrapes['promozione-c'].path, 'http');
});

test('modalità browser: non tenta nemmeno la via HTTP', async () => {
  const { scraper, calls } = instrumentedScraper('browser', () => {
    throw new Error('non deve essere chiamato');
  });

  const data = await scraper.scrapeLeagueLive(LEAGUES['seconda-i']);

  assert.equal(data._viaBrowser, true);
  assert.equal(calls.http.length, 0);
  assert.equal(calls.bootstrap, 0);
  assert.equal(calls.browser, 1);
  assert.equal(scraper.getDiagnostics().lastScrapes['seconda-i'].path, 'browser');
});

test('modalità auto: con HTTP funzionante non tocca il browser', async () => {
  const { scraper, calls } = instrumentedScraper('auto', () => ({ ...sampleLeagueData() }));

  await scraper.produceLeagueData(LEAGUES['promozione-c']);

  assert.equal(calls.http.length, 1);
  assert.equal(calls.bootstrap, 0);
  assert.equal(calls.browser, 0);
  assert.equal(scraper.getDiagnostics().lastScrapes['promozione-c'].path, 'http');
});

test('modalità auto: se il WAF blocca, il browser fa solo il bootstrap e i dati arrivano via HTTP', async () => {
  const { scraper, calls } = instrumentedScraper('auto', (leagueConfig, options) => {
    if (!options.session) throw wafError();
    return { ...sampleLeagueData(), id: leagueConfig.id, _afterBootstrap: true };
  });

  const data = await scraper.produceLeagueData(LEAGUES['promozione-c']);

  assert.equal(data._afterBootstrap, true);
  assert.equal(calls.bootstrap, 1, 'un solo bootstrap');
  assert.equal(calls.browser, 0, 'il browser completo non serve');
  assert.equal(calls.http.length, 2, 'prima senza sessione, poi con la sessione');
  assert.equal(calls.http[0].session, null);
  assert.equal(calls.http[1].session.cookies, SESSION.cookies);

  const diagnostics = scraper.getDiagnostics();
  assert.equal(diagnostics.lastScrapes['promozione-c'].path, 'http-after-bootstrap');
  assert.match(diagnostics.lastScrapes['promozione-c'].error, /WAF/);
});

test('modalità auto: se anche il bootstrap non basta si usa il browser completo', async () => {
  const { scraper, calls } = instrumentedScraper('auto', () => {
    throw wafError();
  });

  const data = await scraper.produceLeagueData(LEAGUES['promozione-c']);

  assert.equal(data._viaBrowser, true);
  assert.equal(calls.bootstrap, 1);
  assert.equal(calls.browser, 1);
  assert.equal(scraper.getDiagnostics().lastScrapes['promozione-c'].path, 'browser-fallback');
});

test('modalità auto: se il bootstrap fallisce si usa il browser completo', async () => {
  const { scraper, calls } = instrumentedScraper('auto', () => {
    throw wafError();
  }, () => {
    throw new Error('challenge non risolta');
  });

  const data = await scraper.produceLeagueData(LEAGUES['terza-arezzo']);

  assert.equal(data._viaBrowser, true);
  assert.equal(calls.browser, 1);
  assert.equal(scraper.getDiagnostics().lastScrapes['terza-arezzo'].path, 'browser-fallback');
});

test('modalità http: l\'errore viene propagato senza browser né bootstrap', async () => {
  const { scraper, calls } = instrumentedScraper('http', () => {
    throw wafError();
  });

  await assert.rejects(() => scraper.scrapeLeagueLive(LEAGUES['promozione-c']), /WAF/);
  assert.equal(calls.browser, 0);
  assert.equal(calls.bootstrap, 0);
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
  assert.equal(calls.http[0].session, null, 'la prima chiamata non deve avere una sessione');
  assert.equal(scraper.getDiagnostics().lastScrapes['promozione-c'].path, 'http');
});

test('la diagnostica espone modalità, durata e versione di Node', async () => {
  const { scraper } = instrumentedScraper('http', () => ({ ...sampleLeagueData() }));

  await scraper.produceLeagueData(LEAGUES['promozione-c']);
  const diagnostics = scraper.getDiagnostics();

  assert.equal(diagnostics.mode, 'http');
  assert.equal(diagnostics.node, process.version);
  assert.ok(Number.isFinite(diagnostics.lastScrapes['promozione-c'].durationMs));
  assert.equal(diagnostics.lastScrapes['promozione-c'].error, null);
});

test('le opzioni dello scraper HTTP vengono passate (concurrency, retries)', () => {
  const scraper = new CalendarScraper({
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
