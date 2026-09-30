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
   * Dati in cache, oppure null.
   * @param {number|null} maxAgeMs - età massima accettata. Passare null per accettare
   *                                 anche dati scaduti (fallback / modalità cache-first).
   */
  getCachedLeague(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const league = LEAGUES[leagueId];
    if (!league || !fs.existsSync(league.cacheFile)) return null;

    try {
      if (maxAgeMs !== null && maxAgeMs !== undefined) {
        const stats = fs.statSync(league.cacheFile);
        if (Date.now() - stats.mtimeMs > maxAgeMs) return null;
      }

      return JSON.parse(fs.readFileSync(league.cacheFile, 'utf-8'));
    } catch (err) {
      return null;
    }
  }

  /**
   * Stato della cache locale di un campionato (senza leggere il file).
   * @returns {{exists:boolean, isStale:boolean, ageMs:number|null, lastUpdated:string|null}}
   */
  getCacheStatus(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const league = LEAGUES[leagueId];
    const empty = { exists: false, isStale: false, ageMs: null, lastUpdated: null };
    if (!league || !fs.existsSync(league.cacheFile)) return empty;

    try {
      const stats = fs.statSync(league.cacheFile);
      const ageMs = Date.now() - stats.mtimeMs;
      return {
        exists: true,
        isStale: ageMs > maxAgeMs,
        ageMs,
        lastUpdated: stats.mtime.toISOString()
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
   */
  async produceLeagueData(leagueConfig, options = {}) {
    if (this.mode === 'browser') {
      return this.scrapeLeagueWithBrowser(leagueConfig, options);
    }

    try {
      return await this.scrapeLeagueWithHttp(leagueConfig, options);
    } catch (err) {
      if (this.mode === 'http') throw err;

      this.onProgress(
        `⚠ Scraping HTTP non riuscito per ${leagueConfig.name} (${err.message}): passo al browser...`
      );
      return this.scrapeLeagueWithBrowser(leagueConfig, options);
    }
  }

  /**
   * Percorso veloce: richieste HTTP pure (~0,6 s per campionato, nessun browser).
   */
  async scrapeLeagueWithHttp(leagueConfig, options = {}) {
    const httpScraper = this.httpScraper
      || new HttpScraper({ onProgress: this.onProgress, ...this.httpOptions });

    return httpScraper.scrapeLeague(leagueConfig, { previousData: options.previousData });
  }

  /**
   * Percorso di riserva: Puppeteer, necessario quando il WAF richiede una
   * challenge JavaScript.
   */
  async scrapeLeagueWithBrowser(leagueConfig, options = {}) {
    this.onProgress(`Avvio scraper (browser) per ${leagueConfig.name}...`);

    const chromePath = this.resolveChromePath();

    let browser = null;
    try {
      const isLinux = os.platform() === 'linux';
      const userAgent = isLinux
        ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: this.headless,
        userDataDir: this.userDataDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080',
          '--lang=it-IT,it'
        ]
      });

      const page = await browser.newPage();
      await page.setUserAgent(userAgent);
      await page.setViewport({ width: 1920, height: 1080 });

      // Iniezione del parser (src/parser.js) PRIMA di qualsiasi script di pagina.
      // evaluateOnNewDocument passa da CDP, quindi non è soggetto alla CSP del sito,
      // e sopravvive ai reload causati dalla challenge WAF.
      await page.evaluateOnNewDocument(PARSER_SOURCE);

      // Rimuove impronte di automazione per superare challenge AWS WAF
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      });

      this.onProgress(`Connessione a ${leagueConfig.url}...`);
      try {
        await page.goto(leagueConfig.url, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      } catch (err) {
        // Se c'è un reload immediato causato da WAF o timeout networkidle, prosegui
      }

      // Controlla se la pagina è in challenge WAF
      const inWafChallenge = await page.evaluate(() => {
        return typeof AwsWafIntegration !== 'undefined' ||
               document.querySelector('#challenge-container') !== null;
      }).catch(() => false);

      if (inWafChallenge) {
        this.onProgress('Risoluzione automatica challenge AWS WAF in corso...');
        // Attendi che il challenge.js ricarichi la pagina
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      }

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
