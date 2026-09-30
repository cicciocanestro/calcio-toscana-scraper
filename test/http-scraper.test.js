const test = require('node:test');
const assert = require('node:assert/strict');

const { HttpScraper, HttpScrapeError, extractSessionTokens, readPageVariable, looksLikeWaf } = require('../src/http-scraper');
const { LEAGUES } = require('../src/config');
const { STANDINGS_HTML, MATCHDAY_HTML } = require('./fixtures');

const LEAGUE = LEAGUES['promozione-c'];

// Pagina dei risultati con i token di sessione, come sul sito reale
const LEAGUE_PAGE = `<!DOCTYPE html><html><head><title>Risultati</title>
<script>
  var tckk = 'AAAA1111BBBB2222';
  var roundID = 'TO.P.C';
  var matchesNumber = '2';
  var currentMatchDay = '1';
</script></head><body>ok</body></html>`;

const WAF_PAGE = '<!DOCTYPE html><html><head><script src="/.well-known/aws-waf/js/AwsWafIntegration.js"></script>' +
  '<div id="challenge-container"></div></head><body>Verifica in corso</body></html>';

/**
 * fetch finto: instrada per URL e registra le chiamate.
 * routes(url) -> { status, body, headers } | null (404)
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: { ...(init.headers || {}) } });
    const route = routes(target, calls.length);
    if (!route) return new Response('non trovato', { status: 404 });
    return new Response(route.body, {
      status: route.status || 200,
      headers: route.headers || { 'content-type': 'text/html; charset=utf-8' }
    });
  };
  impl.calls = calls;
  return impl;
}

function standardRoutes() {
  return (url) => {
    if (url === LEAGUE.url) {
      return { body: LEAGUE_PAGE, headers: { 'set-cookie': 'PHPSESSID=abc123; path=/; HttpOnly' } };
    }
    if (url.includes('RankingView.php')) return { body: STANDINGS_HTML };
    if (url.includes('ResultsView.php')) {
      const day = parseInt(url.match(/match_day_id=(\d+)/)[1], 10);
      return { body: MATCHDAY_HTML.replace(/4° Giornata/, `${day}° Giornata`) };
    }
    return null;
  };
}

const validMatches = (day) => (day.matches || []).filter(m => m.homeTeam && m.awayTeam);

test('readPageVariable legge variabili con apici, doppi apici e senza apici', () => {
  const html = "var tckk = 'abc'; let roundID = \"TO.P.C\"; matchesNumber = 30; currentMatchDay='3'";
  assert.equal(readPageVariable(html, 'tckk'), 'abc');
  assert.equal(readPageVariable(html, 'roundID'), 'TO.P.C');
  assert.equal(readPageVariable(html, 'matchesNumber'), '30');
  assert.equal(readPageVariable(html, 'currentMatchDay'), '3');
  assert.equal(readPageVariable(html, 'inesistente'), null);
});

test('extractSessionTokens restituisce null senza token', () => {
  assert.equal(extractSessionTokens('<html>Solo una pagina normale</html>'), null);
  const tokens = extractSessionTokens(LEAGUE_PAGE);
  assert.equal(tokens.tckk, 'AAAA1111BBBB2222');
  assert.equal(tokens.roundID, 'TO.P.C');
  assert.equal(tokens.totalDays, 2);
  assert.equal(tokens.currentDay, 1);
});

test('looksLikeWaf riconosce status e marcatori di challenge', () => {
  const headers = new Headers();
  assert.equal(looksLikeWaf(403, headers, ''), true);
  assert.equal(looksLikeWaf(429, headers, ''), true);
  assert.equal(looksLikeWaf(200, headers, WAF_PAGE), true);
  assert.equal(looksLikeWaf(200, headers, '<html>tutto ok</html>'), false);

  const challenge = new Headers({ 'x-amzn-waf-action': 'challenge' });
  assert.equal(looksLikeWaf(202, challenge, ''), true);
});

test('scrapeLeague via HTTP produce i dati completi e mantiene i cookie di sessione', async () => {
  const fetchImpl = fakeFetch(standardRoutes());
  const scraper = new HttpScraper({ fetch: fetchImpl, onProgress: () => {} });

  const data = await scraper.scrapeLeague(LEAGUE);

  assert.equal(data.id, 'promozione-c');
  assert.equal(data.name, LEAGUE.name);
  assert.equal(data.roundID, 'TO.P.C');
  assert.equal(data.totalMatchDays, 2);
  assert.equal(data.currentMatchDay, 1);
  assert.equal(data.standings.length, 4);
  assert.equal(data.matchDays.length, 2);
  assert.deepEqual(data.matchDays.map(d => d.dayNumber), [1, 2]);
  assert.ok(data.lastUpdated);
  assert.ok(data.matchDays[0].matches.length > 0);

  // 1 pagina + 1 classifica + 2 giornate
  assert.equal(fetchImpl.calls.length, 4);

  // Le richieste AJAX usano il cookie di sessione e l'header XHR
  const ajax = fetchImpl.calls.slice(1);
  for (const call of ajax) {
    assert.match(call.headers.cookie || '', /PHPSESSID=abc123/);
    assert.equal(call.headers['x-requested-with'], 'XMLHttpRequest');
  }
  assert.equal(fetchImpl.calls[0].headers.cookie, undefined, 'la prima richiesta non ha ancora cookie');
});

test('scrapeLeague lancia un errore WAF su 403', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 403, body: 'Forbidden' }));
  const scraper = new HttpScraper({ fetch: fetchImpl, retries: 3, retryDelayMs: 1 });

  await assert.rejects(
    () => scraper.scrapeLeague(LEAGUE),
    (err) => {
      assert.ok(err instanceof HttpScrapeError);
      assert.equal(err.waf, true);
      return true;
    }
  );
  // Il WAF non viene ritentato: una sola chiamata
  assert.equal(fetchImpl.calls.length, 1);
});

test('scrapeLeague riconosce una challenge WAF servita con status 200', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: WAF_PAGE }));
  const scraper = new HttpScraper({ fetch: fetchImpl, retries: 2, retryDelayMs: 1 });

  await assert.rejects(() => scraper.scrapeLeague(LEAGUE), /WAF/);
});

test('una pagina 200 senza token viene segnalata come possibile challenge', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: '<html><body>pagina vuota</body></html>' }));
  const scraper = new HttpScraper({ fetch: fetchImpl, onProgress: () => {} });

  await assert.rejects(
    () => scraper.scrapeLeague(LEAGUE),
    (err) => {
      assert.equal(err.waf, true);
      return true;
    }
  );
});

test('gli errori temporanei (5xx) vengono ritentati e poi riescono', async () => {
  let rankingCalls = 0;
  const base = standardRoutes();
  const fetchImpl = fakeFetch((url, n) => {
    if (url.includes('RankingView.php')) {
      rankingCalls++;
      if (rankingCalls === 1) return { status: 503, body: 'Service Unavailable' };
    }
    return base(url, n);
  });

  const scraper = new HttpScraper({ fetch: fetchImpl, retries: 3, retryDelayMs: 1, onProgress: () => {} });
  const data = await scraper.scrapeLeague(LEAGUE);

  assert.equal(rankingCalls, 2, 'la classifica deve essere richiesta due volte');
  assert.equal(data.standings.length, 4);
});

test('una giornata vuota viene ritentata e, se in cache aveva partite, fa scattare il fallback', async () => {
  const base = standardRoutes();
  let emptyCalls = 0;
  const fetchImpl = fakeFetch((url, n) => {
    if (url.includes('match_day_id=2')) {
      emptyCalls++;
      return { body: '<table class="table-results"><tr class="match"></tr></table>' };
    }
    return base(url, n);
  });

  const previous = { standings: [], matchDays: [{ dayNumber: 2, matches: [{ homeTeam: 'A', awayTeam: 'B' }] }] };
  const scraper = new HttpScraper({ fetch: fetchImpl, retries: 2, retryDelayMs: 1, onProgress: () => {} });

  await assert.rejects(
    () => scraper.scrapeLeague(LEAGUE, { previousData: previous }),
    (err) => {
      assert.equal(err.waf, true);
      assert.match(err.message, /giornata 2 vuota/);
      return true;
    }
  );
  assert.equal(emptyCalls, 2, 'la giornata vuota va ritentata una volta');
});

test('una giornata vuota senza dati precedenti viene accettata con un avviso', async () => {
  const base = standardRoutes();
  const warnings = [];
  const fetchImpl = fakeFetch((url, n) => {
    if (url.includes('match_day_id=2')) {
      return { body: '<table class="table-results"><tr class="match"></tr></table>' };
    }
    return base(url, n);
  });

  const scraper = new HttpScraper({
    fetch: fetchImpl,
    retries: 2,
    retryDelayMs: 1,
    onProgress: (msg) => warnings.push(msg)
  });

  const data = await scraper.scrapeLeague(LEAGUE);
  assert.equal(data.matchDays.length, 2);
  assert.equal(validMatches(data.matchDays[1]).length, 0, 'nessuna partita valida nella giornata vuota');
  assert.ok(validMatches(data.matchDays[0]).length > 0, 'la giornata buona resta completa');
  assert.ok(warnings.some(w => w.includes('senza partite')), 'deve emettere un avviso');
});

test('se nessuna giornata contiene partite valide si passa al browser', async () => {
  const base = standardRoutes();
  const empty = '<table class="table-results"><tr class="match"></tr></table>';
  const fetchImpl = fakeFetch((url, n) => (url.includes('ResultsView.php') ? { body: empty } : base(url, n)));

  const scraper = new HttpScraper({ fetch: fetchImpl, retries: 1, retryDelayMs: 1, onProgress: () => {} });
  await assert.rejects(
    () => scraper.scrapeLeague(LEAGUE),
    (err) => {
      assert.equal(err.waf, true);
      assert.match(err.message, /nessuna partita/);
      return true;
    }
  );
});

test('una classifica vuota fa scattare il fallback sul browser', async () => {
  const base = standardRoutes();
  const fetchImpl = fakeFetch((url, n) => {
    if (url.includes('RankingView.php')) return { body: '<table class="table_ranking"></table>' };
    return base(url, n);
  });

  const scraper = new HttpScraper({ fetch: fetchImpl, onProgress: () => {} });
  await assert.rejects(
    () => scraper.scrapeLeague(LEAGUE),
    (err) => {
      assert.equal(err.waf, true);
      assert.match(err.message, /classifica vuota/);
      return true;
    }
  );
});

test('un numero di giornate non valido interrompe subito', async () => {
  const broken = LEAGUE_PAGE.replace("matchesNumber = '2'", "matchesNumber = '0'");
  const fetchImpl = fakeFetch(() => ({ body: broken }));
  const scraper = new HttpScraper({ fetch: fetchImpl, onProgress: () => {} });

  await assert.rejects(() => scraper.scrapeLeague(LEAGUE), /numero di giornate non valido/);
});

test('la concorrenza è rispettata e ogni giornata viene richiesta una volta sola', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const base = standardRoutes();
  const manyDays = LEAGUE_PAGE.replace("matchesNumber = '2'", "matchesNumber = '7'");

  const fetchImpl = async (url, init = {}) => {
    const route = (String(url) === LEAGUE.url ? { body: manyDays, headers: { 'set-cookie': 'PHPSESSID=x' } } : base(String(url))) || { status: 404, body: '' };
    const res = new Response(route.body, { status: route.status || 200, headers: route.headers || {} });

    if (String(url).includes('ResultsView.php')) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Il contatore scende quando il corpo viene letto, come in una richiesta reale
      const originalText = res.text.bind(res);
      res.text = async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
        return originalText();
      };
    }
    return res;
  };

  const scraper = new HttpScraper({ fetch: fetchImpl, concurrency: 3, onProgress: () => {} });
  const data = await scraper.scrapeLeague(LEAGUE);

  assert.equal(data.matchDays.length, 7);
  assert.deepEqual(data.matchDays.map(d => d.dayNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(maxInFlight <= 3, `concorrenza rispettata (massimo ${maxInFlight} richieste in volo)`);
  assert.ok(maxInFlight > 1, 'le richieste devono procedere in parallelo');
});

test('con una sessione dal browser si salta la richiesta di bootstrap', async () => {
  const base = standardRoutes();
  const fetchImpl = fakeFetch(base);
  const scraper = new HttpScraper({ fetch: fetchImpl, onProgress: () => {} });

  const session = {
    tckk: 'SESSIONE123',
    roundID: 'TO.P.C',
    totalDays: 2,
    currentDay: 1,
    cookies: 'PHPSESSID=abc; aws-waf-token=xyz',
    userAgent: 'UA-dal-browser'
  };

  const data = await scraper.scrapeLeague(LEAGUE, { session });

  // Nessuna richiesta alla pagina: solo classifica + 2 giornate
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(!fetchImpl.calls.some(c => c.url === LEAGUE.url), 'la pagina non deve essere richiesta');
  assert.equal(data.totalMatchDays, 2);
  assert.equal(data.matchDays.length, 2);
  assert.equal(data.standings.length, 4);

  // Cookie e User-Agent del browser vengono riusati
  for (const call of fetchImpl.calls) {
    assert.match(call.headers.cookie, /aws-waf-token=xyz/);
    assert.equal(call.headers['user-agent'], 'UA-dal-browser');
  }

  // I token della sessione finiscono nelle URL delle richieste AJAX
  assert.ok(fetchImpl.calls.every(c => c.url.includes('tckk=SESSIONE123')));
});
