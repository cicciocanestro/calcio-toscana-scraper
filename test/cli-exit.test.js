const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summarizeScrapeOutcome, writeReportIfRequested, EXIT_REGRESSION } = require('../bin/cli');

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

test('--report-file scrive un JSON leggibile dalla CI e distingue le leghe aggiornate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-report-'));
  const reportFile = path.join(dir, 'scrape-report.json');

  const fromCache = [{ name: 'Promozione C', cause: 'regression', reason: 'dati in regressione: classifica più corta' }];
  const outcome = summarizeScrapeOutcome({ total: 3, fromCache, failed: [] });

  try {
    const written = writeReportIfRequested(reportFile, {
      total: 3,
      refreshed: outcome.refreshed,
      regressions: outcome.regressions,
      fromCache,
      failed: [],
      exitCode: outcome.exitCode
    });

    assert.equal(written, reportFile);
    assert.ok(fs.existsSync(reportFile));

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    assert.equal(report.total, 3);
    assert.equal(report.refreshed, 2, 'la CI deve sapere che due leghe sono state aggiornate');
    assert.equal(report.regressions.length, 1);
    assert.equal(report.regressions[0].name, 'Promozione C');
    assert.equal(report.exitCode, EXIT_REGRESSION);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeReportIfRequested non fa nulla senza percorso', () => {
  assert.equal(writeReportIfRequested(undefined, { total: 0 }), null);
  assert.equal(writeReportIfRequested('', { total: 0 }), null);
});

test('writeReportIfRequested segnala un errore di scrittura senza lanciare', () => {
  // Percorso sotto una directory che non può esistere (un file al suo posto)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-report-err-'));
  const blockingFile = path.join(dir, 'bloccante');
  fs.writeFileSync(blockingFile, 'x');
  const target = path.join(blockingFile, 'sub', 'report.json');

  try {
    assert.equal(writeReportIfRequested(target, { total: 0 }), null, 'non deve lanciare');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
