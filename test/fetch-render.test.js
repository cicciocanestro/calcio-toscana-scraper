const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateLeaguePayload, parseArgs } = require('../bin/fetch-from-render');
const { sampleLeagueData } = require('./fixtures');

test('validateLeaguePayload accetta un aggiornamento completo e fresco', () => {
  const payload = sampleLeagueData();
  payload.lastUpdated = '2026-09-30T10:00:00.000Z';

  assert.equal(validateLeaguePayload(payload), null);
  assert.equal(validateLeaguePayload(payload, { minLastUpdated: '2026-09-29T10:00:00.000Z' }), null);
});

test('validateLeaguePayload rifiuta risposte non aggiornate o incomplete', () => {
  const base = sampleLeagueData();
  base.lastUpdated = '2026-09-30T10:00:00.000Z';

  // Il server ha ripiegato sulla cache: non è un aggiornamento reale
  assert.match(validateLeaguePayload({ ...base, isStale: true }), /cache locale/);

  // Errore restituito dall'API
  assert.match(validateLeaguePayload({ error: '403 Forbidden' }), /403 Forbidden/);

  // Dati incompleti
  assert.match(validateLeaguePayload({ ...base, standings: [] }), /classifica vuota/);
  assert.match(validateLeaguePayload({ ...base, matchDays: [] }), /calendario vuoto/);
  assert.match(
    validateLeaguePayload({ ...base, matchDays: [{ dayNumber: 1, matches: [] }] }),
    /nessuna partita/
  );

  // Timestamp assente o non valido
  const noDate = { ...base };
  delete noDate.lastUpdated;
  assert.match(validateLeaguePayload(noDate), /lastUpdated mancante/);
  assert.match(validateLeaguePayload({ ...base, lastUpdated: 'non-una-data' }), /lastUpdated non valido/);

  // Dati più vecchi di quelli già in cache
  assert.match(
    validateLeaguePayload({ ...base, lastUpdated: '2026-09-01T00:00:00.000Z' }, { minLastUpdated: base.lastUpdated }),
    /non più recenti/
  );

  // Payload non oggetto
  assert.match(validateLeaguePayload('<!DOCTYPE html>'), /non valida/);
  assert.match(validateLeaguePayload(null), /non valida/);
});

test('parseArgs legge URL, cartella di output e token', () => {
  const args = parseArgs(['node', 'script', '--url', 'https://example.com', '--out', '/tmp/x', '--token', 'abc']);
  assert.equal(args.url, 'https://example.com');
  assert.equal(args.out, '/tmp/x');
  assert.equal(args.token, 'abc');

  const defaults = parseArgs(['node', 'script']);
  assert.equal(defaults.url, '');
  assert.ok(path.isAbsolute(defaults.out), 'la cartella di default deve essere assoluta');
});

test('validateLeaguePayload rifiuta un campionato diverso da quello richiesto', () => {
  const payload = sampleLeagueData();
  payload.lastUpdated = '2026-09-30T10:00:00.000Z';

  assert.equal(validateLeaguePayload(payload, { expectedId: 'promozione-c' }), null);
  assert.match(validateLeaguePayload(payload, { expectedId: 'terza-arezzo' }), /campionato inatteso/);
});

test('il comando di fetch scrive la cache leggendo da un\'istanza remota', async () => {
  const http = require('node:http');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, token: req.headers['x-refresh-token'] || '' });
    res.setHeader('content-type', 'application/json');

    // Una lega fallisce: il comando deve conservare la cache e uscire con errore
    if (req.url.includes('seconda-i')) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: '403 Forbidden' }));
    }

    const id = req.url.split('/api/leagues/')[1].split('?')[0];
    res.end(JSON.stringify({ ...sampleLeagueData(), id, lastUpdated: new Date().toISOString() }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-fetch-'));

  try {
    let failed = false;
    try {
      await run(process.execPath, [
        path.join(__dirname, '..', 'bin', 'fetch-from-render.js'),
        '--url', base,
        '--out', outDir,
        '--token', 'token-di-prova'
      ], { cwd: path.join(__dirname, '..') });
    } catch (err) {
      failed = true;
      assert.equal(err.code, 1, 'exit code 1 quando una lega non si aggiorna');
    }
    assert.equal(failed, true, 'il comando deve fallire se una lega non si aggiorna');

    // Solo le leghe aggiornate vengono scritte
    assert.deepEqual(fs.readdirSync(outDir).sort(), ['promozione-c.json', 'terza-arezzo.json']);

    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'promozione-c.json'), 'utf-8'));
    assert.equal(written.id, 'promozione-c');
    assert.ok(written.standings.length > 0);

    // Il token condiviso viene inviato e l'endpoint forzato è quello giusto
    assert.equal(requests.length, 3);
    for (const req of requests) {
      assert.match(req.url, /\?refresh=true$/);
      assert.equal(req.token, 'token-di-prova');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
