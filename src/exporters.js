const fs = require('fs');
const path = require('path');

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

/**
 * Esporta tutte le partite in un file CSV compatibile con Excel (con UTF-8 BOM)
 */
function exportToCsv(leagueData, outputPath, options = {}) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const teamFilter = options.team ? options.team.toLowerCase() : null;

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
        const home = m.homeTeam.toLowerCase();
        const away = m.awayTeam.toLowerCase();
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
  const bom = '\uFEFF';
  fs.writeFileSync(outputPath, bom + rows.join('\r\n'), 'utf-8');
  return outputPath;
}

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
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

function escapeIcsText(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Genera un calendario standard .ics per Google Calendar / Apple Calendar
 */
function exportToIcs(leagueData, outputPath, options = {}) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const teamFilter = options.team ? options.team.toLowerCase() : null;
  const calName = options.team 
    ? `${options.team} - ${leagueData.shortName || leagueData.name}`
    : `${leagueData.name} - Calendario`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scraper Calcio Dilettanti Toscana//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
    'X-WR-TIMEZONE:Europe/Rome'
  ];

  const nowIcs = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  for (const day of leagueData.matchDays || []) {
    for (const m of day.matches || []) {
      if (teamFilter) {
        const home = m.homeTeam.toLowerCase();
        const away = m.awayTeam.toLowerCase();
        if (!home.includes(teamFilter) && !away.includes(teamFilter)) {
          continue;
        }
      }

      const times = formatIcsDateTime(m.dateTime, m.date);
      if (!times) continue;

      const safeHome = m.homeTeam.replace(/[^a-zA-Z0-9]/g, '');
      const safeAway = m.awayTeam.replace(/[^a-zA-Z0-9]/g, '');
      const uid = `match-${leagueData.id}-${day.dayNumber}-${safeHome}-${safeAway}@calciotoscana.local`;

      let summary = `${m.homeTeam} vs ${m.awayTeam}`;
      if (m.isPlayed) {
        summary += ` (${m.homeScore}-${m.awayScore})`;
      }

      let desc = `${day.dayTitle} - ${leagueData.name}\\n`;
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
      if (m.matchLink) {
        desc += `Dettagli e formazioni: ${m.matchLink}\\n`;
      }

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${nowIcs}`);
      lines.push(times.dtStart);
      lines.push(times.dtEnd);
      lines.push(`SUMMARY:${escapeIcsText(summary)}`);
      lines.push(`DESCRIPTION:${desc}`);
      lines.push(`LOCATION:${escapeIcsText('Campo sportivo ' + m.homeTeam)}`);
      if (m.matchLink) {
        lines.push(`URL:${m.matchLink}`);
      }
      lines.push('STATUS:CONFIRMED');
      lines.push('END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  fs.writeFileSync(outputPath, lines.join('\r\n'), 'utf-8');
  return outputPath;
}

module.exports = {
  exportSlug,
  exportToJson,
  exportToCsv,
  exportToIcs
};
