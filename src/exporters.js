const fs = require('fs');
const path = require('path');

/** Orario usato quando la partita non ne indica uno (coerente col parser). */
const DEFAULT_MATCH_TIME = '15:30';

/**
 * Blocco VTIMEZONE per Europe/Rome: senza, i client più rigidi (Outlook)
 * interpretano `TZID=Europe/Rome` come ora locale del dispositivo.
 * Regole UE: ultima domenica di marzo e di ottobre.
 */
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

/**
 * Slug usato nei nomi file quando si filtra per squadra
 * (es. "Centro Storico Lebowski" -> "centro_storico_lebowski").
 */
function exportSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Esporta i dati completi in formato JSON
 */
function exportToJson(leagueData, outputPath) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(leagueData, null, 2), 'utf-8');
  return outputPath;
}

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * CSV compatibile con Excel (BOM UTF-8), separatore ";".
 * Restituisce la stringa: la scrittura su disco è compito di exportToCsv.
 */
function buildCsv(leagueData, options = {}) {
  const teamFilter = options.team ? String(options.team).toLowerCase() : null;

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

  const rows = [];
  rows.push(headers.join(';'));

  for (const day of leagueData.matchDays || []) {
    for (const m of day.matches || []) {
      if (teamFilter) {
        const home = String(m.homeTeam || '').toLowerCase();
        const away = String(m.awayTeam || '').toLowerCase();
        if (!home.includes(teamFilter) && !away.includes(teamFilter)) {
          continue;
        }
      }

      const row = [
        escapeCsv(leagueData.name),
        escapeCsv(leagueData.category),
        escapeCsv(leagueData.girone),
        day.dayNumber,
        escapeCsv(day.dayTitle),
        escapeCsv(m.date),
        escapeCsv(m.time),
        escapeCsv(m.homeTeam),
        escapeCsv(m.awayTeam),
        m.homeScore !== null ? m.homeScore : '',
        m.awayScore !== null ? m.awayScore : '',
        escapeCsv(m.status),
        escapeCsv((m.homeScorers || []).join(', ')),
        escapeCsv((m.awayScorers || []).join(', ')),
        escapeCsv(m.matchLink)
      ];

      rows.push(row.join(';'));
    }
  }

  // BOM UTF-8 per far aprire correttamente il file ad Excel
  return '\uFEFF' + rows.join('\r\n');
}

/**
 * Esporta tutte le partite in un file CSV compatibile con Excel (con UTF-8 BOM)
 */
function exportToCsv(leagueData, outputPath, options = {}) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, buildCsv(leagueData, options), 'utf-8');
  return outputPath;
}

/**
 * Formatta timestamp per iCalendar (RFC 5545)
 */
function formatIcsDateTime(dateTimeStr, dateOnlyStr) {
  if (dateTimeStr && dateTimeStr.includes('T')) {
    const [dPart, tPart] = dateTimeStr.split('T');
    const [y, m, d] = dPart.split('-').map(Number);
    const [hh, mm] = tPart.split(':').map(Number);

    const startObj = new Date(y, m - 1, d, hh || 15, mm || 30);
    const endObj = new Date(startObj.getTime() + 105 * 60 * 1000); // +105 min (90 min + intervallo)

    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;

    return {
      dtStart: `DTSTART;TZID=Europe/Rome:${fmt(startObj)}`,
      dtEnd: `DTEND;TZID=Europe/Rome:${fmt(endObj)}`
    };
  }

  if (dateOnlyStr) {
    const clean = dateOnlyStr.replace(/[-]/g, '');
    return {
      dtStart: `DTSTART;VALUE=DATE:${clean}`,
      dtEnd: `DTEND;VALUE=DATE:${clean}`
    };
  }

  return null;
}

/**
 * Escape dei valori TEXT iCalendar: backslash, punto e virgola, virgola e a capo.
 */
function escapeIcsText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Line folding RFC 5545: nessuna riga oltre 75 ottetti, le continuazioni
 * iniziano con uno spazio. Il taglio avviene su un confine di carattere, così
 * non si spezza una lettera accentata a metà.
 */
function foldIcsLines(text) {
  return String(text)
    .split('\r\n')
    .map((line) => {
      if (Buffer.byteLength(line, 'utf-8') <= 75) return line;

      const pieces = [];
      let current = '';
      let currentBytes = 0;
      let limit = 75; // una continuazione consuma un ottetto per lo spazio iniziale

      for (const char of line) {
        const size = Buffer.byteLength(char, 'utf-8');
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
function icsStatus(match) {
  if (!match.isPlayed && match.status === 'POSTPONED') return 'TENTATIVE';
  return 'CONFIRMED';
}

/**
 * Genera un calendario .ics (RFC 5545) come stringa.
 * La scrittura su disco è compito di exportToIcs.
 */
function buildIcs(leagueData, options = {}) {
  const teamFilter = options.team ? String(options.team).toLowerCase() : null;
  const calName = options.team
    ? `${options.team} - ${leagueData.shortName || leagueData.name}`
    : `${leagueData.name} - Calendario`;

  const nowIcs = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

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

  for (const day of leagueData.matchDays || []) {
    for (const m of day.matches || []) {
      if (teamFilter) {
        const home = String(m.homeTeam || '').toLowerCase();
        const away = String(m.awayTeam || '').toLowerCase();
        if (!home.includes(teamFilter) && !away.includes(teamFilter)) {
          continue;
        }
      }

      const times = formatIcsDateTime(m.dateTime, m.date);
      if (!times) continue;

      const safeHome = String(m.homeTeam || '').replace(/[^a-zA-Z0-9]/g, '');
      const safeAway = String(m.awayTeam || '').replace(/[^a-zA-Z0-9]/g, '');
      const uid = `match-${leagueData.id}-${day.dayNumber}-${safeHome}-${safeAway}@calciotoscana.local`;

      let summary = `${m.homeTeam} vs ${m.awayTeam}`;
      if (m.isPlayed) {
        summary += ` (${m.homeScore}-${m.awayScore})`;
      }

      // La descrizione si compone con a capo reali e viene escapata una volta
      // sola: virgole, punti e virgola e a capo devono essere protetti.
      const descParts = [`${day.dayTitle} - ${leagueData.name}`];
      if (m.isPlayed) {
        descParts.push(`Risultato finale: ${m.homeTeam} ${m.homeScore} - ${m.awayScore} ${m.awayTeam}`);
        if (m.homeScorers && m.homeScorers.length > 0) {
          descParts.push(`Marcatori ${m.homeTeam}: ${m.homeScorers.join(', ')}`);
        }
        if (m.awayScorers && m.awayScorers.length > 0) {
          descParts.push(`Marcatori ${m.awayTeam}: ${m.awayScorers.join(', ')}`);
        }
      } else {
        descParts.push(`Partita in programma alle ${m.time || DEFAULT_MATCH_TIME}`);
      }
      if (m.matchLink) {
        descParts.push(`Dettagli e formazioni: ${m.matchLink}`);
      }

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${nowIcs}`);
      lines.push(times.dtStart);
      lines.push(times.dtEnd);
      lines.push(`SUMMARY:${escapeIcsText(summary)}`);
      lines.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`);
      lines.push(`LOCATION:${escapeIcsText('Campo sportivo ' + m.homeTeam)}`);
      if (m.matchLink) {
        lines.push(`URL:${m.matchLink}`);
      }
      lines.push(`STATUS:${icsStatus(m)}`);
      lines.push('END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');

  return foldIcsLines(lines.join('\r\n'));
}

/**
 * Genera un calendario standard .ics per Google Calendar / Apple Calendar
 */
function exportToIcs(leagueData, outputPath, options = {}) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, buildIcs(leagueData, options), 'utf-8');
  return outputPath;
}

module.exports = {
  exportSlug,
  exportToJson,
  buildCsv,
  exportToCsv,
  buildIcs,
  exportToIcs,
  escapeIcsText,
  foldIcsLines,
  icsStatus,
  formatIcsDateTime,
  ICS_TIMEZONE,
  DEFAULT_MATCH_TIME
};
