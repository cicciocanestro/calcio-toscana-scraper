const express = require('express');
const crypto = require('crypto');
const { LEAGUES, CACHE_DIR, EXPORT_DIR, PUBLIC_DIR, DB_PATH } = require('./config');
const { CalendarScraper } = require('./scraper');
const { exportSlug, filterLeagueData, buildCsv, buildIcs, stripInternalFields } = require('./exporters');
const { resolveConfig, describeConfig, dispatchWorkflow } = require('./github-dispatch');
const { initDatabase } = require('./db');
const { getTopScorers } = require('./db-sync');

/**
 * Confronto a tempo costante fra due stringhe: `===` esce al primo carattere
 * diverso e il tempo di risposta lascia intuire il token carattere per
 * carattere. La lunghezza non è un segreto, quindi il controllo preventivo
 * (necessario perché timingSafeEqual vuole buffer della stessa dimensione)
 * non indebolisce il confronto.
 */
function safeTokenEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;

  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/**
 * Rate limit minimo in memoria, senza dipendenze esterne: finestra scorrevole
 * per IP. Protegge gli endpoint pubblici — in particolare l'export, che
 * costruisce i file in memoria — da raffiche di richieste.
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60000;
  const max = options.max || 120;
  const hits = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'sconosciuto';

    // Pulizia delle finestre scadute, per non far crescere la mappa
    if (hits.size > 1000) {
      for (const [ip, times] of hits) {
        const recent = times.filter(t => now - t < windowMs);
        if (recent.length === 0) hits.delete(ip);
        else hits.set(ip, recent);
      }
    }

    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);

    if (recent.length > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'Troppe richieste: riprova fra poco.' });
    }

    return next();
  };
}

/**
 * `?team=` può arrivare come array (`?team=a&team=b`): lo normalizziamo a una
 * sola stringa, con lunghezza limitata, altrimenti gli exporter riceverebbero
 * un array e la richiesta finirebbe in errore 500.
 * @returns {string|null}
 */
function normalizeTeamParam(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return null;

  const team = String(raw).trim().slice(0, 100);
  return team || null;
}

/**
 * Crea l'applicazione Express.
 *
 * @param {object} options
 * @param {CalendarScraper} [options.scraper]        - scraper da usare (utile nei test)
 * @param {boolean} [options.autoRevalidate=true]    - aggiorna in background i campionati scaduti
 * @param {Function|null} [options.dispatchUpdate]   - pubblica su GitHub dopo un refresh manuale.
 *                                                     Default: dispatcher da variabili d'ambiente,
 *                                                     oppure null se non configurato. Passare una
 *                                                     funzione per i test, `null` per disattivare.
 * @param {object} [options.exportRateLimit]         - soglia del rate limit sull'export
 *                                                     ({ windowMs, max }). Default: 120 al minuto.
 */
function createServer(options = {}) {
  const app = express();
  app.set('trust proxy', 1);

  const scraper = options.scraper || new CalendarScraper({
    onProgress: (msg) => console.log(`[SCRAPER] ${msg}`)
  });
  const autoRevalidate = options.autoRevalidate !== false;

  // Connessione SQLite condivisa (lazy) per non riaprire il DB a ogni richiesta
  let dbInstance = options.db || null;
  function getDb() {
    if (!dbInstance) {
      dbInstance = initDatabase(DB_PATH);
    }
    return dbInstance;
  }

  // Pubblicazione su GitHub: attiva solo se configurata (vedi src/github-dispatch.js)
  const githubConfig = resolveConfig();
  const dispatchUpdate = options.dispatchUpdate !== undefined
    ? options.dispatchUpdate
    : (githubConfig ? () => dispatchWorkflow(githubConfig) : null);

  // Richieste di ri-scraping in corso, per non duplicare lo stesso lavoro
  const revalidations = new Map();

  // Aggiornamento globale in corso, letto da /api/leagues per il polling client
  let globalRefreshTask = null;

  /**
   * Dopo un refresh *manuale* chiede al workflow GitHub di pubblicare i dati.
   * Best-effort: un errore non deve mai compromettere la risposta di scraping.
   */
  function requestGitHubPublish(reason) {
    if (typeof dispatchUpdate !== 'function') return;

    Promise.resolve()
      .then(() => dispatchUpdate(reason))
      .then((result) => {
        console.log(`[SERVER] Workflow GitHub avviato (${reason})${result && result.repo ? ` su ${result.repo}` : ''}.`);
      })
      .catch((err) => {
        console.warn(`[SERVER] Workflow GitHub non avviato (${reason}): ${err.message}`);
      });
  }

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

  // Rate limit per le API pubbliche di lettura: /api/leagues parsa i JSON di
  // tutti i campionati a ogni richiesta, quindi senza limite una raffica
  // costringe il Pi a leggere e interpretare la cache in continuazione.
  // La soglia è volutamente larga: la dashboard fa polling e non deve rompersi.
  const apiRateLimit = createRateLimiter(
    options.apiRateLimit || { windowMs: 60 * 1000, max: 300 }
  );

  // Aggiornamento forzato protetto da token condiviso (opzionale).
  // Se REFRESH_TOKEN non è impostato il comportamento resta quello di prima,
  // così lo sviluppo locale e i deploy esistenti continuano a funzionare.
  const refreshToken = process.env.REFRESH_TOKEN || '';

  if (!refreshToken && process.env.NODE_ENV === 'production') {
    console.warn(
      '[SERVER] ⚠ REFRESH_TOKEN non impostato: chiunque conosca l\'URL può avviare uno scraping forzato.'
    );
  }

  function requireRefreshToken(req, res, next) {
    if (!refreshToken) return next();
    if (safeTokenEquals(req.get('x-refresh-token'), refreshToken)) return next();
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
  // Serviamo miratamente solo cache ed exports: la cartella data/db/ (calcio.sqlite,
  // snapshot.jsonl) NON deve essere esposta pubblicamente.
  app.use('/data/cache', express.static(CACHE_DIR));
  app.use('/data/exports', express.static(EXPORT_DIR));

  // Health check leggero (usato da Render): non legge né interpreta la cache,
  // a differenza di /api/leagues che deve parsare i JSON di tutti i campionati.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // Diagnostica: commit in esecuzione, modalità di scraping e percorso usato
  // l'ultima volta per ogni campionato (nessun dato sensibile).
  app.get('/api/diagnostics', (req, res) => {
    const diagnostics = typeof scraper.getDiagnostics === 'function' ? scraper.getDiagnostics() : {};
    res.json({
      service: 'calcio-toscana-scraper',
      // Dice se dopo un refresh manuale verrà avviato il workflow GitHub,
      // e in caso negativo quale requisito manca
      github: describeConfig(),
      ...diagnostics,
      cache: Object.keys(LEAGUES).map(key => ({ id: key, ...scraper.getCacheStatus(key) }))
    });
  });

  // Lista campionati supportati, stato cache e aggiornamenti in corso
  app.get('/api/leagues', apiRateLimit, (req, res) => {
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
  app.get('/api/leagues/:id', apiRateLimit, guardForcedRefresh, async (req, res) => {
    const id = req.params.id;
    if (!LEAGUES[id]) {
      return res.status(404).json({ error: `Campionato '${id}' non trovato` });
    }

    try {
      const refresh = req.query.refresh === 'true';
      if (refresh) {
        const data = await scraper.scrapeLeague(id, { forceRefresh: true });
        return res.json(stripInternalFields(data));
      }

      const cache = scraper.getCacheStatus(id);
      if (cache.exists) {
        const data = await scraper.scrapeLeague(id, { cacheFirst: true });
        if (cache.isStale && autoRevalidate) {
          revalidate(id);
        }
        return res.json(stripInternalFields(data));
      }

      const data = await scraper.scrapeLeague(id);
      res.json(stripInternalFields(data));
    } catch (err) {
      console.error(`Errore caricamento ${id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // Classifica marcatori aggregata dal database relazionale
  app.get('/api/leagues/:id/scorers', apiRateLimit, (req, res) => {
    const id = req.params.id;
    if (!LEAGUES[id]) {
      return res.status(404).json({ error: `Campionato '${id}' non trovato` });
    }

    try {
      const parsedLimit = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(100, Math.max(1, parsedLimit))
        : 20;
      const scorers = getTopScorers(getDb(), id, limit);
      res.json({ leagueId: id, scorers });
    } catch (err) {
      console.error(`Errore caricamento marcatori per ${id}:`, err);
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

      // Questo percorso è usato solo dall'aggiornamento manuale (la CI usa
      // `GET ?refresh=true`): se almeno un campionato è stato davvero riscaricato
      // chiediamo al workflow GitHub di pubblicarlo nel repository.
      if (Object.values(results).some(data => data && !data.isStale)) {
        requestGitHubPublish('aggiornamento manuale di tutti i campionati');
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
        // `isStale`/`staleReason`/`staleCause` servono solo internamente:
        // il motivo grezzo può contenere percorsi del filesystem.
        const publicResults = {};
        for (const [key, value] of Object.entries(results)) {
          publicResults[key] = stripInternalFields(value);
        }
        return res.json({ success: true, message: 'Tutti i campionati sono stati aggiornati con successo', data: publicResults });
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
        if (data && !data.isStale) requestGitHubPublish(`aggiornamento manuale di ${id}`);
        return res.json({ success: true, message: 'Dati aggiornati con successo', data: stripInternalFields(data) });
      }

      // In background: la pubblicazione parte solo se lo scraping è riuscito
      task.then(
        (data) => {
          if (data && !data.isStale) requestGitHubPublish(`aggiornamento manuale di ${id}`);
        },
        () => {}
      );

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

  // Download export (CSV, ICS, JSON) con filtro squadra opzionale.
  // Il contenuto viene generato in memoria: nessun file temporaneo su disco,
  // così richieste ripetute non si sovrascrivono e non si accumulano.
  // Il rate limit protegge l'endpoint, che è pubblico e costoso da servire.
  const exportRateLimit = createRateLimiter(
    options.exportRateLimit || { windowMs: 60 * 1000, max: 120 }
  );

  app.get('/api/leagues/:id/export/:format', exportRateLimit, async (req, res) => {
    const { id, format } = req.params;
    const team = normalizeTeamParam(req.query.team);

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
      const filename = `${id}${teamSuffix}.${format}`;

      const formats = {
        json: { body: JSON.stringify(filterLeagueData(data, { team }), null, 2), type: 'application/json; charset=utf-8' },
        csv: { body: buildCsv(data, { team }), type: 'text/csv; charset=utf-8' },
        ics: { body: buildIcs(data, { team }), type: 'text/calendar; charset=utf-8' }
      };

      res.setHeader('Content-Type', formats[format].type);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(formats[format].body);
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
  startServer,
  normalizeTeamParam,
  safeTokenEquals,
  createRateLimiter
};
