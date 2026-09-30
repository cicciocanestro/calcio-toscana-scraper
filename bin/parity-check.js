#!/usr/bin/env node
/**
 * Confronta i dati ottenuti con il percorso HTTP e con quello browser.
 *
 * Non scrive nulla nel repository: serve a dimostrare che i due percorsi
 * producono gli stessi dati (e, se richiesto, che coincidono anche con la
 * cache committata).
 *
 *   node bin/parity-check.js                       # tutti i campionati, entrambi i percorsi
 *   node bin/parity-check.js --leagues promozione-c
 *   node bin/parity-check.js --http-only           # solo HTTP (nessun browser)
 *   node bin/parity-check.js --vs-cache            # confronta anche con data/cache
 *
 * Exit code: 0 se i percorsi coincidono, 1 se ci sono differenze.
 */
const fs = require('fs');
const { LEAGUES, CACHE_DIR } = require('../src/config');
const { HttpScraper } = require('../src/http-scraper');
const { CalendarScraper } = require('../src/scraper');
const { sportsFingerprint } = require('./data-changed');

function parseArgs(argv) {
  const args = { leagues: Object.keys(LEAGUES), http: true, browser: true, vsCache: false, details: 10 };
  for (let i = 2; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--leagues' && next) args.leagues = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--http-only') args.browser = false;
    else if (argv[i] === '--browser-only') args.http = false;
    else if (argv[i] === '--vs-cache') args.vsCache = true;
    else if (argv[i] === '--details' && next) args.details = parseInt(argv[++i], 10) || 10;
  }
  return args;
}

function summarize(data) {
  const matches = (data.matchDays || []).reduce((acc, day) => acc + (day.matches || []).length, 0);
  return `${(data.standings || []).length} squadre, ${(data.matchDays || []).length} giornate, ${matches} partite`;
}

/** Differenze leggibili fra due dataset (vuoto = identici). */
function describeDifferences(a, b, limit = 10) {
  const diffs = [];
  const push = (msg) => { if (diffs.length < limit) diffs.push(msg); };

  if ((a.standings || []).length !== (b.standings || []).length) {
    push(`classifica: ${a.standings.length} squadre contro ${b.standings.length}`);
  }
  (a.standings || []).forEach((row, i) => {
    const other = (b.standings || [])[i];
    if (!other) return;
    for (const field of ['team', 'points', 'played', 'won', 'drawn', 'lost', 'goalsFor', 'goalsAgainst', 'goalDiff', 'zone']) {
      if (row[field] !== other[field]) push(`classifica #${i + 1} ${row.team}: ${field} ${JSON.stringify(row[field])} → ${JSON.stringify(other[field])}`);
    }
  });

  if ((a.matchDays || []).length !== (b.matchDays || []).length) {
    push(`giornate: ${a.matchDays.length} contro ${b.matchDays.length}`);
  }
  (a.matchDays || []).forEach((day, di) => {
    const other = (b.matchDays || [])[di];
    if (!other) return;
    if ((day.matches || []).length !== (other.matches || []).length) {
      push(`giornata ${day.dayNumber}: ${day.matches.length} partite contro ${other.matches.length}`);
    }
    (day.matches || []).forEach((m, mi) => {
      const o = (other.matches || [])[mi];
      if (!o) return;
      if (m.homeTeam !== o.homeTeam || m.awayTeam !== o.awayTeam) {
        push(`giornata ${day.dayNumber} #${mi + 1}: ${m.homeTeam}-${m.awayTeam} contro ${o.homeTeam}-${o.awayTeam}`);
      } else if (m.homeScore !== o.homeScore || m.awayScore !== o.awayScore || m.status !== o.status) {
        push(`giornata ${day.dayNumber} ${m.homeTeam}-${m.awayTeam}: ${m.homeScore}-${m.awayScore}/${m.status} contro ${o.homeScore}-${o.awayScore}/${o.status}`);
      } else if (JSON.stringify(m.homeScorers) !== JSON.stringify(o.homeScorers) || JSON.stringify(m.awayScorers) !== JSON.stringify(o.awayScorers)) {
        push(`giornata ${day.dayNumber} ${m.homeTeam}-${m.awayTeam}: marcatori diversi`);
      }
    });
  });

  return diffs;
}

function same(a, b) {
  return sportsFingerprint(a) === sportsFingerprint(b);
}

async function timeIt(fn) {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

(async () => {
  const args = parseArgs(process.argv);
  const progress = (msg) => console.log(`   ℹ ${msg}`);
  let problems = 0;

  for (const id of args.leagues) {
    const league = LEAGUES[id];
    if (!league) {
      console.error(`✖ Campionato sconosciuto: ${id}`);
      problems++;
      continue;
    }

    console.log(`\n=== ${league.name} (${id}) ===`);
    const results = {};

    if (args.http) {
      const scraper = new HttpScraper({ onProgress: progress });
      try {
        const { value, ms } = await timeIt(() => scraper.scrapeLeague(league, { previousData: null }));
        results.http = value;
        console.log(`   HTTP    : ${ms} ms  | ${summarize(value)}`);
      } catch (err) {
        console.error(`   HTTP    : ❌ ${err.message}`);
        problems++;
      }
    }

    if (args.browser) {
      const scraper = new CalendarScraper({ mode: 'browser', onProgress: progress });
      try {
        const { value, ms } = await timeIt(() => scraper.produceLeagueData(league));
        results.browser = value;
        console.log(`   browser : ${ms} ms  | ${summarize(value)}`);
      } catch (err) {
        console.error(`   browser : ❌ ${err.message}`);
        problems++;
      }
    }

    if (args.vsCache) {
      const file = `${CACHE_DIR}/${id}.json`;
      if (fs.existsSync(file)) {
        results.cache = JSON.parse(fs.readFileSync(file, 'utf-8'));
        console.log(`   cache   : ${summarize(results.cache)}`);
      }
    }

    const pairs = [['http', 'browser'], ['http', 'cache'], ['browser', 'cache']];
    for (const [left, right] of pairs) {
      if (!results[left] || !results[right]) continue;
      const ok = same(results[left], results[right]);
      console.log(`   parità ${left} vs ${right}: ${ok ? '✅ identici' : '❌ DIFFERENTI'}`);
      if (!ok) {
        problems++;
        for (const diff of describeDifferences(results[left], results[right], args.details)) {
          console.log(`      - ${diff}`);
        }
      }
    }
  }

  console.log('');
  if (problems === 0) {
    console.log('✔ Nessuna differenza rilevata.');
  } else {
    console.error(`✖ Trovate ${problems} differenze/problemi.`);
    process.exitCode = 1;
  }
})();
