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
 * Estrae l'anno o le date di riferimento da una stringa dayDate (es. "13|09|2026" o "19|09|2026 - 20|09|2026")
 */
function parseDayDateString(dayDate) {
  if (!dayDate) return { defaultDate: null, defaultYear: new Date().getFullYear().toString() };
  
  const parts = dayDate.split('-').map(s => s.trim());
  const firstPart = parts[0];
  const digits = firstPart.split(/[/|.-]/).map(s => s.trim());

  let defaultDate = null;
  let defaultYear = new Date().getFullYear().toString();

  if (digits.length >= 3) {
    const day = digits[0].padStart(2, '0');
    const month = digits[1].padStart(2, '0');
    defaultYear = digits[2];
    defaultDate = `${defaultYear}-${month}-${day}`;
  }

  return { defaultDate, defaultYear };
}

/**
 * Converte una riga di data (es. "Sab. 19 settembre" o "Domenica 20 Settembre 2026") in formato YYYY-MM-DD
 */
function parseDateHeader(text, defaultYear) {
  if (!text) return null;
  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = clean.split(' ');

  let day = null;
  let month = null;
  let year = defaultYear;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
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

/**
 * Parsa il blocco HTML di una giornata (restituito da ResultsView.php)
 * Questa funzione può essere eseguita sia nel browser sia via DOMParser/Cheerio
 */
function parseMatchdayHtml(html, dayNumber) {
  // Parsing universale compatibile con browser DOMParser o JSDOM/Node
  // Se eseguito nel browser, usiamo document / DOMParser
  let doc;
  if (typeof DOMParser !== 'undefined') {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } else {
    // In node, creiamo una mini implementazione o usiamo jsdom se serve
    throw new Error('parseMatchdayHtml va eseguita nel contesto browser o con un DOMParser');
  }

  const dayTitleEl = doc.querySelector('#match_day');
  const dayDateEl = doc.querySelector('#match_date');

  const dayTitle = dayTitleEl ? dayTitleEl.innerText.trim() : `Giornata ${dayNumber}`;
  const dayDate = dayDateEl ? dayDateEl.innerText.trim() : '';

  const { defaultDate, defaultYear } = parseDayDateString(dayDate);

  const rows = Array.from(doc.querySelectorAll('table.table-results tr, #table_results_content tr'));
  
  let currentDate = defaultDate;
  const matches = [];

  for (const row of rows) {
    if (row.classList.contains('date')) {
      const dateText = row.innerText.trim();
      const parsed = parseDateHeader(dateText, defaultYear);
      if (parsed) {
        currentDate = parsed;
      }
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

      const homeLogo = homeEl?.querySelector('img')?.getAttribute('data-src') || 
                       homeEl?.querySelector('img')?.getAttribute('src') || '';
      const awayLogo = awayEl?.querySelector('img')?.getAttribute('data-src') || 
                       awayEl?.querySelector('img')?.getAttribute('src') || '';

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

      // Marcatori
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
        homeLogo,
        awayLogo,
        matchLink
      });
    }
  }

  return {
    dayNumber,
    dayTitle,
    dayDate,
    matches
  };
}

/**
 * Parsa il blocco HTML della classifica (restituito da RankingView.php)
 */
function parseStandingsHtml(html) {
  let doc;
  if (typeof DOMParser !== 'undefined') {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } else {
    throw new Error('parseStandingsHtml va eseguita nel contesto browser');
  }

  const rows = Array.from(doc.querySelectorAll('table.table_ranking tbody tr, table.table_ranking tr.normal, table.table_ranking tr.playoff, table.table_ranking tr.playoff2, table.table_ranking tr.playout, table.table_ranking tr.playout2, table.table_ranking tr.promotion, table.table_ranking tr.retrocession'));
  
  const standings = [];

  rows.forEach((row, index) => {
    // Evita header duplicati o righe statistiche nascoste
    if (row.classList.contains('team_stats_row')) return;

    const teamEl = row.querySelector('td.team .team-name, td.team a, td.team');
    const teamName = teamEl ? teamEl.innerText.trim() : '';
    if (!teamName) return;

    const pointsEl = row.querySelector('td.points, td.pt');
    const points = pointsEl ? parseInt(pointsEl.innerText.trim(), 10) : 0;

    const cells = Array.from(row.querySelectorAll('td'));
    // Struttura colonne: [last_match, team_logo, team, points, G, V, N, P, F, S, DR, details]
    // Individuiamo le celle numeriche dopo points
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
  });

  return standings;
}

module.exports = {
  IT_MONTHS,
  parseDayDateString,
  parseDateHeader,
  parseMatchdayHtml,
  parseStandingsHtml
};
