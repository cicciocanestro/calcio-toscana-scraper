const express = require('express');
const path = require('path');
const fs = require('fs');
const { LEAGUES, EXPORT_DIR } = require('./config');
const { CalendarScraper } = require('./scraper');
const { exportToJson, exportToCsv, exportToIcs } = require('./exporters');

function createServer() {
  const app = express();
  const scraper = new CalendarScraper();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Lista campionati supportati e stato cache
  app.get('/api/leagues', (req, res) => {
    const list = Object.keys(LEAGUES).map(key => {
      const cfg = LEAGUES[key];
      const cached = scraper.getCachedLeague(key);
      return {
        id: cfg.id,
        name: cfg.name,
        shortName: cfg.shortName,
        category: cfg.category,
        girone: cfg.girone,
        region: cfg.region,
        province: cfg.province || '',
        url: cfg.url,
        isCached: !!cached,
        lastUpdated: cached?.lastUpdated || null,
        currentMatchDay: cached?.currentMatchDay || null,
        totalMatchDays: cached?.totalMatchDays || null,
        teamsCount: cached?.standings?.length || 0
      };
    });
    res.json(list);
  });

  // Dati completi di un campionato
  app.get('/api/leagues/:id', async (req, res) => {
    const id = req.params.id;
    if (!LEAGUES[id]) {
      return res.status(404).json({ error: `Campionato '${id}' non trovato` });
    }

    try {
      const refresh = req.query.refresh === 'true';
      const data = await scraper.scrapeLeague(id, { forceRefresh: refresh });
      res.json(data);
    } catch (err) {
      console.error(`Errore caricamento ${id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // Forza refresh/scraping di un campionato
  app.post('/api/leagues/:id/refresh', async (req, res) => {
    const id = req.params.id;
    if (!LEAGUES[id]) {
      return res.status(404).json({ error: `Campionato '${id}' non trovato` });
    }

    try {
      console.log(`[SERVER] Richiesto aggiornamento per ${id}...`);
      const data = await scraper.scrapeLeague(id, { forceRefresh: true });
      res.json({ success: true, message: 'Dati aggiornati con successo', data });
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

    try {
      let data = scraper.getCachedLeague(id);
      if (!data) {
        data = await scraper.scrapeLeague(id);
      }

      const teamSuffix = team ? `_${team.toLowerCase().replace(/[^a-z0-9]/g, '_')}` : '';
      const tempFilename = `${id}${teamSuffix}.${format}`;
      const tempPath = path.join(EXPORT_DIR, tempFilename);

      if (format === 'json') {
        exportToJson(data, tempPath);
        return res.download(tempPath, `${id}${teamSuffix}.json`);
      } else if (format === 'csv') {
        exportToCsv(data, tempPath, { team });
        return res.download(tempPath, `${id}${teamSuffix}.csv`);
      } else if (format === 'ics') {
        exportToIcs(data, tempPath, { team });
        return res.download(tempPath, `${id}${teamSuffix}.ics`);
      } else {
        return res.status(400).json({ error: `Formato non supportato: ${format}. Usa json, csv o ics.` });
      }
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
