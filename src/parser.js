/**
 * Parser HTML dei campionati (fonte unica di verità).
 *
 * Questo file viene usato in due contesti:
 *  1. Node.js  -> require('./parser') per i test e per gli strumenti CLI.
 *  2. Browser  -> iniettato nella pagina di Tuttocampo da src/scraper.js
 *                 (page.evaluateOnNewDocument) ed esposto come window.CalcioParser.
 *
 * Per questo motivo non deve contenere dipendenze Node (niente moduli fs/path):
 * si affida solo a DOMParser / innerText disponibili nel contesto in cui gira.
 */
(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CalcioParser = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

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

  /**
   * Testo normalizzato di un elemento: usa innerText quando disponibile
   * (browser) e textContent come fallback (DOM "leggeri" / elementi non renderizzati).
   */
  function text(el) {
    if (!el) return '';
    const raw = typeof el.innerText === 'string' && el.innerText !== ''
      ? el.innerText
      : (el.textContent || '');
    return String(raw).replace(/\s+/g, ' ').trim();
  }

  /**
   * Estrae l'anno o le date di riferimento da una stringa dayDate
   * (es. "13|09|2026" oppure "19|09|2026 - 20|09|2026").
   */
  function parseDayDateString(dayDate) {
    if (!dayDate) return { defaultDate: null, defaultYear: new Date().getFullYear().toString() };

    const parts = dayDate.split('-').map(s => s.trim());
    const firstPart = parts[0];
    const digits = firstPart.split(/[/|.-]/).map(s => s.trim());

    let defaultDate = null;
    let defaultYear = new Date().getFullYear().toString();

    if (digits.length >= 3 && /^\d{1,2}$/.test(digits[0]) && /^\d{1,2}$/.test(digits[1]) && /^\d{4}$/.test(digits[2])) {
      const day = digits[0].padStart(2, '0');
      const month = digits[1].padStart(2, '0');
      defaultYear = digits[2];
      defaultDate = `${defaultYear}-${month}-${day}`;
    }

    return { defaultDate, defaultYear };
  }

  /**
   * Converte una riga di data (es. "Sab. 19 settembre" o "Domenica 20 Settembre 2026")
   * in formato YYYY-MM-DD. Restituisce null se la data non è riconoscibile.
   */
  function parseDateHeader(input, defaultYear) {
    if (!input) return null;
    const clean = String(input).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = clean.split(' ');

    let day = null;
    let month = null;
    let year = defaultYear || new Date().getFullYear().toString();

    for (const t of tokens) {
      if (!day && /^\d{1,2}$/.test(t)) {
        day = t.padStart(2, '0');
      } else if (IT_MONTHS[t]) {
        month = IT_MONTHS[t];
      } else if (/^\d{4}$/.test(t)) {
        year = t;
      }
    }

    if (day && month) {
      return `${year}-${month}-${day}`;
    }
    return null;
  }

  function createDocument(html, functionName) {
    if (typeof DOMParser === 'undefined') {
      throw new Error(`${functionName} richiede un DOMParser (browser oppure linkedom/jsdom in Node)`);
    }
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function parseGoal(value) {
    if (value === undefined || value === null) return null;
    const clean = String(value).trim();
    if (clean === '' || clean === '-' || clean === '--') return null;
    const parsed = parseInt(clean, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseInteger(value, fallback = 0) {
    const parsed = parseInt(String(value === undefined || value === null ? '' : value).trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function parseScorers(teamEl) {
    if (!teamEl || !teamEl.querySelectorAll) return [];
    return Array.from(teamEl.querySelectorAll('ul.scorers li'))
      .map(el => text(el))
      .filter(s => s && !s.includes('Elimina'));
  }

  /**
   * Parsa il blocco HTML di una giornata (risposta di ResultsView.php).
   * @returns {{dayNumber:number, dayTitle:string, dayDate:string, matches:Array}}
   */
  function parseMatchdayHtml(html, dayNumber) {
    const doc = createDocument(html, 'parseMatchdayHtml');

    const dayTitle = text(doc.querySelector('#match_day')) || `Giornata ${dayNumber}`;
    const dayDate = text(doc.querySelector('#match_date'));

    const { defaultDate, defaultYear } = parseDayDateString(dayDate);

    const rows = Array.from(doc.querySelectorAll('table.table-results tr, #table_results_content tr'));

    let currentDate = defaultDate;
    const matches = [];

    for (const row of rows) {
      if (row.classList && row.classList.contains('date')) {
        const parsed = parseDateHeader(text(row), defaultYear);
        if (parsed) currentDate = parsed;
        continue;
      }

      if (!row.classList || !row.classList.contains('match')) continue;

      const time = text(row.querySelector('.match-time .hour, .match-time, .time'));

      const homeEl = row.querySelector('td.team.home');
      const awayEl = row.querySelector('td.team.away');

      const homeName = text(homeEl && homeEl.querySelector('.team-name'))
        || text(homeEl && homeEl.querySelector('a:not(.goal)'));
      const awayName = text(awayEl && awayEl.querySelector('.team-name'))
        || text(awayEl && awayEl.querySelector('a:not(.goal)'));

      const homeScore = parseGoal(text(homeEl && homeEl.querySelector('.goal')));
      const awayScore = parseGoal(text(awayEl && awayEl.querySelector('.goal')));
      const isPlayed = homeScore !== null && awayScore !== null;

      const rowText = text(row).toLowerCase();
      const isLive = row.classList.contains('live');
      const isPostponed = rowText.includes('rinviata') || rowText.includes('sospesa');

      let status = 'SCHEDULED';
      if (isLive) status = 'LIVE';
      else if (isPostponed) status = 'POSTPONED';
      else if (isPlayed) status = 'FINISHED';

      const logoOf = (el) => {
        const img = el && el.querySelector('img');
        if (!img) return '';
        return img.getAttribute('data-src') || img.getAttribute('src') || '';
      };

      const matchLink = row.getAttribute('data-link')
        || (row.querySelector('a.btn.info') && row.querySelector('a.btn.info').getAttribute('href'))
        || '';

      let dateTime = '';
      if (currentDate && time.includes(':')) {
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
        dateTime,
        homeScorers: parseScorers(homeEl),
        awayScorers: parseScorers(awayEl),
        homeLogo: logoOf(homeEl),
        awayLogo: logoOf(awayEl),
        matchLink
      });
    }

    return { dayNumber, dayTitle, dayDate, matches };
  }

  /**
   * Parsa il blocco HTML della classifica (risposta di RankingView.php).
   * Struttura colonne attesa: [last_match, logo, team, points, G, V, N, P, F, S, DR, details]
   */
  function parseStandingsHtml(html) {
    const doc = createDocument(html, 'parseStandingsHtml');

    const rows = Array.from(doc.querySelectorAll(
      'table.table_ranking tbody tr, table.table_ranking tr.normal, table.table_ranking tr.playoff, ' +
      'table.table_ranking tr.playoff2, table.table_ranking tr.playout, table.table_ranking tr.playout2, ' +
      'table.table_ranking tr.promotion, table.table_ranking tr.retrocession'
    ));

    const standings = [];

    for (const row of rows) {
      if (row.classList && row.classList.contains('team_stats_row')) continue;

      const teamName = text(row.querySelector('td.team .team-name, td.team a, td.team'));
      if (!teamName) continue;

      const cells = Array.from(row.querySelectorAll('td'));
      const pointsIndex = cells.findIndex(c => c.classList && (c.classList.contains('points') || c.classList.contains('pt')));

      let played = 0, won = 0, drawn = 0, lost = 0, goalsFor = 0, goalsAgainst = 0, goalDiff = 0;
      const points = pointsIndex !== -1 ? parseInteger(text(cells[pointsIndex])) : 0;

      if (pointsIndex !== -1 && cells.length >= pointsIndex + 8) {
        played = parseInteger(text(cells[pointsIndex + 1]));
        won = parseInteger(text(cells[pointsIndex + 2]));
        drawn = parseInteger(text(cells[pointsIndex + 3]));
        lost = parseInteger(text(cells[pointsIndex + 4]));
        goalsFor = parseInteger(text(cells[pointsIndex + 5]));
        goalsAgainst = parseInteger(text(cells[pointsIndex + 6]));
        goalDiff = parseInteger(text(cells[pointsIndex + 7]));
      }

      let zone = 'normal';
      if (row.classList) {
        if (row.classList.contains('promotion')) zone = 'promotion';
        else if (row.classList.contains('playoff') || row.classList.contains('playoff2')) zone = 'playoff';
        else if (row.classList.contains('playout') || row.classList.contains('playout2')) zone = 'playout';
        else if (row.classList.contains('retrocession')) zone = 'retrocession';
      }

      standings.push({
        position: standings.length + 1,
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

    return standings;
  }

  return {
    IT_MONTHS,
    text,
    parseDayDateString,
    parseDateHeader,
    parseMatchdayHtml,
    parseStandingsHtml
  };
});
