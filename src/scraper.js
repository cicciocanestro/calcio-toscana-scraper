const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { findChrome, LEAGUES, CACHE_DIR, EXPORT_DIR, CACHE_TTL_MS } = require('./config');
const { parseMatchdayHtml, parseStandingsHtml } = require('./parser');
const { exportToJson, exportToCsv, exportToIcs } = require('./exporters');

class CalendarScraper {
  constructor(options = {}) {
    this.chromePath = options.chromePath || findChrome();
    this.headless = options.headless !== undefined ? options.headless : true;
    this.onProgress = options.onProgress || (() => {});
  }

  /**
   * Restituisce i dati salvati in cache se validi, altrimenti null
   */
  getCachedLeague(leagueId, maxAgeMs = CACHE_TTL_MS) {
    const league = LEAGUES[leagueId];
    if (!league || !fs.existsSync(league.cacheFile)) return null;

    try {
      const stats = fs.statSync(league.cacheFile);
      const age = Date.now() - stats.mtimeMs;
      if (age > maxAgeMs) return null;

      const raw = fs.readFileSync(league.cacheFile, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  /**
   * Scrape completo di un campionato (calendario + classifica)
   */
  async scrapeLeague(leagueId, options = {}) {
    const leagueConfig = LEAGUES[leagueId];
    if (!leagueConfig) {
      throw new Error(`Campionato sconosciuto: ${leagueId}. Valori ammessi: ${Object.keys(LEAGUES).join(', ')}`);
    }

    if (!options.forceRefresh) {
      const cached = this.getCachedLeague(leagueId);
      if (cached) {
        this.onProgress(`Dati per ${leagueConfig.name} caricati dalla cache locale.`);
        return cached;
      }
    }

    this.onProgress(`Avvio scraper per ${leagueConfig.name}...`);

    let browser = null;
    try {
      browser = await puppeteer.launch({
        executablePath: this.chromePath,
        headless: this.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ]
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      );

      this.onProgress(`Connessione a ${leagueConfig.url}...`);
      try {
        await page.goto(leagueConfig.url, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        });
      } catch (err) {
        // Se c'è un reload per WAF challenge, ignoriamo l'errore momentaneo di navigazione
      }

      // Attende che la pagina superi l'eventuale challenge WAF e carichi le variabili di sessione
      this.onProgress('Attesa caricamento sessione e token...');
      await page.waitForFunction(
        () => typeof tckk !== 'undefined' && typeof roundID !== 'undefined' && typeof matchesNumber !== 'undefined',
        { timeout: 35000 }
      );

      // Estrae metadati campionato
      const meta = await page.evaluate(() => {
        return {
          tckk,
          roundID,
          totalDays: parseInt(matchesNumber, 10),
          currentDay: parseInt(currentMatchDay, 10),
          title: document.title,
          h1Title: document.querySelector('.title-info h1')?.innerText?.replace(/\s+/g, ' ').trim() || ''
        };
      });

      this.onProgress(`Trovate ${meta.totalDays} giornate (giornata attuale: ${meta.currentDay}). Recupero classifica...`);

      // 1. Recupero Classifica
      const standings = await page.evaluate(async (tckk, roundID) => {
        try {
          const url = `/Web/Views/Rankings/RankingView.php?tckk=${tckk}&category_id=${roundID}&is_ranking_tab=true&total=true&v=1`;
          const resp = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          const html = await resp.text();
          
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const rows = Array.from(doc.querySelectorAll('table.table_ranking tbody tr, table.table_ranking tr.normal, table.table_ranking tr.playoff, table.table_ranking tr.playoff2, table.table_ranking tr.playout, table.table_ranking tr.playout2, table.table_ranking tr.promotion, table.table_ranking tr.retrocession'));
          
          const results = [];
          for (const row of rows) {
            if (row.classList.contains('team_stats_row')) continue;
            const teamEl = row.querySelector('td.team .team-name, td.team a, td.team');
            const teamName = teamEl ? teamEl.innerText.trim() : '';
            if (!teamName) continue;

            const pointsEl = row.querySelector('td.points, td.pt');
            const points = pointsEl ? parseInt(pointsEl.innerText.trim(), 10) : 0;

            const cells = Array.from(row.querySelectorAll('td'));
            const pointsIndex = cells.findIndex(c => c.classList.contains('points') || c === pointsEl);
            
            let played = 0, won = 0, drawn = 0, lost = 0, goalsFor = 0, goalsAgainst = 0, goalDiff = 0;
            if (pointsIndex !== -1 && cells.length >= pointsIndex + 8) {
              played = parseInt(cells[pointsIndex + 1]?.innerText.trim() || '0', 10);
              won = parseInt(cells[pointsIndex + 2]?.innerText.trim() || '0', 10);
              drawn = parseInt(cells[pointsIndex + 3]?.innerText.trim() || '0', 10);
              lost = parseInt(cells[pointsIndex + 4]?.innerText.trim() || '0', 10);
              goalsFor = parseInt(cells[pointsIndex + 5]?.innerText.trim() || '0', 10);
              goalsAgainst = parseInt(cells[pointsIndex + 6]?.innerText.trim() || '0', 10);
              goalDiff = parseInt(cells[pointsIndex + 7]?.innerText.trim() || '0', 10);
            }

            let zone = 'normal';
            if (row.classList.contains('promotion')) zone = 'promotion';
            else if (row.classList.contains('playoff') || row.classList.contains('playoff2')) zone = 'playoff';
            else if (row.classList.contains('playout') || row.classList.contains('playout2')) zone = 'playout';
            else if (row.classList.contains('retrocession')) zone = 'retrocession';

            results.push({
              position: results.length + 1,
              team: teamName,
              points,
              played,
              won,
              drawn,
              lost,
              goalsFor,
              goalsAgainst,
              goalDiff,
              zone
            });
          }
          return results;
        } catch (e) {
          return [];
        }
      }, meta.tckk, meta.roundID);

      // 2. Recupero di tutte le Giornate in blocchi paralleli
      this.onProgress(`Recupero di tutte le ${meta.totalDays} giornate del calendario...`);

      const daysToFetch = Array.from({ length: meta.totalDays }, (_, i) => i + 1);
      
      const matchDays = await page.evaluate(async (days, tckk, roundID) => {
        const IT_MONTHS = {
          gen: '01', gennaio: '01',
          feb: '02', febbraio: '02',
          mar: '03', marzo: '03',
          apr: '04', aprile: '04',
          mag: '05', maggio: '05',
          giu: '06', giugno: '06',
          lug: '07', luglio: '07',
          ago: '08', agosto: '08',
          set: '09', settembre: '09',
          ott: '10', ottobre: '10',
          nov: '11', novembre: '11',
          dic: '12', dicembre: '12'
        };

        function parseDayDate(dStr) {
          if (!dStr) return { defaultDate: null, defaultYear: new Date().getFullYear().toString() };
          const firstPart = dStr.split('-')[0].trim();
          const digits = firstPart.split(/[/|.-]/).map(s => s.trim());
          let defaultDate = null;
          let defaultYear = new Date().getFullYear().toString();
          if (digits.length >= 3) {
            defaultYear = digits[2];
            defaultDate = `${defaultYear}-${digits[1].padStart(2, '0')}-${digits[0].padStart(2, '0')}`;
          }
          return { defaultDate, defaultYear };
        }

        function parseHeader(text, defYear) {
          if (!text) return null;
          const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
          const tokens = clean.split(' ');
          let day = null, month = null, year = defYear;
          for (const t of tokens) {
            if (!day && /^\d{1,2}$/.test(t)) day = t.padStart(2, '0');
            else if (IT_MONTHS[t]) month = IT_MONTHS[t];
            else if (/^\d{4}$/.test(t)) year = t;
          }
          if (day && month) return `${year}-${month}-${day}`;
          return null;
        }

        const results = [];
        const chunkSize = 6;

        for (let i = 0; i < days.length; i += chunkSize) {
          const chunk = days.slice(i, i + chunkSize);
          const chunkPromises = chunk.map(async (d) => {
            const url = `/Web/Views/Results/ResultsView.php?tckk=${tckk}&category_id=${roundID}&match_day_id=${d}&v=1`;
            const resp = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            const dayTitle = doc.querySelector('#match_day')?.innerText?.trim() || `Giornata ${d}`;
            const dayDate = doc.querySelector('#match_date')?.innerText?.trim() || '';
            const { defaultDate, defaultYear } = parseDayDate(dayDate);

            const rows = Array.from(doc.querySelectorAll('table.table-results tr, #table_results_content tr'));
            let currentDate = defaultDate;
            const matches = [];

            for (const row of rows) {
              if (row.classList.contains('date')) {
                const parsed = parseHeader(row.innerText.trim(), defaultYear);
                if (parsed) currentDate = parsed;
                continue;
              }

              if (row.classList.contains('match')) {
                const timeEl = row.querySelector('.match-time .hour, .match-time, .time');
                const time = timeEl ? timeEl.innerText.trim() : '';

                const homeEl = row.querySelector('td.team.home');
                const awayEl = row.querySelector('td.team.away');

                const homeName = homeEl?.querySelector('.team-name')?.innerText?.trim() || 
                                 homeEl?.querySelector('a:not(.goal)')?.innerText?.trim() || '';
                const awayName = awayEl?.querySelector('.team-name')?.innerText?.trim() || 
                                 awayEl?.querySelector('a:not(.goal)')?.innerText?.trim() || '';

                const homeGoalRaw = homeEl?.querySelector('.goal')?.innerText?.trim();
                const awayGoalRaw = awayEl?.querySelector('.goal')?.innerText?.trim();

                const isLive = row.classList.contains('live');
                const isPostponed = row.innerText.toLowerCase().includes('rinviata') || 
                                    row.innerText.toLowerCase().includes('sospesa');

                let homeScore = null;
                let awayScore = null;
                let isPlayed = false;

                if (homeGoalRaw !== undefined && homeGoalRaw !== null && homeGoalRaw !== '-' && homeGoalRaw !== '' &&
                    awayGoalRaw !== undefined && awayGoalRaw !== null && awayGoalRaw !== '-' && awayGoalRaw !== '') {
                  const h = parseInt(homeGoalRaw, 10);
                  const a = parseInt(awayGoalRaw, 10);
                  if (!isNaN(h) && !isNaN(a)) {
                    homeScore = h;
                    awayScore = a;
                    isPlayed = true;
                  }
                }

                let status = 'SCHEDULED';
                if (isLive) status = 'LIVE';
                else if (isPostponed) status = 'POSTPONED';
                else if (isPlayed) status = 'FINISHED';

                const homeScorers = Array.from(homeEl?.querySelectorAll('ul.scorers li') || [])
                  .map(el => el.innerText.trim())
                  .filter(s => s && !s.includes('Elimina'));

                const awayScorers = Array.from(awayEl?.querySelectorAll('ul.scorers li') || [])
                  .map(el => el.innerText.trim())
                  .filter(s => s && !s.includes('Elimina'));

                const matchLink = row.getAttribute('data-link') || 
                                  row.querySelector('a.btn.info')?.getAttribute('href') || '';

                let dateTime = null;
                if (currentDate && time && time.includes(':')) {
                  dateTime = `${currentDate}T${time}:00`;
                } else if (currentDate) {
                  dateTime = `${currentDate}T15:00:00`;
                }

                matches.push({
                  homeTeam: homeName,
                  awayTeam: awayName,
                  homeScore,
                  awayScore,
                  isPlayed,
                  status,
                  date: currentDate || '',
                  time: time || '',
                  dateTime: dateTime || '',
                  homeScorers,
                  awayScorers,
                  matchLink
                });
              }
            }

            return {
              dayNumber: d,
              dayTitle,
              dayDate,
              matches
            };
          });

          const chunkRes = await Promise.all(chunkPromises);
          results.push(...chunkRes);
        }

        // Ordina le giornate per numero
        results.sort((a, b) => a.dayNumber - b.dayNumber);
        return results;
      }, daysToFetch, meta.tckk, meta.roundID);

      const leagueData = {
        id: leagueConfig.id,
        name: leagueConfig.name,
        shortName: leagueConfig.shortName,
        category: leagueConfig.category,
        girone: leagueConfig.girone,
        region: leagueConfig.region,
        province: leagueConfig.province || '',
        url: leagueConfig.url,
        roundID: meta.roundID,
        currentMatchDay: meta.currentDay,
        totalMatchDays: meta.totalDays,
        lastUpdated: new Date().toISOString(),
        standings,
        matchDays
      };

      // Salva in cache
      exportToJson(leagueData, leagueConfig.cacheFile);

      // Genera anche esportazioni standard di default
      const baseExportName = leagueConfig.id;
      exportToCsv(leagueData, path.join(EXPORT_DIR, `${baseExportName}.csv`));
      exportToIcs(leagueData, path.join(EXPORT_DIR, `${baseExportName}.ics`));
      exportToJson(leagueData, path.join(EXPORT_DIR, `${baseExportName}.json`));

      this.onProgress(`Completato scraping di ${leagueConfig.name}. Salvato in cache ed export.`);

      return leagueData;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  /**
   * Scrape di tutti i campionati configurati
   */
  async scrapeAll(options = {}) {
    const results = {};
    for (const key of Object.keys(LEAGUES)) {
      results[key] = await this.scrapeLeague(key, options);
    }
    return results;
  }
}

module.exports = { CalendarScraper };
