// Calcio Toscana Dashboard Frontend Logic

let currentLeague = 'promozione-c';
let leagueData = null;
let selectedDay = null;
let currentView = 'calendar';

// Elementi DOM
const elLeaguesTabs = document.getElementById('leagues-tabs');
const elBtnRefresh = document.getElementById('btn-refresh');

const elInfoName = document.getElementById('info-name');
const elInfoCurrentDay = document.getElementById('info-current-day');
const elInfoTotalDays = document.getElementById('info-total-days');
const elInfoLastUpdated = document.getElementById('info-last-updated');

const elLoadingSpinner = document.getElementById('loading-spinner');
const elLoadingText = document.getElementById('loading-text');
const elErrorBanner = document.getElementById('error-banner');
const elErrorMessage = document.getElementById('error-message');

const elSelectDay = document.getElementById('select-day');
const elBtnPrevDay = document.getElementById('btn-prev-day');
const elBtnNextDay = document.getElementById('btn-next-day');
const elBtnAllDays = document.getElementById('btn-all-days');
const elCalendarContainer = document.getElementById('calendar-container');

const elStandingsTbody = document.getElementById('standings-tbody');

const elSelectTeam = document.getElementById('select-team');
const elBtnTeamIcs = document.getElementById('btn-team-ics');
const elTeamMatchesContainer = document.getElementById('team-matches-container');

const elBtnExportIcs = document.getElementById('btn-export-ics');
const elBtnExportCsv = document.getElementById('btn-export-csv');
const elBtnExportJson = document.getElementById('btn-export-json');

// Rilevamento ambiente (GitHub Pages vs Server Node locale/cloud)
function detectEnvironment() {
  const isGitHubPages = window.location.hostname.endsWith('github.io') || window.location.hostname.includes('github.io');
  if (isGitHubPages) {
    disableRefreshButton('Su GitHub Pages i calendari e le classifiche vengono aggiornati in automatico ogni fine settimana con GitHub Actions.');
    return;
  }

  // Se siamo altrove (localhost o Render), verifichiamo se l'API risponde
  fetch('/api/leagues')
    .then(r => {
      if (!r.ok) {
        disableRefreshButton('Server Node.js non attivo. Visualizzazione dati in modalità statica.');
      }
    })
    .catch(() => {
      disableRefreshButton('Server Node.js non attivo. Visualizzazione dati in modalità statica.');
    });
}

function disableRefreshButton(tooltipText) {
  if (!elBtnRefresh) return;
  elBtnRefresh.disabled = true;
  elBtnRefresh.classList.remove('btn-primary');
  elBtnRefresh.classList.add('btn-disabled');
  elBtnRefresh.title = tooltipText;
  elBtnRefresh.innerHTML = '<span class="btn-icon">🤖</span> Auto-Aggiornato (Actions)';
}

// Inizializzazione
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadLeague(currentLeague);
});

function setupEventListeners() {
  // Rileva se siamo su GitHub Pages o senza server Node
  detectEnvironment();

  // Cambio Campionato
  elLeaguesTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const leagueId = btn.getAttribute('data-league');
    if (leagueId === currentLeague) return;

    document.querySelectorAll('#leagues-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    currentLeague = leagueId;
    loadLeague(currentLeague);
  });

  // Aggiorna dal Web
  elBtnRefresh.addEventListener('click', (e) => {
    if (elBtnRefresh.disabled) {
      e.preventDefault();
      alert('ℹ️ Su GitHub Pages i dati vengono aggiornati automaticamente ogni fine settimana tramite GitHub Actions!\n\nPer eseguire lo scraping manuale istantaneo è necessario avviare il server Node.js in locale ("npm start") o su Render.com.');
      return;
    }
    loadLeague(currentLeague, true);
  });

  // Cambio Sotto-Vista (Calendario, Classifica, Squadra, Esporta)
  document.querySelectorAll('.sub-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sub-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const view = btn.getAttribute('data-view');
      switchView(view);
    });
  });

  // Cambio Giornata
  elSelectDay.addEventListener('change', (e) => {
    const val = e.target.value;
    selectedDay = val === 'all' ? null : parseInt(val, 10);
    renderCalendar();
  });

  elBtnPrevDay.addEventListener('click', () => {
    if (!leagueData || !leagueData.matchDays) return;
    if (selectedDay === null) selectedDay = leagueData.currentMatchDay;
    if (selectedDay > 1) {
      selectedDay--;
      elSelectDay.value = selectedDay;
      renderCalendar();
    }
  });

  elBtnNextDay.addEventListener('click', () => {
    if (!leagueData || !leagueData.matchDays) return;
    if (selectedDay === null) selectedDay = leagueData.currentMatchDay;
    if (selectedDay < leagueData.totalMatchDays) {
      selectedDay++;
      elSelectDay.value = selectedDay;
      renderCalendar();
    }
  });

  elBtnAllDays.addEventListener('click', () => {
    selectedDay = null;
    elSelectDay.value = 'all';
    renderCalendar();
  });

  // Cambio Squadra nel tab squadra
  elSelectTeam.addEventListener('change', (e) => {
    const team = e.target.value;
    renderTeamMatches(team);
  });

  // Download Esportazioni (CSV, ICS, JSON)
  elBtnExportCsv.addEventListener('click', (e) => {
    e.preventDefault();
    if (!leagueData) return;
    const csv = generateClientCsv(leagueData);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    triggerBlobDownload(blob, `${currentLeague}.csv`);
  });

  elBtnExportIcs.addEventListener('click', (e) => {
    e.preventDefault();
    if (!leagueData) return;
    const ics = generateClientFullIcs(leagueData);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    triggerBlobDownload(blob, `${currentLeague}.ics`);
  });

  elBtnExportJson.addEventListener('click', (e) => {
    e.preventDefault();
    if (!leagueData) return;
    const jsonStr = JSON.stringify(leagueData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    triggerBlobDownload(blob, `${currentLeague}.json`);
  });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));

  const activePanel = document.getElementById(`view-${view}`);
  if (activePanel) {
    activePanel.classList.remove('hidden');
  }

  if (view === 'calendar') renderCalendar();
  else if (view === 'standings') renderStandings();
  else if (view === 'team') renderTeamSection();
  else if (view === 'export') updateExportLinks();
}

async function loadLeague(leagueId, forceRefresh = false) {
  showLoading(true, forceRefresh ? 'Scraping in corso dal sito ufficiale (Tuttocampo)...' : 'Caricamento dati...');
  hideError();

  try {
    let res;
    if (forceRefresh) {
      try {
        const resp = await fetch(`/api/leagues/${leagueId}/refresh`, { method: 'POST' });
        if (!resp.ok) throw new Error(`Errore HTTP ${resp.status}`);
        res = await resp.json();
      } catch (err) {
        throw new Error('Lo scraping live richiede il server backend Node attivo. I dati su questo sito statico vengono aggiornati automaticamente ogni fine settimana da GitHub Actions.');
      }
    } else {
      // 1. Prova prima API backend (se attivo in locale o su Render)
      let loaded = false;
      try {
        const resp = await fetch(`/api/leagues/${leagueId}`);
        if (resp.ok) {
          res = await resp.json();
          loaded = true;
        }
      } catch (e) {}

      // 2. Se backend non attivo (es. GitHub Pages statico), carica JSON dalla cache
      if (!loaded) {
        const possiblePaths = [
          `data/cache/${leagueId}.json`,
          `./data/cache/${leagueId}.json`,
          `../data/cache/${leagueId}.json`
        ];
        let staticResp = null;
        for (const p of possiblePaths) {
          try {
            const r = await fetch(p);
            if (r && r.ok) {
              staticResp = r;
              break;
            }
          } catch (e) {}
        }
        if (!staticResp) throw new Error('File dati non trovato nella cache');
        res = await staticResp.json();
      }
    }

    leagueData = res.data ? res.data : res;

    selectedDay = leagueData.currentMatchDay || 1;

    renderHeaderInfo();
    populateDaySelector();
    populateTeamSelector();
    switchView(currentView);
  } catch (err) {
    showError('Impossibile caricare i dati del campionato: ' + err.message);
  } finally {
    showLoading(false);
  }
}

function renderHeaderInfo() {
  if (!leagueData) return;
  elInfoName.innerText = leagueData.name;
  elInfoCurrentDay.innerText = `${leagueData.currentMatchDay}° Giornata`;
  elInfoTotalDays.innerText = `${leagueData.totalMatchDays} giornate (${leagueData.standings?.length || 0} squadre)`;

  if (leagueData.lastUpdated) {
    const d = new Date(leagueData.lastUpdated);
    elInfoLastUpdated.innerText = d.toLocaleString('it-IT', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } else {
    elInfoLastUpdated.innerText = '-';
  }
}

function populateDaySelector() {
  if (!leagueData || !leagueData.matchDays) return;
  elSelectDay.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'Tutte le Giornate';
  elSelectDay.appendChild(optAll);

  leagueData.matchDays.forEach(day => {
    const opt = document.createElement('option');
    opt.value = day.dayNumber;
    opt.textContent = `${day.dayTitle} ${day.dayDate ? '(' + day.dayDate + ')' : ''}`;
    if (day.dayNumber === selectedDay) {
      opt.selected = true;
    }
    elSelectDay.appendChild(opt);
  });
}

function renderCalendar() {
  if (!leagueData || !leagueData.matchDays) return;

  elCalendarContainer.innerHTML = '';
  const daysToRender = selectedDay === null 
    ? leagueData.matchDays 
    : leagueData.matchDays.filter(d => d.dayNumber === selectedDay);

  if (daysToRender.length === 0) {
    elCalendarContainer.innerHTML = '<p class="empty-state">Nessuna partita disponibile.</p>';
    return;
  }

  daysToRender.forEach(day => {
    const block = document.createElement('div');
    block.className = 'matchday-block';

    const header = document.createElement('div');
    header.className = 'matchday-header';
    header.innerHTML = `
      <h3 class="matchday-title">${escapeHtml(day.dayTitle)}</h3>
      <span class="matchday-date">${escapeHtml(day.dayDate || '')}</span>
    `;
    block.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'matches-grid';

    (day.matches || []).forEach(m => {
      grid.appendChild(createMatchCard(m, day));
    });

    block.appendChild(grid);
    elCalendarContainer.appendChild(block);
  });
}

function createMatchCard(m, day) {
  const card = document.createElement('div');
  card.className = 'match-card';

  let statusBadge = '';
  if (m.status === 'FINISHED') statusBadge = '<span class="badge-status badge-finished">Terminata</span>';
  else if (m.status === 'LIVE') statusBadge = '<span class="badge-status badge-live">LIVE</span>';
  else if (m.status === 'POSTPONED') statusBadge = '<span class="badge-status badge-postponed">Rinviata</span>';
  else statusBadge = '<span class="badge-status badge-scheduled">In programma</span>';

  let scoreHtml = '<span class="score-box">- vs -</span>';
  if (m.isPlayed) {
    scoreHtml = `<span class="score-box played">${m.homeScore} - ${m.awayScore}</span>`;
  }

  let scorersHtml = '';
  const scorersList = [];
  if (m.homeScorers && m.homeScorers.length > 0) {
    scorersList.push(`<strong>${escapeHtml(m.homeTeam)}:</strong> ${escapeHtml(m.homeScorers.join(', '))}`);
  }
  if (m.awayScorers && m.awayScorers.length > 0) {
    scorersList.push(`<strong>${escapeHtml(m.awayTeam)}:</strong> ${escapeHtml(m.awayScorers.join(', '))}`);
  }
  if (scorersList.length > 0) {
    scorersHtml = `<div class="match-scorers">⚽ ${scorersList.join('<br>')}</div>`;
  }

  const dateStr = m.date || day?.dayDate || '';
  const timeStr = m.time || '15:30';

  card.innerHTML = `
    <div class="match-card-header">
      <span class="match-time">📅 ${escapeHtml(dateStr)} • ⏰ ${escapeHtml(timeStr)}</span>
      ${statusBadge}
    </div>
    <div class="match-teams-score">
      <div class="team-box home">
        <span class="team-name">${escapeHtml(m.homeTeam)}</span>
      </div>
      ${scoreHtml}
      <div class="team-box away">
        <span class="team-name">${escapeHtml(m.awayTeam)}</span>
      </div>
    </div>
    ${scorersHtml}
    ${m.matchLink ? `
      <div class="match-card-footer">
        <a href="${escapeHtml(m.matchLink)}" target="_blank" rel="noopener" class="link-info">Dettagli partita ↗</a>
      </div>
    ` : ''}
  `;

  return card;
}

function renderStandings() {
  if (!leagueData || !leagueData.standings) return;
  elStandingsTbody.innerHTML = '';

  leagueData.standings.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = `zone-${row.zone}`;

    const diffFormatted = row.goalDiff > 0 ? `+${row.goalDiff}` : `${row.goalDiff}`;

    tr.innerHTML = `
      <td class="col-pos">${row.position}</td>
      <td class="col-team">${escapeHtml(row.team)}</td>
      <td class="col-pt">${row.points}</td>
      <td>${row.played}</td>
      <td>${row.won}</td>
      <td>${row.drawn}</td>
      <td>${row.lost}</td>
      <td>${row.goalsFor}</td>
      <td>${row.goalsAgainst}</td>
      <td class="col-dr">${diffFormatted}</td>
    `;
    elStandingsTbody.appendChild(tr);
  });
}

function populateTeamSelector() {
  if (!leagueData || !leagueData.standings) return;
  elSelectTeam.innerHTML = '<option value="">-- Seleziona una squadra --</option>';

  const teams = leagueData.standings.map(s => s.team).sort();
  teams.forEach(team => {
    const opt = document.createElement('option');
    opt.value = team;
    opt.textContent = team;
    elSelectTeam.appendChild(opt);
  });
}

function renderTeamSection() {
  const team = elSelectTeam.value;
  if (team) {
    renderTeamMatches(team);
  }
}

function renderTeamMatches(team) {
  if (!team || !leagueData || !leagueData.matchDays) {
    elBtnTeamIcs.classList.add('hidden');
    elTeamMatchesContainer.innerHTML = '<p class="empty-state">Seleziona una squadra per visualizzare tutte le partite.</p>';
    return;
  }

  elBtnTeamIcs.classList.remove('hidden');
  elBtnTeamIcs.innerText = `🗓 Scarica Calendario .ICS per ${team}`;
  
  // Imposta link API server o genera Blob client-side
  elBtnTeamIcs.onclick = (e) => {
    // Prova a generare il blob localmente così funziona istantaneamente sia online che offline
    const icsContent = generateClientTeamIcs(team, teamMatches);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const safeName = team.toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    const tempA = document.createElement('a');
    tempA.href = blobUrl;
    tempA.download = `${currentLeague}_${safeName}.ics`;
    document.body.appendChild(tempA);
    tempA.click();
    document.body.removeChild(tempA);
    URL.revokeObjectURL(blobUrl);
    return false;
  };

  const teamMatches = [];
  leagueData.matchDays.forEach(day => {
    day.matches.forEach(m => {
      if (m.homeTeam === team || m.awayTeam === team) {
        teamMatches.push({ match: m, day });
      }
    });
  });

  elTeamMatchesContainer.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'matches-grid';

  teamMatches.forEach(({ match, day }) => {
    grid.appendChild(createMatchCard(match, day));
  });

  elTeamMatchesContainer.appendChild(grid);
}

function generateClientTeamIcs(team, teamMatches) {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scraper Calcio Dilettanti Toscana//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${team} - Calendario`,
    'X-WR-TIMEZONE:Europe/Rome'
  ];

  teamMatches.forEach(({ match: m, day }) => {
    let dtStart = '', dtEnd = '';
    if (m.dateTime && m.dateTime.includes('T')) {
      const [dPart, tPart] = m.dateTime.split('T');
      const [y, mo, d] = dPart.split('-').map(Number);
      const [hh, mm] = tPart.split(':').map(Number);
      const st = new Date(y, mo - 1, d, hh || 15, mm || 30);
      const en = new Date(st.getTime() + 105 * 60 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
      dtStart = `DTSTART;TZID=Europe/Rome:${fmt(st)}`;
      dtEnd = `DTEND;TZID=Europe/Rome:${fmt(en)}`;
    } else if (m.date) {
      const cl = m.date.replace(/[-]/g, '');
      dtStart = `DTSTART;VALUE=DATE:${cl}`;
      dtEnd = `DTEND;VALUE=DATE:${cl}`;
    } else {
      return;
    }

    const safeHome = m.homeTeam.replace(/[^a-zA-Z0-9]/g, '');
    const safeAway = m.awayTeam.replace(/[^a-zA-Z0-9]/g, '');
    const uid = `match-${day.dayNumber}-${safeHome}-${safeAway}@calciotoscana.local`;

    let summary = `${m.homeTeam} vs ${m.awayTeam}`;
    if (m.isPlayed) summary += ` (${m.homeScore}-${m.awayScore})`;

    let desc = `${day.dayTitle} - ${leagueData?.name || 'Campionato'}\\n`;
    if (m.isPlayed) {
      desc += `Risultato finale: ${m.homeTeam} ${m.homeScore} - ${m.awayScore} ${m.awayTeam}\\n`;
    } else {
      desc += `Partita in programma alle ${m.time || '15:30'}\\n`;
    }

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(dtStart);
    lines.push(dtEnd);
    lines.push(`SUMMARY:${summary}`);
    lines.push(`DESCRIPTION:${desc}`);
    lines.push(`LOCATION:Campo sportivo ${m.homeTeam}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function generateClientCsv(data) {
  const headers = [
    'Campionato',
    'Categoria',
    'Girone',
    'Giornata_Num',
    'Giornata_Titolo',
    'Data',
    'Ora',
    'Casa',
    'Ospiti',
    'Gol_Casa',
    'Gol_Ospiti',
    'Stato',
    'Marcatori_Casa',
    'Marcatori_Ospiti',
    'Link'
  ];

  const escapeField = (val) => {
    if (val === null || val === undefined) return '""';
    return `"${String(val).replace(/"/g, '""')}"`;
  };

  const rows = [headers.join(';')];

  for (const day of data.matchDays || []) {
    for (const m of day.matches || []) {
      const row = [
        escapeField(data.name),
        escapeField(data.category),
        escapeField(data.girone),
        day.dayNumber,
        escapeField(day.dayTitle),
        escapeField(m.date),
        escapeField(m.time),
        escapeField(m.homeTeam),
        escapeField(m.awayTeam),
        m.homeScore !== null ? m.homeScore : '',
        m.awayScore !== null ? m.awayScore : '',
        escapeField(m.status),
        escapeField((m.homeScorers || []).join(', ')),
        escapeField((m.awayScorers || []).join(', ')),
        escapeField(m.matchLink || '')
      ];
      rows.push(row.join(';'));
    }
  }

  return rows.join('\r\n');
}

function generateClientFullIcs(data) {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scraper Calcio Dilettanti Toscana//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${data.name} - Calendario`,
    'X-WR-TIMEZONE:Europe/Rome'
  ];

  for (const day of data.matchDays || []) {
    for (const m of day.matches || []) {
      let dtStart = '', dtEnd = '';
      if (m.dateTime && m.dateTime.includes('T')) {
        const [dPart, tPart] = m.dateTime.split('T');
        const [y, mo, d] = dPart.split('-').map(Number);
        const [hh, mm] = tPart.split(':').map(Number);
        const st = new Date(y, mo - 1, d, hh || 15, mm || 30);
        const en = new Date(st.getTime() + 105 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
        dtStart = `DTSTART;TZID=Europe/Rome:${fmt(st)}`;
        dtEnd = `DTEND;TZID=Europe/Rome:${fmt(en)}`;
      } else if (m.date) {
        const cl = m.date.replace(/[-]/g, '');
        dtStart = `DTSTART;VALUE=DATE:${cl}`;
        dtEnd = `DTEND;VALUE=DATE:${cl}`;
      } else {
        continue;
      }

      const safeHome = m.homeTeam.replace(/[^a-zA-Z0-9]/g, '');
      const safeAway = m.awayTeam.replace(/[^a-zA-Z0-9]/g, '');
      const uid = `match-${data.id}-${day.dayNumber}-${safeHome}-${safeAway}@calciotoscana.local`;

      let summary = `${m.homeTeam} vs ${m.awayTeam}`;
      if (m.isPlayed) summary += ` (${m.homeScore}-${m.awayScore})`;

      let desc = `${day.dayTitle} - ${data.name}\\n`;
      if (m.isPlayed) {
        desc += `Risultato finale: ${m.homeTeam} ${m.homeScore} - ${m.awayScore} ${m.awayTeam}\\n`;
        if (m.homeScorers && m.homeScorers.length > 0) {
          desc += `Marcatori ${m.homeTeam}: ${m.homeScorers.join(', ')}\\n`;
        }
        if (m.awayScorers && m.awayScorers.length > 0) {
          desc += `Marcatori ${m.awayTeam}: ${m.awayScorers.join(', ')}\\n`;
        }
      } else {
        desc += `Partita in programma alle ${m.time || '15:30'}\\n`;
      }

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(dtStart);
      lines.push(dtEnd);
      lines.push(`SUMMARY:${summary}`);
      lines.push(`DESCRIPTION:${desc}`);
      lines.push(`LOCATION:Campo sportivo ${m.homeTeam}`);
      if (m.matchLink) lines.push(`URL:${m.matchLink}`);
      lines.push('STATUS:CONFIRMED');
      lines.push('END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function updateExportLinks() {
  // Configura i link diretti per click destro "salva con nome"
  elBtnExportIcs.href = `data/exports/${currentLeague}.ics`;
  elBtnExportCsv.href = `data/exports/${currentLeague}.csv`;
  elBtnExportJson.href = `data/exports/${currentLeague}.json`;
}

function showLoading(show, text = 'Caricamento...') {
  elLoadingText.innerText = text;
  elLoadingSpinner.classList.toggle('hidden', !show);
}

function showError(msg) {
  elErrorMessage.innerText = msg;
  elErrorBanner.classList.remove('hidden');
}

function hideError() {
  elErrorBanner.classList.add('hidden');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
