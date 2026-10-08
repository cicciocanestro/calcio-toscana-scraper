// Calcio Toscana Dashboard Frontend Logic

let currentLeague = 'promozione-c';
let leagueData = null;
let selectedDay = null;
let currentView = 'calendar';

// Scheda "CC Camucia": partite in casa delle squadre del territorio, che
// militano in tre campionati diversi. La corrispondenza è parziale e in
// minuscolo, così regge anche se il sito cambia leggermente la denominazione.
const CAMUCIA_LEAGUE_IDS = ['promozione-c', 'seconda-i', 'terza-arezzo'];
const CAMUCIA_TEAMS = ['cortona camucia', 'fratta', 'fratticciola', 'montecchio', 'monsigliolo'];

let camuciaLeagues = null;            // [{ id, data }] dei campionati caricati
let camuciaSelectedWeekend = null;    // chiave ISO del weekend (null = tutti)
let camuciaWeekendInitialized = false;

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

const elSelectCamuciaWeekend = document.getElementById('select-camucia-weekend');
const elBtnCamuciaPrev = document.getElementById('btn-camucia-prev');
const elBtnCamuciaNext = document.getElementById('btn-camucia-next');
const elBtnCamuciaAll = document.getElementById('btn-camucia-all');
const elCamuciaContainer = document.getElementById('camucia-container');

const elStandingsTbody = document.getElementById('standings-tbody');

const elSelectTeam = document.getElementById('select-team');
const elBtnTeamIcs = document.getElementById('btn-team-ics');
const elTeamMatchesContainer = document.getElementById('team-matches-container');

const elBtnExportIcs = document.getElementById('btn-export-ics');
const elBtnExportCsv = document.getElementById('btn-export-csv');
const elBtnExportJson = document.getElementById('btn-export-json');
const elRefreshWrapper = document.getElementById('refresh-wrapper');

let isStaticEnvironment = false;

// Rilevamento ambiente (GitHub Pages vs Server Node locale/cloud)
function detectEnvironment() {
  const isGitHubPages = window.location.hostname.endsWith('github.io');
  if (isGitHubPages) {
    setupStaticMode();
    return;
  }

  // Se siamo altrove (localhost o Render), verifichiamo se l'API risponde
  fetch('/api/leagues', { cache: 'no-cache' })
    .then(r => {
      if (!r.ok) setupStaticMode();
    })
    .catch(() => setupStaticMode());
}

function setupStaticMode() {
  isStaticEnvironment = true;
  if (!elBtnRefresh) return;
  elBtnRefresh.classList.remove('btn-primary');
  elBtnRefresh.classList.add('btn-disabled');
  elBtnRefresh.innerHTML = '<span class="btn-icon">🤖</span> Auto-Aggiornato (Actions)';
  if (elRefreshWrapper) {
    elRefreshWrapper.classList.add('is-static');
  }
}

// Inizializzazione
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadLeague(currentLeague);
});

function setupEventListeners() {
  // Rileva se siamo su GitHub Pages o senza server Node
  detectEnvironment();

  // Chiudi tooltip se clicchi fuori
  document.addEventListener('click', (e) => {
    if (elRefreshWrapper && !elRefreshWrapper.contains(e.target)) {
      elRefreshWrapper.classList.remove('show-tooltip');
    }
  });

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

  // Aggiorna dal Web / Click su Auto-Aggiornato
  elBtnRefresh.addEventListener('click', (e) => {
    e.preventDefault();
    if (isStaticEnvironment) {
      if (elRefreshWrapper) {
        elRefreshWrapper.classList.toggle('show-tooltip');
      }
      alert(
        '🤖 AGGIORNAMENTO AUTOMATICO ATTIVO\n\n' +
        'Su GitHub Pages il backend Node.js non è attivo in background: i calendari, i risultati e le classifiche vengono aggiornati automaticamente ogni fine settimana (domenica sera e lunedì mattina) tramite GitHub Actions.\n\n' +
        '👉 Per eseguire lo scraping live immediato è possibile avviare il tool in locale sul proprio computer (con "npm start") oppure ospitarlo gratuitamente su Render.com col Dockerfile già presente nel progetto.'
      );
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

  // Scheda CC Camucia: selettore di weekend indipendente
  elSelectCamuciaWeekend.addEventListener('change', (e) => {
    const val = e.target.value;
    camuciaSelectedWeekend = val === 'all' ? null : val;
    renderCamuciaMatches();
  });

  elBtnCamuciaPrev.addEventListener('click', () => stepCamuciaWeekend(-1));
  elBtnCamuciaNext.addEventListener('click', () => stepCamuciaWeekend(1));

  elBtnCamuciaAll.addEventListener('click', () => {
    camuciaSelectedWeekend = null;
    elSelectCamuciaWeekend.value = 'all';
    renderCamuciaMatches();
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
    const ics = generateClientIcs(leagueData);
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
  else if (view === 'camucia') openCamuciaView();
  else if (view === 'standings') renderStandings();
  else if (view === 'team') renderTeamSection();
}

async function refreshAllLeagues() {
  showLoading(true, 'Aggiornamento dal sito ufficiale in corso in background (Tuttocampo)...');
  hideError();

  // I dati della scheda CC Camucia vanno riletti dopo un aggiornamento
  camuciaLeagues = null;

  try {
    const initialLastUpdated = leagueData?.lastUpdated || null;
    let resp = await fetch('/api/leagues/refresh-all', { method: 'POST' });
    if (!resp.ok) {
      // Se l'endpoint globale fallisce, tenta il refresh della singola lega
      resp = await fetch(`/api/leagues/${currentLeague}/refresh`, { method: 'POST' });
      if (!resp.ok) throw new Error(`Errore HTTP ${resp.status}`);
    }

    const startPayload = await resp.json();

    // Se il server ha già completato in modo sincrono:
    if (startPayload.data) {
      if (startPayload.data[currentLeague]) {
        leagueData = startPayload.data[currentLeague];
      } else if (startPayload.data.id === currentLeague) {
        leagueData = startPayload.data;
      }
      selectedDay = leagueData.currentMatchDay || 1;
      renderHeaderInfo();
      populateDaySelector();
      populateTeamSelector();
      switchView(currentView);
      showLoading(false);
      return;
    }

    // Se l'aggiornamento è stato accettato in background (status 202 o inProgress),
    // effettuiamo polling periodico su /api/leagues per monitorare il completamento
    const maxPollAttempts = 40; // max ~2 minuti (40 * 3s)
    for (let i = 0; i < maxPollAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));

      try {
        const checkResp = await fetch(`/api/leagues?t=${Date.now()}`, { cache: 'no-cache' });
        if (checkResp.ok) {
          const leagues = await checkResp.json();
          const target = leagues.find(l => l.id === currentLeague);
          // Terminato se non è più in corso di revalidation e i dati sono stati aggiornati
          if (target && !target.isRevalidating && (!initialLastUpdated || target.lastUpdated !== initialLastUpdated)) {
            break;
          }
        }
      } catch (pollErr) {
        // Ignora errori temporanei di rete durante il poll
      }
    }

    // Ricarica la lega corrente con i dati aggiornati
    await loadLeague(currentLeague, false);
  } catch (err) {
    showError('Impossibile aggiornare i campionati: ' + (err.message || 'Errore di connessione col backend'));
    showLoading(false);
  }
}

/**
 * Dati di un campionato: prima l'API backend (locale o Render), altrimenti il
 * JSON statico della cache (GitHub Pages). Riusata anche dalla scheda CC Camucia.
 */
async function fetchLeagueData(leagueId) {
  // 1. API backend
  try {
    const resp = await fetch(`/api/leagues/${leagueId}?t=${Date.now()}`, { cache: 'no-cache' });
    if (resp.ok) {
      const res = await resp.json();
      return res.data ? res.data : res;
    }
  } catch (e) {}

  // 2. Cache statica
  const t = Date.now();
  const possiblePaths = [
    `data/cache/${leagueId}.json?t=${t}`,
    `./data/cache/${leagueId}.json?t=${t}`,
    `../data/cache/${leagueId}.json?t=${t}`
  ];
  for (const p of possiblePaths) {
    try {
      const r = await fetch(p, { cache: 'no-cache' });
      if (r && r.ok) {
        const res = await r.json();
        return res.data ? res.data : res;
      }
    } catch (e) {}
  }

  throw new Error('File dati non trovato nella cache');
}

async function loadLeague(leagueId, forceRefresh = false) {
  if (forceRefresh) {
    return refreshAllLeagues();
  }
  showLoading(true, 'Caricamento dati...');
  hideError();

  try {
    leagueData = await fetchLeagueData(leagueId);

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
    const formatted = d.toLocaleString('it-IT', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    // I dati possono arrivare dalla cache locale mentre l'aggiornamento
    // dal sito ufficiale è ancora in corso (o non è disponibile).
    elInfoLastUpdated.innerText = leagueData.isStale ? `${formatted} · cache locale` : formatted;
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

// ---------------------------------------------------------------------------
// Scheda "CC Camucia"
// ---------------------------------------------------------------------------

/** True se la squadra rientra fra quelle seguite dalla scheda CC Camucia. */
function isCamuciaTeam(name) {
  const clean = String(name || '').toLowerCase();
  return CAMUCIA_TEAMS.some(team => clean.includes(team));
}

const MESI_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/**
 * Chiave della settimana ISO di una data YYYY-MM-DD (es. "2026-W41").
 *
 * Serve a raggruppare sabato e domenica dello stesso weekend (più l'eventuale
 * turno infrasettimanale della stessa settimana). I tre campionati non giocano
 * la stessa giornata nello stesso fine settimana, quindi la giornata non è un
 * buon criterio di raggruppamento: la settimana sì.
 *
 * @returns {string|null} null se la data non è leggibile
 */
function isoWeekKey(dateStr) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!parts) return null;

  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  // Una settimana ISO è identificata dal suo giovedì
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3);

  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);

  const week = 1 + Math.round((date - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Sabato e domenica della settimana ISO indicata, in formato YYYY-MM-DD.
 * Il weekend viene etichettato con l'intervallo sabato-domenica (es. il 10 e 11
 * ottobre), non con le sole date in cui giocano le squadre seguite.
 */
function isoWeekRange(key) {
  const parts = /^(\d{4})-W(\d{2})$/.exec(String(key || ''));
  if (!parts) return null;

  // Il 4 gennaio appartiene sempre alla settimana 1: da lì risalgo al lunedì
  const jan4 = new Date(Date.UTC(Number(parts[1]), 0, 4));
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));

  const monday = new Date(mondayOfWeek1);
  monday.setUTCDate(mondayOfWeek1.getUTCDate() + (Number(parts[2]) - 1) * 7);

  const saturday = new Date(monday);
  saturday.setUTCDate(monday.getUTCDate() + 5);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return { from: saturday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

/**
 * Etichetta italiana di un intervallo di date YYYY-MM-DD.
 * Es. "2026-10-10" + "2026-10-11" -> "10–11 ottobre 2026".
 */
function formatDateRange(fromStr, toStr) {
  const parse = (value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  };

  const from = parse(fromStr);
  if (!from) return '';
  const to = parse(toStr) || from;

  if (from.y === to.y && from.m === to.m && from.d === to.d) {
    return `${from.d} ${MESI_IT[from.m - 1]} ${from.y}`;
  }
  if (from.y === to.y && from.m === to.m) {
    return `${from.d}–${to.d} ${MESI_IT[from.m - 1]} ${from.y}`;
  }
  return `${from.d} ${MESI_IT[from.m - 1]} – ${to.d} ${MESI_IT[to.m - 1]} ${to.y}`;
}

/**
 * Blocchi di partite in casa delle squadre CC Camucia: un blocco per giornata
 * di un campionato, già filtrato per weekend.
 *
 * @param {Array<{data:object}>} leagues campionati caricati
 * @param {string|null} weekendKey chiave ISO del weekend (null = tutti)
 */
function collectCamuciaBlocks(leagues, weekendKey = null) {
  const blocks = [];

  for (const entry of leagues || []) {
    const data = entry && entry.data;
    for (const day of (data && data.matchDays) || []) {
      const matches = (day.matches || []).filter(m =>
        isCamuciaTeam(m.homeTeam) && (weekendKey === null || isoWeekKey(m.date) === weekendKey)
      );
      if (matches.length === 0) continue;

      const dates = matches.map(m => m.date).filter(Boolean).sort();
      blocks.push({
        league: data,
        day,
        matches,
        from: dates[0] || '',
        to: dates[dates.length - 1] || ''
      });
    }
  }

  blocks.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    const nameA = String(a.league.shortName || a.league.name);
    const nameB = String(b.league.shortName || b.league.name);
    return nameA.localeCompare(nameB);
  });

  return blocks;
}

/** Weekend con almeno una partita in casa, ordinati per data. */
function camuciaWeekendOptions() {
  const keys = new Set();

  for (const block of collectCamuciaBlocks(camuciaLeagues, null)) {
    const key = isoWeekKey(block.from);
    if (key) keys.add(key);
  }

  return [...keys]
    .map(key => {
      const range = isoWeekRange(key) || { from: '', to: '' };
      return { key, from: range.from, to: range.to, label: formatDateRange(range.from, range.to) };
    })
    .sort((a, b) => (a.from < b.from ? -1 : 1));
}

/** Weekend da mostrare all'apertura: il prossimo, altrimenti l'ultimo. */
function defaultCamuciaWeekend(options) {
  if (!options || options.length === 0) return null;

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const next = options.find(w => w.to >= today);
  return (next || options[options.length - 1]).key;
}

/** Sposta la selezione al weekend precedente (-1) o successivo (+1). */
function stepCamuciaWeekend(delta) {
  const options = camuciaWeekendOptions();
  if (options.length === 0) return;

  let index = options.findIndex(w => w.key === camuciaSelectedWeekend);
  // Da "tutti i weekend": con +1 si parte dal primo, con -1 dall'ultimo
  if (index === -1) index = delta > 0 ? -1 : options.length;

  const target = options[index + delta];
  if (!target) return;

  camuciaSelectedWeekend = target.key;
  if (elSelectCamuciaWeekend) elSelectCamuciaWeekend.value = target.key;
  renderCamuciaMatches();
}

/** Carica i tre campionati coinvolti (una sola volta per sessione). */
async function loadCamuciaLeagues() {
  if (camuciaLeagues) return camuciaLeagues;

  const loaded = await Promise.all(CAMUCIA_LEAGUE_IDS.map(async (id) => {
    try {
      return { id, data: await fetchLeagueData(id) };
    } catch (e) {
      return { id, data: null };
    }
  }));

  camuciaLeagues = loaded.filter(entry => entry.data);
  // Se non si è caricato nulla non memorizziamo il fallimento: si ritenta
  // alla prossima apertura della scheda.
  if (camuciaLeagues.length === 0) camuciaLeagues = null;
  return camuciaLeagues;
}

function populateCamuciaWeekendSelector() {
  if (!elSelectCamuciaWeekend || !camuciaLeagues) return;

  elSelectCamuciaWeekend.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'Tutti i weekend';
  elSelectCamuciaWeekend.appendChild(optAll);

  for (const weekend of camuciaWeekendOptions()) {
    const opt = document.createElement('option');
    opt.value = weekend.key;
    opt.textContent = weekend.label;
    if (weekend.key === camuciaSelectedWeekend) opt.selected = true;
    elSelectCamuciaWeekend.appendChild(opt);
  }
}

function renderCamuciaMatches() {
  if (!elCamuciaContainer) return;

  if (!camuciaLeagues || camuciaLeagues.length === 0) {
    elCamuciaContainer.innerHTML = '<p class="empty-state">Dati dei campionati non disponibili.</p>';
    return;
  }

  const options = camuciaWeekendOptions();
  const selected = options.find(w => w.key === camuciaSelectedWeekend);
  const weekends = camuciaSelectedWeekend === null ? options : (selected ? [selected] : []);

  elCamuciaContainer.innerHTML = '';
  let total = 0;

  for (const weekend of weekends) {
    const blocks = collectCamuciaBlocks(camuciaLeagues, weekend.key);
    if (blocks.length === 0) continue;

    const heading = document.createElement('h2');
    heading.className = 'weekend-heading';
    heading.textContent = weekend.label;
    elCamuciaContainer.appendChild(heading);

    for (const block of blocks) {
      const blockEl = document.createElement('div');
      blockEl.className = 'matchday-block';

      const header = document.createElement('div');
      header.className = 'matchday-header';
      header.innerHTML = `
        <h3 class="matchday-title">${escapeHtml(block.league.shortName || block.league.name)}</h3>
        <span class="matchday-date">${escapeHtml(block.day.dayTitle || '')}${block.from ? ' · ' + escapeHtml(formatDateRange(block.from, block.to)) : ''}</span>
      `;
      blockEl.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'matches-grid';
      block.matches.forEach(m => grid.appendChild(createMatchCard(m, block.day)));

      blockEl.appendChild(grid);
      elCamuciaContainer.appendChild(blockEl);
      total += block.matches.length;
    }
  }

  if (total === 0) {
    elCamuciaContainer.innerHTML =
      '<p class="empty-state">Nessuna partita in casa delle squadre CC Camucia per il weekend selezionato.</p>';
  }
}

/** Apre la scheda: carica i dati se serve, poi popola selettore ed elenco. */
async function openCamuciaView() {
  if (!camuciaLeagues) {
    showLoading(true, 'Caricamento partite CC Camucia...');
    hideError();
    try {
      await loadCamuciaLeagues();
    } catch (err) {
      showError('Impossibile caricare i dati per CC Camucia: ' + err.message);
    } finally {
      showLoading(false);
    }
  }

  if (!camuciaWeekendInitialized && camuciaLeagues && camuciaLeagues.length > 0) {
    camuciaSelectedWeekend = defaultCamuciaWeekend(camuciaWeekendOptions());
    camuciaWeekendInitialized = true;
  }

  populateCamuciaWeekendSelector();
  renderCamuciaMatches();
}

function createMatchCard(m, day) {
  const card = document.createElement('div');
  card.className = 'match-card';

  let statusBadge = '';
  if (m.status === 'FINISHED') statusBadge = '<span class="badge-status badge-finished">Terminata</span>';
  else if (m.status === 'LIVE') statusBadge = '<span class="badge-status badge-live">LIVE</span>';
  else if (m.status === 'POSTPONED') statusBadge = '<span class="badge-status badge-postponed">Rinviata</span>';
  else statusBadge = '<span class="badge-status badge-scheduled">In programma</span>';

  const isHomeWinner = m.isPlayed && m.homeScore > m.awayScore;
  const isAwayWinner = m.isPlayed && m.awayScore > m.homeScore;

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
    <div class="match-teams-list">
      <div class="team-row home ${isHomeWinner ? 'winner' : ''}">
        <span class="team-name">${escapeHtml(m.homeTeam)}</span>
        <span class="team-score ${m.isPlayed ? 'played' : ''}">${m.isPlayed ? m.homeScore : '-'}</span>
      </div>
      <div class="team-row away ${isAwayWinner ? 'winner' : ''}">
        <span class="team-name">${escapeHtml(m.awayTeam)}</span>
        <span class="team-score ${m.isPlayed ? 'played' : ''}">${m.isPlayed ? m.awayScore : '-'}</span>
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

  const teamMatches = [];
  leagueData.matchDays.forEach(day => {
    day.matches.forEach(m => {
      if (m.homeTeam === team || m.awayTeam === team) {
        teamMatches.push({ match: m, day });
      }
    });
  });

  elBtnTeamIcs.classList.remove('hidden');
  elBtnTeamIcs.innerText = `🗓 Scarica Calendario .ICS per ${team}`;

  // Il calendario viene generato localmente: funziona sia col server attivo sia su GitHub Pages
  elBtnTeamIcs.onclick = (e) => {
    e.preventDefault();
    const icsContent = generateClientIcs(leagueData, { team });
    const safeName = team.toLowerCase().replace(/[^a-z0-9]/g, '_');
    triggerBlobDownload(new Blob([icsContent], { type: 'text/calendar;charset=utf-8' }), `${currentLeague}_${safeName}.ics`);
  };

  elTeamMatchesContainer.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'matches-grid';

  teamMatches.forEach(({ match, day }) => {
    grid.appendChild(createMatchCard(match, day));
  });

  elTeamMatchesContainer.appendChild(grid);
}

/**
 * Formatta inizio/fine evento iCalendar a partire dai campi della partita.
 * Restituisce null se non c'è una data utilizzabile.
 */
function formatIcsEventTimes(m) {
  if (m.dateTime && m.dateTime.includes('T')) {
    const [dPart, tPart] = m.dateTime.split('T');
    const [y, mo, d] = dPart.split('-').map(Number);
    const [hh, mm] = tPart.split(':').map(Number);
    const start = new Date(y, mo - 1, d, hh || 15, mm || 30);
    const end = new Date(start.getTime() + 105 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
    return {
      start: `DTSTART;TZID=Europe/Rome:${fmt(start)}`,
      end: `DTEND;TZID=Europe/Rome:${fmt(end)}`
    };
  }

  if (m.date) {
    const day = m.date.replace(/[-]/g, '');
    return { start: `DTSTART;VALUE=DATE:${day}`, end: `DTEND;VALUE=DATE:${day}` };
  }

  return null;
}

/**
 * Genera un calendario .ics lato client.
 * Con `options.team` limita gli eventi alle partite di quella squadra.
 */
// Blocco VTIMEZONE per Europe/Rome (regole UE: ultima domenica di marzo e
// ottobre). Senza, i client più rigidi interpretano TZID come ora locale.
const ICS_TIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Rome',
  'X-LIC-LOCATION:Europe/Rome',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
];

/** Escape dei valori TEXT iCalendar (backslash, punto e virgola, virgola, a capo). */
function escapeIcsText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Lunghezza in ottetti UTF-8 (serve per il folding a 75 ottetti). */
function utf8Length(str) {
  return new TextEncoder().encode(str).length;
}

/** Line folding RFC 5545: righe da massimo 75 ottetti, continuazioni con spazio. */
function foldIcsLines(text) {
  return String(text)
    .split('\r\n')
    .map((line) => {
      if (utf8Length(line) <= 75) return line;

      const pieces = [];
      let current = '';
      let currentBytes = 0;
      let limit = 75; // una continuazione consuma un ottetto per lo spazio iniziale

      for (const char of line) {
        const size = utf8Length(char);
        if (currentBytes + size > limit && current !== '') {
          pieces.push(current);
          current = char;
          currentBytes = size;
          limit = 74;
        } else {
          current += char;
          currentBytes += size;
        }
      }
      pieces.push(current);

      return pieces.join('\r\n ');
    })
    .join('\r\n');
}

/** STATUS iCalendar: una partita rinviata non è confermata. */
function icsStatus(m) {
  if (!m.isPlayed && m.status === 'POSTPONED') return 'TENTATIVE';
  return 'CONFIRMED';
}

function generateClientIcs(data, options = {}) {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const calName = options.team ? `${options.team} - Calendario` : `${data.name} - Calendario`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scraper Calcio Dilettanti Toscana//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
    'X-WR-TIMEZONE:Europe/Rome',
    ...ICS_TIMEZONE
  ];

  for (const day of data.matchDays || []) {
    for (const m of day.matches || []) {
      if (options.team && m.homeTeam !== options.team && m.awayTeam !== options.team) continue;

      const times = formatIcsEventTimes(m);
      if (!times) continue;

      const safeHome = m.homeTeam.replace(/[^a-zA-Z0-9]/g, '');
      const safeAway = m.awayTeam.replace(/[^a-zA-Z0-9]/g, '');
      const uid = `match-${data.id}-${day.dayNumber}-${safeHome}-${safeAway}@calciotoscana.local`;

      let summary = `${m.homeTeam} vs ${m.awayTeam}`;
      if (m.isPlayed) summary += ` (${m.homeScore}-${m.awayScore})`;

      // La descrizione si compone con a capo reali e viene escapata una volta
      // sola: virgole e punti e virgola dei nomi e dei marcatori vanno protetti.
      const descParts = [`${day.dayTitle} - ${data.name}`];
      if (m.isPlayed) {
        descParts.push(`Risultato finale: ${m.homeTeam} ${m.homeScore} - ${m.awayScore} ${m.awayTeam}`);
        if (m.homeScorers && m.homeScorers.length > 0) {
          descParts.push(`Marcatori ${m.homeTeam}: ${m.homeScorers.join(', ')}`);
        }
        if (m.awayScorers && m.awayScorers.length > 0) {
          descParts.push(`Marcatori ${m.awayTeam}: ${m.awayScorers.join(', ')}`);
        }
      } else {
        descParts.push(`Partita in programma alle ${m.time || '15:30'}`);
      }

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(times.start);
      lines.push(times.end);
      lines.push(`SUMMARY:${escapeIcsText(summary)}`);
      lines.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`);
      lines.push(`LOCATION:${escapeIcsText('Campo sportivo ' + m.homeTeam)}`);
      if (m.matchLink) lines.push(`URL:${m.matchLink}`);
      lines.push(`STATUS:${icsStatus(m)}`);
      lines.push('END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  return foldIcsLines(lines.join('\r\n'));
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
