const test = require('node:test');
const assert = require('node:assert/strict');

const { CalendarScraper, describeRegression } = require('../src/scraper');
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

  // L'harness usa dati sintetici: non deve leggere la cache reale del progetto,
  // altrimenti i controlli di regressione confronterebbero dati non omogenei.
  scraper.getCachedLeague = () => null;

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

test('il bootstrap WAF viene condiviso fra i campionati dello stesso run', async () => {
  const { scraper, calls } = instrumentedScraper('auto', (leagueConfig, options) => {
    if (!options.session) throw wafError();
    return { ...sampleLeagueData(), id: leagueConfig.id };
  });

  await scraper.scrapeAll({ forceRefresh: true });

  assert.equal(calls.bootstrap, 1, 'un solo avvio di Chrome per tutti e tre i campionati');
  assert.equal(calls.browser, 0);
  assert.equal(calls.http.length, 6, 'due tentativi HTTP per campionato');
  // Tutte le chiamate con sessione ricevono i cookie del bootstrap
  const withSession = calls.http.filter(c => c.session);
  assert.equal(withSession.length, 3);
  for (const call of withSession) assert.equal(call.session.cookies, SESSION.cookies);

  const paths = Object.values(scraper.getDiagnostics().lastScrapes).map(i => i.path);
  assert.deepEqual(paths, ['http-after-bootstrap', 'http-after-bootstrap', 'http-after-bootstrap']);
});

test('il bootstrap viene interrotto (e Chrome terminato) se non risponde', async () => {
  const scraper = new CalendarScraper({ onProgress: () => {}, bootstrapTimeoutMs: 20 });
  let killed = 0;

  scraper.launchBrowser = async () => ({
    process: () => ({ kill: () => { killed++; } }),
    close: async () => {}
  });
  // Bootstrap che non termina mai: simula Chrome appeso sulla challenge
  scraper.runBrowserBootstrap = () => new Promise(() => {});

  await assert.rejects(
    () => scraper.browserBootstrap(LEAGUES['promozione-c']),
    /non ha completato il bootstrap entro/
  );
  assert.equal(killed, 1, 'il processo Chrome deve essere terminato');
});

test('un bootstrap riuscito chiude Chrome senza intervento del watchdog', async () => {
  const scraper = new CalendarScraper({ onProgress: () => {}, bootstrapTimeoutMs: 5000 });
  let closed = 0;
  let killed = 0;

  scraper.launchBrowser = async () => ({
    process: () => ({ kill: () => { killed++; } }),
    close: async () => { closed++; }
  });
  scraper.runBrowserBootstrap = async () => ({ tckk: 'A', roundID: 'TO.P.C', cookies: 'c=1', userAgent: 'UA' });

  const bootstrapped = await scraper.browserBootstrap(LEAGUES['promozione-c']);

  assert.equal(bootstrapped.tckk, 'A');
  assert.equal(closed, 1, 'Chrome va chiuso normalmente');
  assert.equal(killed, 0, 'il watchdog non deve intervenire');
});

test('la sessione WAF scade e viene rifatta una volta trascorso il TTL', async () => {
  const { scraper, calls } = instrumentedScraper('auto', (leagueConfig, options) => {
    if (!options.session) throw wafError();
    return { ...sampleLeagueData() };
  });
  scraper.wafSessionTtlMs = 0;

  await scraper.produceLeagueData(LEAGUES['promozione-c']);
  await scraper.produceLeagueData(LEAGUES['promozione-c']);

  assert.equal(calls.bootstrap, 2, 'con TTL scaduto serve un nuovo bootstrap');
});

test('la sessione WAF valida non viene rifatta', async () => {
  const { scraper, calls } = instrumentedScraper('auto', (leagueConfig, options) => {
    if (!options.session) throw wafError();
    return { ...sampleLeagueData() };
  });

  await scraper.produceLeagueData(LEAGUES['promozione-c']);
  await scraper.produceLeagueData(LEAGUES['promozione-c']);

  assert.equal(calls.bootstrap, 1);
});

test('due richieste concorrenti condividono un solo bootstrap del browser', async () => {
  const { scraper, calls } = instrumentedScraper('auto', (leagueConfig, options) => {
    if (!options.session) throw wafError();
    return { ...sampleLeagueData(), id: leagueConfig.id };
  });

  // Bootstrap lento: la seconda richiesta deve agganciarsi a quella in corso
  // invece di avviare un secondo Chrome
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowBootstrap = scraper.browserBootstrap;
  scraper.browserBootstrap = async (leagueConfig) => {
    await gate;
    return slowBootstrap(leagueConfig);
  };

  const first = scraper.produceLeagueData(LEAGUES['promozione-c']);
  const second = scraper.produceLeagueData(LEAGUES['seconda-i']);

  release();
  await Promise.all([first, second]);

  assert.equal(calls.bootstrap, 1, 'un solo avvio di Chrome anche con richieste concorrenti');
  assert.equal(calls.http.length, 4, 'due tentativi HTTP per campionato');
});

test('describeRegression riconosce classifica più corta e partite in meno', () => {
  const previous = sampleLeagueData();

  assert.equal(describeRegression(previous, sampleLeagueData()), null, 'dati identici: nessuna regressione');
  assert.equal(describeRegression(null, sampleLeagueData()), null, 'senza dati precedenti non si giudica');

  const shorter = sampleLeagueData();
  shorter.standings = [];
  assert.match(describeRegression(previous, shorter), /classifica più corta/);

  const fewerPlayed = sampleLeagueData();
  fewerPlayed.matchDays[0].matches[0].isPlayed = false;
  assert.match(describeRegression(previous, fewerPlayed), /partite con risultato diminuite/);

  // Una crescita non è una regressione
  const grown = sampleLeagueData();
  grown.standings.push({ position: 2, team: 'Nuova', points: 0 });
  grown.matchDays[1].matches[0].isPlayed = true;
  assert.equal(describeRegression(previous, grown), null);
});

test('i dati in regressione vengono scartati e resta la cache buona', async () => {
  const { scraper, calls } = instrumentedScraper('http', () => {
    const degraded = sampleLeagueData();
    degraded.standings = []; // parsing degradato: nessuna squadra
    return degraded;
  });

  // Cache precedente buona
  const good = { ...sampleLeagueData(), lastUpdated: '2026-09-30T10:00:00.000Z' };
  scraper.getCachedLeague = () => good;

  const data = await scraper.scrapeLeague('promozione-c', { forceRefresh: true });

  assert.equal(calls.persisted.length, 0, 'i dati degradati non devono essere salvati');
  assert.equal(data.isStale, true, 'si ripiega sulla cache');
  assert.ok(data.standings.length > 0, 'i dati restituiti sono quelli buoni');
});

test('i dati sani vengono salvati normalmente', async () => {
  const { scraper, calls } = instrumentedScraper('http', () => ({ ...sampleLeagueData(), lastUpdated: '2026-10-08T10:00:00.000Z' }));

  scraper.getCachedLeague = () => ({ ...sampleLeagueData(), lastUpdated: '2026-09-30T10:00:00.000Z' });
  // La partita della giornata 2 diventa giocata: crescita, non regressione
  const improved = () => {
    const data = sampleLeagueData();
    data.matchDays[1].matches[0].isPlayed = true;
    data.matchDays[1].matches[0].homeScore = 1;
    data.matchDays[1].matches[0].awayScore = 0;
    return data;
  };
  const growth = instrumentedScraper('http', improved);
  growth.scraper.getCachedLeague = () => ({ ...sampleLeagueData(), lastUpdated: '2026-09-30T10:00:00.000Z' });

  const data = await growth.scraper.scrapeLeague('promozione-c', { forceRefresh: true });

  assert.equal(growth.calls.persisted.length, 1, 'i dati sani devono essere salvati');
  assert.equal(data.isStale, undefined);
});
