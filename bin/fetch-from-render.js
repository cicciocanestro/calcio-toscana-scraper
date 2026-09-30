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
 *
 * Variabili d'ambiente: RENDER_URL, REFRESH_TOKEN
 * Exit code: 0 se TUTTE le leghe sono state aggiornate, 1 altrimenti.
 */
const fs = require('fs');
const path = require('path');
const { LEAGUES, CACHE_DIR } = require('../src/config');

const DEFAULT_TIMEOUT_MS = 180000;

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
  const args = { url: process.env.RENDER_URL || '', out: CACHE_DIR, token: process.env.REFRESH_TOKEN || '' };
  for (let i = 2; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--url' && next) args.url = argv[++i];
    else if (argv[i] === '--out' && next) args.out = argv[++i];
    else if (argv[i] === '--token' && next) args.token = argv[++i];
  }
  return args;
}

async function fetchLeague(baseUrl, leagueId, token, timeoutMs) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/leagues/${leagueId}?refresh=true`;
  const headers = { Accept: 'application/json' };
  if (token) headers['x-refresh-token'] = token;

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`risposta non JSON (HTTP ${resp.status}): ${text.slice(0, 120)}`);
  }

  if (!resp.ok) {
    throw new Error(payload.error || `HTTP ${resp.status}`);
  }
  return payload;
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

  console.log(`ℹ Aggiornamento dati da ${args.url} (scraping eseguito dall'istanza remota)...`);

  let failures = 0;

  for (const leagueId of Object.keys(LEAGUES)) {
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
      const payload = await fetchLeague(args.url, leagueId, args.token, DEFAULT_TIMEOUT_MS);
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

  if (failures > 0) {
    console.error(`\n✖ Aggiornamento remoto incompleto: ${failures}/${Object.keys(LEAGUES).length} leghe non aggiornate.`);
    process.exitCode = 1;
  } else {
    console.log('\n✔ Tutti i campionati sono stati aggiornati tramite l\'istanza remota.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✖ Errore inatteso: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { validateLeaguePayload, parseArgs };
