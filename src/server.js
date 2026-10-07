const express = require('express');
const path = require('path');
const { LEAGUES, DATA_DIR, PUBLIC_DIR, EXPORT_DIR } = require('./config');
const { CalendarScraper } = require('./scraper');
const { exportToJson, exportToCsv, exportToIcs, exportSlug } = require('./exporters');

/**
 * Crea l'applicazione Express.
 *
 * @param {object} options
 * @param {CalendarScraper} [options.scraper]        - scraper da usare (utile nei test)
 * @param {boolean} [options.autoRevalidate=true]    - aggiorna in background i campionati scaduti
 */
function createServer(options = {}) {
  const app = express();
  const scraper = options.scraper || new CalendarScraper({
    onProgress: (msg) => console.log(`[SCRAPER] ${msg}`)
  });
  const autoRevalidate = options.autoRevalidate !== false;

  // Richieste di ri-scraping in corso, per non duplicare lo stesso lavoro
  const revalidations = new Map();

  // Aggiornamento globale in corso, letto da /api/leagues per il polling client
  let globalRefreshTask = null;

  function revalidate(leagueId) {
    if (revalidations.has(leagueId)) return revalidations.get(leagueId);

    const promise = scraper
      .scrapeLeague(leagueId, { forceRefresh: true })
      .then((data) => {
        console.log(`[SERVER] Dati aggiornati in background per ${leagueId}.`);
        return data;
      })
      .catch((err) => {
        console.warn(`[SERVER] Aggiornamento in background di ${leagueId} non riuscito: ${err.message}`);
        return null;
      })
      .finally(() => revalidations.delete(leagueId));

    revalidations.set(leagueId, promise);
    return promise;
  }

  app.use(express.json());

  // Aggiornamento forzato protetto da token condiviso (opzionale).
  // Se REFRESH_TOKEN non è impostato il comportamento resta quello di prima,
  // così lo sviluppo locale e i deploy esistenti continuano a funzionare.
  const refreshToken = process.env.REFRESH_TOKEN || '';

  function requireRefreshToken(req, res, next) {
    if (!refreshToken) return next();
    if (req.get('x-refresh-token') === refreshToken) return next();
    return res.status(401).json({ error: 'Token di aggiornamento mancante o non valido.' });
  }

  // Il token serve solo quando la richiesta chiede esplicitamente uno scraping live
  function guardForcedRefresh(req, res, next) {
    if (req.query.refresh === 'true') return requireRefreshToken(req, res, next);
    return next();
  }

  // Solo la dashboard può essere servita staticamente: NON l'intera root del
  // progetto (src/, bin/, package.json, node_modules non devono essere esposti).
  app.use(express.static(PUBLIC_DIR));

  // I dati (cache JSON + export ICS/CSV/JSON) restano raggiungibili dalla
  // dashboard statica su GitHub Pages tramite gli stessi percorsi relativi.
  app.use('/data', express.static(DATA_DIR));

  // Diagnostica: commit in esecuzione, modalità di scraping e percorso usato
  // l'ultima volta per ogni campionato (nessun dato sensibile).
  app.get('/api/diagnostics', (req, res) => {
    const diagnostics = typeof scraper.getDiagnostics === 'function' ? scraper.getDiagnostics() : {};
    res.json({
      service: 'calcio-toscana-scraper',
      ...diagnostics,
      cache: Object.keys(LEAGUES).map(key => ({ id: key, ...scraper.getCacheStatus(key) }))
    });
  });

  // Lista campionati supportati, stato cache e aggiornamenti in corso
  app.get('/api/leagues', (req, res) => {
    const list = Object.keys(LEAGUES).map(key => {
      const cfg = LEAGUES[key];
      const cache = scraper.getCacheStatus(key);
      const cached = cache.exists ? scraper.getCachedLeague(key, null) : null;
      return {
        id: cfg.id,
        name: cfg.name,
        shortName: cfg.shortName,
        category: cfg.category,
        girone: cfg.girone,
        region: cfg.region,
        province: cfg.province || '',
        url: cfg.url,
        isCached: cache.exists,
        isStale: cache.isStale,
        isRevalidating: revalidations.has(key) || !!globalRefreshTask,
        lastUpdated: cached?.lastUpdated || cache.lastUpdated || null,
        currentMatchDay: cached?.currentMatchDay || null,
        totalMatchDays: cached?.totalMatchDays || null,
        teamsCount: cached?.standings?.length || 0
      };
    });
    res.json(list);
  });

  // Dati completi di un campionato.
  // Default: risposta immediata dalla cache (anche scaduta) + aggiornamento in
  // background. Con ?refresh=true si attende lo scraping dal sito sorgente.
  app.get('/api/leagues/:id', guardForcedRefresh, async (req, res) => {
    const id = req.params.id;
    if (!LEAGUES[id]) {
      return res.status(404).json({ error: `Campionato '${id}' non trovato` });
    }

    try {
      const refresh = req.query.refresh === 'true';
      if (refresh) {
        const data = await scraper.scrapeLeague(id, { forceRefresh: true });
        return res.json(data);
      }

      const cache = scraper.getCacheStatus(id);
      if (cache.exists) {
        const data = await scraper.scrapeLeague(id, { cacheFirst: true });
        if (cache.isStale && autoRevalidate) {
          revalidate(id);
        }
        return res.json(data);
      }

      const data = await scraper.scrapeLeague(id);
      res.json(data);
    } catch (err) {
      console.error(`Errore caricamento ${id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // Avvia (una sola volta) lo scraping di tutti i campionati in background
  function runGlobalRefresh() {
    if (globalRefreshTask) return globalRefreshTask;

    globalRefreshTask = (async () => {
      console.log('[SERVER] Avvio aggiornamento globale in background...');
      const results = {};
      for (const id of Object.keys(LEAGUES)) {
        try {
          results[id] = await scraper.scrapeLeague(id, { forceRefresh: true });
        } catch (err) {
          console.warn(`[SERVER] Errore aggiornamento ${id}:`, err.message);
        }
      }
      return results;
    })().finally(() => {
      globalRefreshTask = null;
    });

    return globalRefreshTask;
  }

  // Forza refresh/scraping di tutti i campionati:
  // Supporta sia esecuzione asincrona non-bloccante (default, evita timeout proxy/502)
  // sia bloccante/sincrona (con ?sync=true)
  app.post('/api/leagues/refresh-all', requireRefreshToken, async (req, res) => {
    try {
      const sync = req.query.sync === 'true';
      const task = runGlobalRefresh();

      if (sync) {
        const results = await task;
        return res.json({ success: true, message: 'Tutti i campionati sono stati aggiornati con successo', data: results });
      }

      // 202 Accepted: avvisiamo il client che l'operazione è in corso
      res.status(202).json({
        success: true,
        message: 'Aggiornamento avviato in background',
        inProgress: true
      });
    } catch (err) {
      console.error('Errore aggiornamento globale campionati:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Forza refresh/scraping di un singolo campionato
  app.post('/api/leagues/:id/refresh', requireRefreshToken, async (req, res) => {
    const id = req.params.id;
    if (!LEAGUES[id]) {
      return res.status(404).json({ error: `Campionato '${id}' non trovato` });
    }

    try {
      const sync = req.query.sync === 'true';
      const task = revalidate(id);

      if (sync) {
        const data = await task;
        return res.json({ success: true, message: 'Dati aggiornati con successo', data });
      }

      res.status(202).json({
        success: true,
        message: `Aggiornamento di ${id} avviato in background`,
        inProgress: true
      });
    } catch (err) {
      console.error(`Errore aggiornamento ${id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // Download export (CSV, ICS, JSON) con filtro squadra opzionale
  app.get('/api/leagues/:id/export/:format', async (req, res) => {
    const { id, format } = req.params;
    const team = req.query.team || null;

    if (!LEAGUES[id]) {
      return res.status(404).json({ error: `Campionato '${id}' non trovato` });
    }
    if (!['json', 'csv', 'ics'].includes(format)) {
      return res.status(400).json({ error: `Formato non supportato: ${format}. Usa json, csv o ics.` });
    }

    try {
      // Usa la cache anche scaduta: l'export non deve mai bloccare la richiesta
      let data = scraper.getCachedLeague(id, null);
      if (!data) {
        data = await scraper.scrapeLeague(id);
      }

      const teamSuffix = team ? `_${exportSlug(team)}` : '';
      const tempFilename = `${id}${teamSuffix}.${format}`;
      const tempPath = path.join(EXPORT_DIR, tempFilename);

      if (format === 'json') {
        exportToJson(data, tempPath);
      } else if (format === 'csv') {
        exportToCsv(data, tempPath, { team });
      } else {
        exportToIcs(data, tempPath, { team });
      }

      return res.download(tempPath, `${id}${teamSuffix}.${format}`);
    } catch (err) {
      console.error('Errore export:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

function startServer(port = 3000) {
  const app = createServer();
  const server = app.listen(port, () => {
    console.log(`\n🚀 Dashboard Web attiva su: http://localhost:${port}`);
    console.log(`Premi CTRL+C per terminare il server.\n`);
  });
  return server;
}

module.exports = {
  createServer,
  startServer
};
