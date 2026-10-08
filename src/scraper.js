const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findChrome, LEAGUES, CACHE_DIR, EXPORT_DIR, CACHE_TTL_MS } = require('./config');
const { exportToJson, exportToCsv, exportToIcs } = require('./exporters');
const { HttpScraper } = require('./http-scraper');

// Sorgente del parser HTML: viene iniettato nella pagina come window.CalcioParser.
// In questo modo esiste UNA sola implementazione del parsing (src/parser.js),
// usata sia nel browser dallo scraper sia nei test Node.
const PARSER_SOURCE = fs.readFileSync(require.resolve('./parser'), 'utf-8');

const VALID_MODES = ['auto', 'http', 'browser'];

class CalendarScraper {
  constructor(options = {}) {
    // Nota: il browser NON viene cercato qui. findChrome() è lazy e viene
    // invocato solo al momento dello scraping, così il server web e la CLI
    // possono funzionare (servendo cache ed export) anche senza Chrome.
    this.chromePath = options.chromePath || null;
    this.headless = options.headless !== undefined ? options.headless : true;
    this.onProgress = options.onProgress || (() => {});

    // auto (default): prova HTTP e ripiega su Puppeteer se il WAF si mette di mezzo
    const mode = options.mode || process.env.SCRAPER_MODE || 'auto';
    this.mode = VALID_MODES.includes(mode) ? mode : 'auto';

    // Utile in ambienti dove la cartella temporanea di sistema non è scrivibile
    this.userDataDir = options.userDataDir || process.env.CHROME_USER_DATA_DIR || undefined;

    // Opzioni per lo scraper HTTP (e scraper iniettabile nei test)
    this.httpOptions = options.httpOptions || {};
    this.httpScraper = options.httpScraper || null;

    // Esito dell'ultimo scraping per campionato (diagnostica /api/diagnostics)
    this.lastScrapes = new Map();

    // Sessione WAF riusata fra i campionati (i token aws-waf-token durano pochi minuti)
    this.wafSession = null;
    this.wafSessionTtlMs = options.wafSessionTtlMs || 4 * 60 * 1000;

    // Tetto complessivo per un singolo bootstrap (vedi browserBootstrap)
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs || 120000;
  }

  /**
   * Registra quale percorso ha prodotto i dati di un campionato.
   * @param {string} path - 'http', 'browser' oppure 'browser-fallback'
   */
  recordScrape(leagueId, path, durationMs, error = null) {
    this.lastScrapes.set(leagueId, {
      path,
      durationMs,
      error,
      at: new Date().toISOString()
    });
  }

  /** Informazioni per /api/diagnostics: modalità attiva ed esito degli ultimi scrape. */
  getDiagnostics() {
    return {
      mode: this.mode,
      commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
      node: process.version,
      lastScrapes: Object.fromEntries(this.lastScrapes)
    };
  }

  /**
   * Percorso del browser da usare per lo scraping (risolto pigramente).
   */
  resolveChromePath() {
    if (!this.chromePath) {
      this.chromePath = findChrome();
    }
    return this.chromePath;
  }

  /**
   * Età dei dati in cache, in millisecondi.
   *
   * Si basa sul campo `lastUpdated` scritto nei dati e NON sull'mtime del file:
   * un `git clone` (build di Render, checkout della CI) riscrive gli mtime a
   * "adesso", facendo sembrare fresca una cache che non lo è. L'mtime viene
   * usato solo come ripiego per file privi di `lastUpdated`.
   */
  cacheAgeMs(leagueId, data) {
    const stamp = data ? Date.parse(data.lastUpdated || '') : NaN;
    if (Number.isFinite(stamp)) return Math.max(0, Date.now() - stamp);

    const league = LEAGUES[leagueId];
    return Date.now() - fs.statSync(league.cacheFile).mtimeMs;
  }

  /**
   * Dati in cache, oppure null.
   * @param {number|null} maxAgeMs - età massima accettata. Passare null per accettare
   *                                 anche dati scaduti (fallback / modalità cache-first).
   */
  getCachedLeague(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const league = LEAGUES[leagueId];
    if (!league || !fs.existsSync(league.cacheFile)) return null;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(league.cacheFile, 'utf-8'));
    } catch (err) {
      return null;
    }

    if (maxAgeMs !== null && maxAgeMs !== undefined && this.cacheAgeMs(leagueId, data) > maxAgeMs) {
      return null;
    }

    return data;
  }

  /**
   * Stato della cache locale di un campionato.
   * @returns {{exists:boolean, isStale:boolean, ageMs:number|null, lastUpdated:string|null}}
   */
  getCacheStatus(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const league = LEAGUES[leagueId];
    const empty = { exists: false, isStale: false, ageMs: null, lastUpdated: null };
    if (!league || !fs.existsSync(league.cacheFile)) return empty;

    try {
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(league.cacheFile, 'utf-8'));
      } catch (err) {
        // Cache illeggibile: si ripiega sull'mtime del file
      }

      const ageMs = this.cacheAgeMs(leagueId, data);
      const stamp = data ? Date.parse(data.lastUpdated || '') : NaN;

      return {
        exists: true,
        isStale: ageMs > maxAgeMs,
        ageMs,
        lastUpdated: Number.isFinite(stamp)
          ? new Date(stamp).toISOString()
          : new Date(Date.now() - ageMs).toISOString()
      };
    } catch (err) {
      return empty;
    }
  }

  /**
   * Scrape completo di un campionato (calendario + classifica).
   *
   * @param {string} leagueId
   * @param {object} options
   * @param {boolean} options.forceRefresh - ignora la cache e riscarica dal web
   * @param {boolean} options.cacheFirst   - usa la cache anche se scaduta, senza scraping
   *
   * Comportamento di fallback: se lo scraping live fallisce (WAF, rete, timeout)
   * e in cache esiste una copia scaduta, viene restituita quella (marcata con
   * isStale: true) invece di propagare l'errore.
   */
  async scrapeLeague(leagueId, options = {}) {
    const leagueConfig = LEAGUES[leagueId];
    if (!leagueConfig) {
      throw new Error(`Campionato sconosciuto: ${leagueId}. Valori ammessi: ${Object.keys(LEAGUES).join(', ')}`);
    }

    if (!options.forceRefresh) {
      const cached = this.getCachedLeague(leagueId);
      if (cached) {
        this.onProgress(`Dati per ${leagueConfig.name} caricati dalla cache locale.`);
        return cached;
      }

      if (options.cacheFirst) {
        const stale = this.getCachedLeague(leagueId, null);
        if (stale) {
          this.onProgress(`Cache scaduta per ${leagueConfig.name}: uso i dati locali in attesa dell'aggiornamento.`);
          return { ...stale, isStale: true };
        }
      }
    }

    try {
      const previousData = this.getCachedLeague(leagueId, null);
      return await this.scrapeLeagueLive(leagueConfig, { ...options, previousData });
    } catch (err) {
      const stale = this.getCachedLeague(leagueId, null);
      if (stale) {
        const ageHours = Math.round(this.getCacheStatus(leagueId).ageMs / 3600000);
        this.onProgress(
          `⚠ Aggiornamento di ${leagueConfig.name} non riuscito (${err.message}). ` +
          `Uso i dati in cache di ~${ageHours}h fa.`
        );
        return { ...stale, isStale: true };
      }
      throw err;
    }
  }

  /**
   * Scraping dal sito sorgente (nessuna gestione cache).
   *
   * Modalità (`SCRAPER_MODE` o opzione `mode`):
   *  - `auto` (default): prima HTTP, con fallback su Puppeteer se il WAF
   *    risponde con una challenge;
   *  - `http`: solo richieste HTTP (nessun browser);
   *  - `browser`: solo Puppeteer (comportamento storico).
   */
  async scrapeLeagueLive(leagueConfig, options = {}) {
    const leagueData = await this.produceLeagueData(leagueConfig, options);

    this.persistLeagueData(leagueConfig, leagueData);
    this.onProgress(`Completato scraping di ${leagueConfig.name}. Salvato in cache ed export.`);

    return leagueData;
  }

  /**
   * Produce i dati dal sito sorgente senza scrivere nulla su disco
   * (utile anche per confronti/parità tra i due percorsi).
   *
   * In modalità `auto` prova in ordine:
   *  1. HTTP puro (nessun browser);
   *  2. bootstrap con il browser per superare la challenge WAF, poi HTTP
   *     riusando i cookie ottenuti (il browser serve solo per la challenge);
   *  3. browser completo, come comportamento storico.
   */
  async produceLeagueData(leagueConfig, options = {}) {
    const startedAt = Date.now();

    if (this.mode === 'browser') {
      const data = await this.scrapeLeagueWithBrowser(leagueConfig, options);
      this.recordScrape(leagueConfig.id, 'browser', Date.now() - startedAt);
      return data;
    }

    let httpError = null;

    try {
      const data = await this.scrapeLeagueWithHttp(leagueConfig, options);
      this.recordScrape(leagueConfig.id, 'http', Date.now() - startedAt);
      return data;
    } catch (err) {
      httpError = err;
      if (this.mode === 'http') throw err;

      this.onProgress(`⚠ HTTP puro non riuscito per ${leagueConfig.name} (${err.message}).`);
    }

    // 2) La challenge WAF richiede il browser: lo usiamo solo per ottenere i
    //    cookie di clearance (bootstrap condiviso fra tutti i campionati),
    //    poi i dati vengono scaricati via HTTP.
    try {
      const session = await this.ensureWafSession(leagueConfig);
      const data = await this.scrapeLeagueWithHttp(leagueConfig, { ...options, session });
      this.recordScrape(leagueConfig.id, 'http-after-bootstrap', Date.now() - startedAt, httpError.message);
      this.onProgress(`✔ Dati di ${leagueConfig.name} scaricati via HTTP dopo il bootstrap del browser.`);
      return data;
    } catch (err) {
      this.onProgress(
        `⚠ Bootstrap + HTTP non riuscito per ${leagueConfig.name} (${err.message}): uso il browser completo...`
      );
    }

    // 3) Ultima risorsa: browser completo
    const data = await this.scrapeLeagueWithBrowser(leagueConfig, options);
    this.recordScrape(leagueConfig.id, 'browser-fallback', Date.now() - startedAt, httpError.message);
    return data;
  }

  /**
   * Percorso veloce: richieste HTTP pure (~0,6 s per campionato, nessun browser).
   * Con `options.session` riusa cookie e token ottenuti dal bootstrap del browser.
   */
  async scrapeLeagueWithHttp(leagueConfig, options = {}) {
    const httpScraper = this.httpScraper
      || new HttpScraper({ onProgress: this.onProgress, ...this.httpOptions });

    return httpScraper.scrapeLeague(leagueConfig, {
      previousData: options.previousData,
      session: options.session || null
    });
  }

  /** User-Agent usato dal browser, coerente con la piattaforma. */
  resolveUserAgent() {
    return os.platform() === 'linux'
      ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  }

  /** Avvia Chrome con le opzioni anti-automazione e ottimizzazioni per ambienti containerizzati/low-resource. */
  async launchBrowser() {
    return puppeteer.launch({
      executablePath: this.resolveChromePath(),
      headless: this.headless,
      userDataDir: this.userDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--no-first-run',
        '--window-size=1920,1080',
        '--lang=it-IT,it'
      ]
    });
  }

  /** Configura le evasioni anti-automazione sul contesto pagina. */
  async applyStealthEvasions(page) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = {
        app: { isInstalled: false },
        webstore: { onInstallStageChanged: {}, onDownloadProgress: {} },
        runtime: {
          PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
          PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
          RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
          OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }
        }
      };
      Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
  }

  /**
   * Durante la navigazione blocca solo i video pesanti, senza toccare
   * immagini/font/script: AWS WAF usa pixel-tracker e risorse grafiche per
   * validare l'ambiente browser.
   */
  async blockHeavyMedia(page) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.resourceType() === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  /** True se la pagina corrente mostra una challenge AWS WAF. */
  async isWafChallenge(page) {
    return page.evaluate(() => {
      return typeof AwsWafIntegration !== 'undefined' ||
             document.querySelector('#challenge-container') !== null;
    }).catch(() => false);
  }

  /**
   * Naviga verso l'URL del campionato e, se compare la challenge AWS WAF,
   * attende che challenge.js ricarichi la pagina.
   */
  async navigateAndSolveWafChallenge(page, url, waitUntil) {
    try {
      await page.goto(url, { waitUntil, timeout: 30000 });
    } catch (err) {
      // Un reload immediato causato dalla challenge (o un timeout) non è un errore
    }

    if (await this.isWafChallenge(page)) {
      this.onProgress('Risoluzione della challenge AWS WAF in corso...');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      // Senza questo messaggio il log resterebbe muto per tutta la lettura dei
      // token, che sulla challenge AWS dura decine di secondi.
      this.onProgress('Challenge superata, lettura dei token di sessione...');
    }
  }

  /**
   * Sessione WAF condivisa: il bootstrap con il browser costa decine di secondi
   * su un'istanza piccola, quindi viene fatto una volta sola e riusato per tutti
   * i campionati finché i cookie (token `aws-waf-token`) sono validi.
   */
  async ensureWafSession(leagueConfig) {
    const now = Date.now();
    const ttl = this.wafSessionTtlMs;

    if (this.wafSession && now - this.wafSession.at < ttl) {
      this.onProgress('Riuso la sessione del browser ottenuta poco fa (nessun nuovo avvio di Chrome).');
      return this.wafSession;
    }

    const bootstrapped = await this.browserBootstrap(leagueConfig);

    // Vengono riusati cookie e User-Agent: i token di sessione (tckk/roundID)
    // sono specifici del campionato e vengono riletti via HTTP per ogni lega.
    this.wafSession = {
      cookies: bootstrapped.cookies,
      userAgent: bootstrapped.userAgent,
      at: Date.now()
    };

    return this.wafSession;
  }

  /**
   * Naviga la pagina con il browser solo per superare la challenge del WAF e
   * restituisce cookie + token di sessione, da riusare con le richieste HTTP.
   *
   * Il lavoro vero sta in runBrowserBootstrap; qui si aggiunge solo un tetto di
   * tempo complessivo, perché alcune chiamate Puppeteer (`page.evaluate`,
   * `browser.close`) non accettano un timeout: se Chrome si blocca sulla
   * challenge, senza questo limite il bootstrap resterebbe appeso per sempre e
   * la revalidation risulterebbe "in corso" a tempo indefinito.
   *
   * @returns {Promise<{tckk:string, roundID:string, totalDays:number, currentDay:number, cookies:string, userAgent:string}>}
   */
  async browserBootstrap(leagueConfig) {
    this.onProgress(`Bootstrap con il browser per superare la challenge WAF di ${leagueConfig.name}...`);

    const browser = await this.launchBrowser();
    let watchdogTimer = null;
    let timedOut = false;

    const watchdog = new Promise((resolve, reject) => {
      watchdogTimer = setTimeout(() => {
        timedOut = true;
        reject(new Error(
          `Chrome non ha completato il bootstrap entro ${Math.round(this.bootstrapTimeoutMs / 1000)}s`
        ));
      }, this.bootstrapTimeoutMs);
    });

    try {
      return await Promise.race([this.runBrowserBootstrap(browser, leagueConfig), watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
      if (timedOut) {
        // Chrome è probabilmente appeso: `close()` da solo non risponderebbe
        browser.process()?.kill('SIGKILL');
      } else {
        await browser.close().catch(() => {});
      }
    }
  }

  /**
   * Corpo del bootstrap: naviga, supera la challenge e legge i token di sessione.
   * È separato da browserBootstrap per potergli applicare un tetto di tempo.
   */
  async runBrowserBootstrap(browser, leagueConfig) {
    const page = await browser.newPage();
    const userAgent = this.resolveUserAgent();
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    // Rimuove impronte di automazione per superare challenge AWS WAF
    await this.applyStealthEvasions(page);

    // Durante la navigazione, blocchiamo solo video pesanti senza toccare immagini/font/script
    // perché AWS WAF usa pixel-tracker e risorse grafiche per validare l'ambiente browser.
    await this.blockHeavyMedia(page);
    await this.navigateAndSolveWafChallenge(page, leagueConfig.url, 'domcontentloaded');

    await page.waitForFunction(
      () => typeof tckk !== 'undefined' && typeof roundID !== 'undefined' && typeof matchesNumber !== 'undefined',
      { timeout: 40000 }
    );

    const meta = await page.evaluate(() => ({
      tckk,
      roundID,
      totalDays: parseInt(matchesNumber, 10),
      currentDay: parseInt(currentMatchDay, 10)
    }));

    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    return { ...meta, cookies: cookieHeader, userAgent };
  }

  /**
   * Percorso di riserva: Puppeteer, necessario quando il WAF richiede una
   * challenge JavaScript.
   */
  async scrapeLeagueWithBrowser(leagueConfig, options = {}) {
    this.onProgress(`Avvio scraper (browser) per ${leagueConfig.name}...`);

    let browser = null;
    try {
      const userAgent = this.resolveUserAgent();

      browser = await this.launchBrowser();

      const page = await browser.newPage();
      await page.setUserAgent(userAgent);
      await page.setViewport({ width: 1920, height: 1080 });

      // Iniezione del parser (src/parser.js) PRIMA di qualsiasi script di pagina.
      // evaluateOnNewDocument passa da CDP, quindi non è soggetto alla CSP del sito,
      // e sopravvive ai reload causati dalla challenge WAF.
      await page.evaluateOnNewDocument(PARSER_SOURCE);

      // Rimuove impronte di automazione per superare challenge AWS WAF
      await this.applyStealthEvasions(page);

      await this.blockHeavyMedia(page);

      this.onProgress(`Connessione a ${leagueConfig.url}...`);
      await this.navigateAndSolveWafChallenge(page, leagueConfig.url, 'networkidle2');

      // Attende che la pagina carichi le variabili di sessione e metadati
      this.onProgress('Attesa caricamento sessione e token...');
      try {
        await page.waitForFunction(
          () => typeof tckk !== 'undefined' && typeof roundID !== 'undefined' && typeof matchesNumber !== 'undefined',
          { timeout: 35000 }
        );
      } catch (waitErr) {
        const diag = await page.evaluate(() => ({
          title: document.title,
          url: window.location.href,
          bodySnippet: document.body ? document.body.innerText.substring(0, 200).replace(/\s+/g, ' ') : ''
        })).catch(() => ({}));
        throw new Error(`Impossibile ottenere i dati da ${leagueConfig.url} (Stato: "${diag.title || 'N/A'}" - ${diag.bodySnippet || ''}).`);
      }

      // Estrae metadati campionato
      const meta = await page.evaluate(() => {
        return {
          tckk,
          roundID,
          totalDays: parseInt(matchesNumber, 10),
          currentDay: parseInt(currentMatchDay, 10),
          title: document.title,
          h1Title: document.querySelector('.title-info h1')?.innerText?.replace(/\s+/g, ' ').trim() || ''
        };
      });

      this.onProgress(`Trovate ${meta.totalDays} giornate (giornata attuale: ${meta.currentDay}). Recupero classifica...`);

      // 1. Recupero Classifica (parsing demandato a window.CalcioParser)
      const standings = await page.evaluate(async (tckk, roundID) => {
        try {
          const url = `/Web/Views/Rankings/RankingView.php?tckk=${tckk}&category_id=${roundID}&is_ranking_tab=true&total=true&v=1`;
          const resp = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          const html = await resp.text();
          return window.CalcioParser.parseStandingsHtml(html);
        } catch (e) {
          return [];
        }
      }, meta.tckk, meta.roundID);

      // 2. Recupero di tutte le Giornate in blocchi paralleli
      this.onProgress(`Recupero di tutte le ${meta.totalDays} giornate del calendario...`);

      const daysToFetch = Array.from({ length: meta.totalDays }, (_, i) => i + 1);

      const matchDays = await page.evaluate(async (days, tckk, roundID) => {
        const results = [];
        const chunkSize = 6;

        for (let i = 0; i < days.length; i += chunkSize) {
          const chunk = days.slice(i, i + chunkSize);
          const chunkPromises = chunk.map(async (d) => {
            const url = `/Web/Views/Results/ResultsView.php?tckk=${tckk}&category_id=${roundID}&match_day_id=${d}&v=1`;
            const resp = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            const html = await resp.text();
            return window.CalcioParser.parseMatchdayHtml(html, d);
          });

          const chunkRes = await Promise.all(chunkPromises);
          results.push(...chunkRes);
        }

        // Ordina le giornate per numero
        results.sort((a, b) => a.dayNumber - b.dayNumber);
        return results;
      }, daysToFetch, meta.tckk, meta.roundID);

      const leagueData = {
        id: leagueConfig.id,
        name: leagueConfig.name,
        shortName: leagueConfig.shortName,
        category: leagueConfig.category,
        girone: leagueConfig.girone,
        region: leagueConfig.region,
        province: leagueConfig.province || '',
        url: leagueConfig.url,
        roundID: meta.roundID,
        currentMatchDay: meta.currentDay,
        totalMatchDays: meta.totalDays,
        lastUpdated: new Date().toISOString(),
        standings,
        matchDays
      };

      return leagueData;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  /**
   * Salva i dati in cache e rigenera gli export standard (CSV, ICS, JSON).
   * Condiviso dai percorsi HTTP e browser.
   */
  persistLeagueData(leagueConfig, leagueData) {
    exportToJson(leagueData, leagueConfig.cacheFile);
    exportToCsv(leagueData, path.join(EXPORT_DIR, `${leagueConfig.id}.csv`));
    exportToIcs(leagueData, path.join(EXPORT_DIR, `${leagueConfig.id}.ics`));
    exportToJson(leagueData, path.join(EXPORT_DIR, `${leagueConfig.id}.json`));
    return leagueData;
  }

  /**
   * Scrape di tutti i campionati configurati
   */
  async scrapeAll(options = {}) {
    const results = {};
    for (const key of Object.keys(LEAGUES)) {
      results[key] = await this.scrapeLeague(key, options);
    }
    return results;
  }
}

module.exports = { CalendarScraper, PARSER_SOURCE, VALID_MODES };
