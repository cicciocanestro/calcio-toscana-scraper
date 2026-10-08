#!/usr/bin/env node
/**
 * Scarica i dati aggiornati da un'istanza sempre accesa (es. Render) e li scrive
 * nella cache locale, così il workflow di GitHub Actions può committarli.
 *
 * Serve perché il WAF di Tuttocampo blocca gli IP dei runner GitHub (403), mentre
 * l'istanza Render riesce a fare scraping. Su Render il filesystem è effimero,
 * quindi i dati vanno riportati nel repository per essere duraturi.
 *
 *   node bin/fetch-from-render.js [--url https://...] [--out data/cache] [--token XXX]
 *                                [--retries 3] [--retry-delay 15000] [--no-refresh]
 *
 * Con `--no-refresh` si legge la cache già presente sull'istanza remota invece di
 * chiedere un nuovo scraping: serve quando è l'istanza stessa ad aver appena
 * aggiornato i dati (es. pulsante "Aggiorna dal Web") e non vogliamo pagare due
 * volte il bootstrap del browser per la challenge WAF.
 *
 * Variabili d'ambiente: RENDER_URL, REFRESH_TOKEN, FETCH_NO_REFRESH
 *
 * Exit code: 0 tutte le leghe aggiornate, 1 aggiornamento parziale, 2 nessuna.
 */
const fs = require('fs');
const path = require('path');
const { LEAGUES, CACHE_DIR } = require('../src/config');

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 15000;

// Status che indicano un problema temporaneo dell'istanza (es. 502 durante il
// cold start del piano free): vale la pena ritentare.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class FetchError extends Error {
  constructor(message, retryable) {
    super(message);
    this.name = 'FetchError';
    this.retryable = !!retryable;
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Verifica che la risposta del server sia un aggiornamento reale e completo.
 * @returns {string|null} messaggio d'errore, oppure null se il payload è valido
 */
function validateLeaguePayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return 'risposta non valida (non è un oggetto JSON)';
  if (payload.error) return `errore dal server: ${payload.error}`;
  if (options.expectedId && payload.id !== options.expectedId) {
    return `campionato inatteso: ricevuto "${payload.id}", atteso "${options.expectedId}"`;
  }
  if (payload.isStale) return 'il server ha ripiegato sulla cache locale: dati non aggiornati';
  if (!Array.isArray(payload.standings) || payload.standings.length === 0) return 'classifica vuota o assente';
  if (!Array.isArray(payload.matchDays) || payload.matchDays.length === 0) return 'calendario vuoto o assente';

  const matches = payload.matchDays.reduce((acc, day) => acc + ((day.matches && day.matches.length) || 0), 0);
  if (matches === 0) return 'nessuna partita nel calendario';
  if (!payload.lastUpdated) return 'campo lastUpdated mancante';

  const updated = new Date(payload.lastUpdated);
  if (Number.isNaN(updated.getTime())) return `lastUpdated non valido: ${payload.lastUpdated}`;

  if (options.minLastUpdated) {
    const previous = new Date(options.minLastUpdated);
    if (!Number.isNaN(previous.getTime()) && updated <= previous) {
      return `dati non più recenti di quelli già in cache (${payload.lastUpdated})`;
    }
  }

  return null;
}

function parseArgs(argv) {
  const args = {
    url: process.env.RENDER_URL || '',
    out: CACHE_DIR,
    token: process.env.REFRESH_TOKEN || '',
    retries: DEFAULT_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    noRefresh: process.env.FETCH_NO_REFRESH === 'true'
  };
  for (let i = 2; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--url' && next) args.url = argv[++i];
    else if (argv[i] === '--out' && next) args.out = argv[++i];
    else if (argv[i] === '--token' && next) args.token = argv[++i];
    else if (argv[i] === '--retries' && next) args.retries = Math.max(1, parseInt(argv[++i], 10) || DEFAULT_RETRIES);
    else if (argv[i] === '--retry-delay' && next) args.retryDelayMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (argv[i] === '--no-refresh') args.noRefresh = true;
  }
  return args;
}

async function fetchLeague(baseUrl, leagueId, token, options = {}) {
  const { timeoutMs, noRefresh = false } = options;
  const url = `${baseUrl.replace(/\/$/, '')}/api/leagues/${leagueId}${noRefresh ? '' : '?refresh=true'}`;
  const headers = { Accept: 'application/json' };
  if (token) headers['x-refresh-token'] = token;

  let resp;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // Timeout o errore di rete: l'istanza potrebbe essere in fase di avvio
    throw new FetchError(`richiesta non riuscita (${err.message})`, true);
  }

  const text = await resp.text();
  const retryable = RETRYABLE_STATUS.has(resp.status);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    // Es. 502 Bad Gateway di Render durante il cold start: risposta HTML
    throw new FetchError(`risposta non JSON (HTTP ${resp.status})`, retryable);
  }

  if (!resp.ok) {
    throw new FetchError(payload.error || `HTTP ${resp.status}`, retryable);
  }

  return payload;
}

/**
 * Ritenta le richieste temporaneamente fallite (cold start dell'istanza free).
 */
async function fetchLeagueWithRetry(baseUrl, leagueId, token, options) {
  const attempts = options.retries;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchLeague(baseUrl, leagueId, token, options);
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === attempts) break;

      console.warn(`↻ ${leagueId}: ${err.message}. Nuovo tentativo tra ${Math.round(options.retryDelayMs / 1000)}s ` +
        `(${attempt}/${attempts - 1})...`);
      await sleep(options.retryDelayMs);
    }
  }

  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.url) {
    console.error('✖ Nessun URL configurato: passa --url oppure imposta RENDER_URL.');
    process.exitCode = 1;
    return;
  }

  const outDir = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`ℹ Aggiornamento dati da ${args.url} ` +
    `(${args.noRefresh ? 'uso la cache dell\'istanza remota' : 'scraping eseguito dall\'istanza remota'})...`);

  const leagueIds = Object.keys(LEAGUES);
  let failures = 0;

  for (const leagueId of leagueIds) {
    const dest = path.join(outDir, `${leagueId}.json`);
    let previousUpdated = null;
    try {
      if (fs.existsSync(dest)) {
        previousUpdated = JSON.parse(fs.readFileSync(dest, 'utf-8')).lastUpdated || null;
      }
    } catch (err) {
      previousUpdated = null;
    }

    try {
      const payload = await fetchLeagueWithRetry(args.url, leagueId, args.token, {
        retries: args.retries,
        retryDelayMs: args.retryDelayMs,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        noRefresh: args.noRefresh
      });
      const problem = validateLeaguePayload(payload, { expectedId: leagueId, minLastUpdated: previousUpdated });

      if (problem) {
        console.warn(`⚠ ${leagueId}: ${problem} — cache locale conservata.`);
        failures++;
        continue;
      }

      fs.writeFileSync(dest, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(`✔ ${leagueId}: ${payload.matchDays.length} giornate, ` +
        `${payload.matchDays.reduce((a, d) => a + d.matches.length, 0)} partite, ` +
        `${payload.standings.length} squadre (aggiornato ${payload.lastUpdated}).`);
    } catch (err) {
      console.warn(`⚠ ${leagueId}: ${err.message} — cache locale conservata.`);
      failures++;
    }
  }

  const updated = leagueIds.length - failures;

  if (failures === 0) {
    console.log('\n✔ Tutti i campionati sono stati aggiornati tramite l\'istanza remota.');
    return;
  }

  if (updated === 0) {
    console.error(`\n✖ Nessun campionato aggiornato dall'istanza remota (${failures}/${leagueIds.length} falliti).`);
    process.exitCode = 2;
    return;
  }

  console.error(`\n⚠ Aggiornamento remoto parziale: ${updated}/${leagueIds.length} campionati aggiornati, ` +
    `${failures} non aggiornati (cache precedente conservata).`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✖ Errore inatteso: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { validateLeaguePayload, parseArgs };
