const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeScrapeOutcome, EXIT_REGRESSION } = require('../bin/cli');

/**
 * `summarizeScrapeOutcome` decide il codice di uscita di `scrape all`.
 * È la parte che la CI legge dal workflow, quindi va verificata da sola:
 * prima la regressione finiva mescolata ai fallback per WAF e usciva con 0.
 */

test('scrape all: tutte le leghe aggiornate esce con 0', () => {
  const outcome = summarizeScrapeOutcome({ total: 3, fromCache: [], failed: [] });

  assert.equal(outcome.refreshed, 3);
  assert.deepEqual(outcome.regressions, []);
  assert.equal(outcome.exitCode, 0);
});

test('scrape all: una regressione esce con 3 anche se le altre leghe sono aggiornate', () => {
  const outcome = summarizeScrapeOutcome({
    total: 3,
    fromCache: [{ name: 'Promozione C', cause: 'regression', reason: 'dati in regressione: classifica più corta' }],
    failed: []
  });

  assert.equal(outcome.refreshed, 2, 'due leghe sono state aggiornate davvero');
  assert.equal(outcome.regressions.length, 1);
  assert.equal(outcome.exitCode, EXIT_REGRESSION);
  assert.equal(EXIT_REGRESSION, 3);
});

test('scrape all: solo fallback da WAF senza leghe aggiornate esce con 1', () => {
  const outcome = summarizeScrapeOutcome({
    total: 3,
    fromCache: [
      { name: 'A', cause: 'waf', reason: 'WAF: HTTP 202' },
      { name: 'B', cause: 'waf', reason: 'WAF: HTTP 202' },
      { name: 'C', cause: 'network', reason: 'fetch failed' }
    ],
    failed: []
  });

  assert.equal(outcome.refreshed, 0);
  assert.equal(outcome.exitCode, 1);
});

test('scrape all: WAF su una lega e altre aggiornate resta un successo (0)', () => {
  const outcome = summarizeScrapeOutcome({
    total: 3,
    fromCache: [{ name: 'A', cause: 'waf', reason: 'WAF: HTTP 403' }],
    failed: []
  });

  assert.equal(outcome.refreshed, 2);
  assert.equal(outcome.exitCode, 0, 'un blocco WAF parziale non è un errore fatale');
});

test('scrape all: una lega che lancia un errore esce con 1', () => {
  const outcome = summarizeScrapeOutcome({
    total: 3,
    fromCache: [],
    failed: [{ name: 'Terza Arezzo', message: 'numero di giornate non valido' }]
  });

  assert.equal(outcome.refreshed, 2);
  assert.equal(outcome.exitCode, 1);
});

test('scrape all: errore e regressione insieme danno comunque 3', () => {
  const outcome = summarizeScrapeOutcome({
    total: 3,
    fromCache: [{ name: 'B', cause: 'regression', reason: 'dati in regressione' }],
    failed: [{ name: 'C', message: 'errore di rete' }]
  });

  assert.equal(outcome.regressions.length, 1);
  assert.equal(outcome.exitCode, EXIT_REGRESSION, 'la regressione non deve essere nascosta da un errore su un\'altra lega');
});
