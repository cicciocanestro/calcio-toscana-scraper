/**
 * Scraper HTTP: scarica calendario e classifica con semplici richieste HTTP,
 * senza avviare un browser.
 *
 * Perché esiste: il sito espone i dati tramite endpoint AJAX interni
 * (RankingView.php / ResultsView.php) che rispondono a normali richieste HTTP,
 * purché venga mantenuto il cookie di sessione PHP e i token letti dalla pagina
 * (`tckk`, `roundID`, `matchesNumber`, `currentMatchDay`). Misurato: ~0,6 s per
 * campionato contro ~45-85 s della via con Puppeteer.
 *
 * Il browser resta necessario solo quando il WAF risponde con una challenge:
 * in quel caso viene lanciato `HttpScrapeError` con `waf: true` e
 * src/scraper.js ripiega automaticamente su Puppeteer.
 */
const parser = require('./parser');

// In Node serve un DOM per il parser: linkedom fornisce DOMParser.
// (nel contesto pagina il DOMParser è già quello nativo del browser)
if (typeof globalThis.DOMParser === 'undefined') {
  const { DOMParser } = require('linkedom');
  globalThis.DOMParser = DOMParser;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 400;
const DEFAULT_TIMEOUT_MS = 20000;

// Marcatori tipici delle pagine di challenge AWS WAF
const WAF_MARKERS = ['AwsWafIntegration', 'challenge-container', 'aws-waf-token', 'captcha-container'];

/** Errore del percorso HTTP: se `waf` è true conviene ripiegare sul browser. */
class HttpScrapeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpScrapeError';
    this.waf = !!options.waf;
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Partite "valide" di una giornata: una pagina di challenge o una risposta
 * troncata può produrre righe vuote, che non vanno considerate dati.
 */
function countValidMatches(day) {
  if (!day || !Array.isArray(day.matches)) return 0;
  return day.matches.filter(m => m.homeTeam && m.awayTeam).length;
}

/**
 * Legge una variabile JavaScript dal sorgente della pagina
 * (es. `var tckk = 'abc'` oppure `matchesNumber = 30`).
 */
function readPageVariable(html, name) {
  const re = new RegExp(`(?:var\\s+|let\\s+|const\\s+)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s,)]+))`, 'i');
  const match = html.match(re);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3];
  return value === undefined ? null : String(value).trim();
}

/** Estrae i metadati di sessione dalla pagina dei risultati. */
function extractSessionTokens(html) {
  const tckk = readPageVariable(html, 'tckk');
  const roundID = readPageVariable(html, 'roundID');
  if (!tckk || !roundID) return null;

  return {
    tckk,
    roundID,
    totalDays: parseInt(readPageVariable(html, 'matchesNumber') || '', 10),
    currentDay: parseInt(readPageVariable(html, 'currentMatchDay') || '', 10)
  };
}

/** True se la risposta sembra una challenge/blocco del WAF. */
function looksLikeWaf(status, headers, body) {
  if (status === 403 || status === 405 || status === 429) return true;
  if (headers && typeof headers.get === 'function' && headers.get('x-amzn-waf-action')) return true;
  return WAF_MARKERS.some(marker => typeof body === 'string' && body.includes(marker));
}

class HttpScraper {
  constructor(options = {}) {
    this.fetchImpl = options.fetch || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('HttpScraper richiede fetch (Node 18+ oppure l\'opzione `fetch`)');
    }
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.concurrency = Math.max(1, options.concurrency || DEFAULT_CONCURRENCY);
    this.retries = Math.max(1, options.retries || DEFAULT_RETRIES);
    this.retryDelayMs = options.retryDelayMs === undefined ? DEFAULT_RETRY_DELAY_MS : options.retryDelayMs;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.onProgress = options.onProgress || (() => {});
    this.cookies = '';
  }

  headers(extra = {}) {
    return {
      'user-agent': this.userAgent,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'it-IT,it;q=0.9',
      ...(this.cookies ? { cookie: this.cookies } : {}),
      ...extra
    };
  }

  /** Accumula i cookie di sessione restituiti dal server. */
  absorbCookies(res) {
    const headers = res.headers;
    if (!headers) return;

    const list = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);

    if (!list.length) return;

    const jar = new Map();
    for (const raw of this.cookies.split('; ').filter(Boolean)) {
      const [name, ...rest] = raw.split('=');
      jar.set(name, rest.join('='));
    }
    for (const cookie of list) {
      const pair = cookie.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    this.cookies = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * Richiesta HTTP con retry sugli errori temporanei.
   * Il WAF non viene ritentato: in quel caso serve il browser.
   */
  async request(url, options = {}) {
    const { xhr = false, referer = null } = options;
    const extra = xhr ? { 'x-requested-with': 'XMLHttpRequest' } : {};
    if (referer) extra.referer = referer;

    let lastError = null;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchImpl(url, {
          headers: this.headers(extra),
          redirect: 'follow',
          signal: controller.signal
        });
        this.absorbCookies(res);
        const body = await res.text();

        if (looksLikeWaf(res.status, res.headers, body)) {
          throw new HttpScrapeError(`WAF: HTTP ${res.status} su ${url}`, { waf: true });
        }
        if (!res.ok) {
          throw new HttpScrapeError(`HTTP ${res.status} su ${url}`, { retryable: res.status >= 500 });
        }

        return body;
      } catch (err) {
        lastError = err;
        const waf = err instanceof HttpScrapeError && err.waf;
        const retryable = !waf && (err.retryable !== false);

        if (waf || !retryable || attempt === this.retries) break;

        this.onProgress(`↻ richiesta fallita (${err.message}), nuovo tentativo ${attempt + 1}/${this.retries}...`);
        await sleep(this.retryDelayMs * attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  }

  /** Scarica una singola giornata; una risposta vuota viene ritentata una volta. */
  async fetchMatchday(origin, tokens, dayNumber, previousDay) {
    const url = `${origin}/Web/Views/Results/ResultsView.php?tckk=${tokens.tckk}` +
      `&category_id=${encodeURIComponent(tokens.roundID)}&match_day_id=${dayNumber}&v=1`;

    const parse = (html) => parser.parseMatchdayHtml(html, dayNumber);
    let day = parse(await this.request(url, { xhr: true, referer: `${origin}${tokens.pagePath}` }));

    if (countValidMatches(day) === 0) {
      await sleep(this.retryDelayMs);
      day = parse(await this.request(url, { xhr: true, referer: `${origin}${tokens.pagePath}` }));
    }

    if (countValidMatches(day) === 0) {
      // Con dati precedenti che avevano partite questa è quasi certamente una
      // risposta troncata o una challenge: meglio passare al browser.
      if (previousDay && countValidMatches(previousDay) > 0) {
        throw new HttpScrapeError(
          `giornata ${dayNumber} vuota ma in cache aveva ${countValidMatches(previousDay)} partite`,
          { waf: true }
        );
      }
      this.onProgress(`⚠ giornata ${dayNumber} senza partite (calendarizzazione non ancora pubblicata?)`);
    }

    return day;
  }

  /**
   * Scarica un campionato completo via HTTP.
   *
   * @param {object} leagueConfig
   * @param {object} options
   * @param {object} [options.previousData] dati dell'ultimo run (controlli di regressione)
   * @param {object} [options.session] sessione ottenuta da un browser
   *        (`{ tckk, roundID, totalDays, currentDay, cookies, userAgent }`).
   *        Se contiene i token si salta del tutto la richiesta di bootstrap;
   *        se contiene solo i cookie (tipicamente il token WAF) la pagina viene
   *        comunque richiesta, ma non serve più il browser.
   * @returns {object} dati nel formato usato dal resto del progetto
   */
  async scrapeLeague(leagueConfig, options = {}) {
    const previousData = options.previousData || null;
    const session = options.session || null;
    const pageUrl = leagueConfig.url;
    const origin = new URL(pageUrl).origin;
    const pagePath = new URL(pageUrl).pathname;

    let tokens;

    // Cookie (e User-Agent) dalla sessione del browser, se disponibili
    if (session) {
      if (session.cookies) this.cookies = session.cookies;
      if (session.userAgent) this.userAgent = session.userAgent;
    }

    if (session && session.tckk && session.roundID) {
      tokens = {
        tckk: session.tckk,
        roundID: session.roundID,
        totalDays: parseInt(session.totalDays, 10),
        currentDay: parseInt(session.currentDay, 10)
      };
      this.onProgress(`Uso la sessione ottenuta dal browser (${this.cookies ? 'cookie inclusi' : 'senza cookie'}).`);
    } else {
      this.onProgress(`Connessione HTTP a ${pageUrl}${this.cookies ? ' (con cookie WAF)' : ''}...`);
      const pageHtml = await this.request(pageUrl);

      tokens = extractSessionTokens(pageHtml);
      if (!tokens) {
        throw new HttpScrapeError('token di sessione non trovati nella pagina (possibile challenge WAF)', { waf: true });
      }
    }

    tokens.pagePath = pagePath;

    if (!Number.isFinite(tokens.totalDays) || tokens.totalDays <= 0) {
      throw new HttpScrapeError(`numero di giornate non valido: ${tokens.totalDays}`);
    }

    this.onProgress(`Trovate ${tokens.totalDays} giornate (giornata attuale: ${tokens.currentDay}). Recupero classifica...`);

    const rankingUrl = `${origin}/Web/Views/Rankings/RankingView.php?tckk=${tokens.tckk}` +
      `&category_id=${encodeURIComponent(tokens.roundID)}&is_ranking_tab=true&total=true&v=1`;
    const standings = parser.parseStandingsHtml(await this.request(rankingUrl, { xhr: true, referer: pageUrl }));

    if (standings.length === 0) {
      throw new HttpScrapeError('classifica vuota (possibile challenge WAF)', { waf: true });
    }
    if (previousData && previousData.standings && standings.length < previousData.standings.length) {
      this.onProgress(`⚠ la classifica ha ${standings.length} squadre contro ${previousData.standings.length} in cache`);
    }

    this.onProgress(`Recupero di tutte le ${tokens.totalDays} giornate del calendario (concorrenza ${this.concurrency})...`);

    const previousDays = new Map(
      ((previousData && previousData.matchDays) || []).map(day => [day.dayNumber, day])
    );

    const days = Array.from({ length: tokens.totalDays }, (_, i) => i + 1);
    const matchDays = [];

    for (let i = 0; i < days.length; i += this.concurrency) {
      const chunk = days.slice(i, i + this.concurrency);
      const parsed = await Promise.all(
        chunk.map(dayNumber => this.fetchMatchday(origin, tokens, dayNumber, previousDays.get(dayNumber)))
      );
      matchDays.push(...parsed);
    }

    matchDays.sort((a, b) => a.dayNumber - b.dayNumber);

    const totalMatches = matchDays.reduce((acc, day) => acc + countValidMatches(day), 0);
    if (totalMatches === 0) {
      throw new HttpScrapeError('nessuna partita recuperata (possibile challenge WAF)', { waf: true });
    }

    return {
      id: leagueConfig.id,
      name: leagueConfig.name,
      shortName: leagueConfig.shortName,
      category: leagueConfig.category,
      girone: leagueConfig.girone,
      region: leagueConfig.region,
      province: leagueConfig.province || '',
      url: leagueConfig.url,
      roundID: tokens.roundID,
      currentMatchDay: Number.isFinite(tokens.currentDay) ? tokens.currentDay : 1,
      totalMatchDays: tokens.totalDays,
      lastUpdated: new Date().toISOString(),
      standings,
      matchDays
    };
  }
}

module.exports = {
  HttpScraper,
  HttpScrapeError,
  extractSessionTokens,
  readPageVariable,
  looksLikeWaf,
  countValidMatches,
  DEFAULT_USER_AGENT
};
