#!/usr/bin/env node

const { Command } = require('commander');
const Table = require('cli-table3');
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const path = require('path');
const { LEAGUES, EXPORT_DIR } = require('../src/config');
const { CalendarScraper } = require('../src/scraper');
const { exportToJson, exportToCsv, exportToIcs, exportSlug } = require('../src/exporters');
const { startServer } = require('../src/server');

const program = new Command();

program
  .name('calcio-toscana')
  .description('Tool di scraping per i calendari e risultati di Promozione Girone C, Seconda Categoria Girone I e Terza Categoria Arezzo')
  .version('1.0.0');

function getLeagueKey(arg) {
  if (!arg) return 'promozione-c';
  const clean = arg.toLowerCase().trim();
  if (clean.includes('prom') || clean === 'c' || clean === 'promozione-c') return 'promozione-c';
  if (clean.includes('second') || clean === 'i' || clean === 'seconda-i') return 'seconda-i';
  if (clean.includes('terz') || clean.includes('arezzo') || clean === 'terza-arezzo') return 'terza-arezzo';
  if (LEAGUES[clean]) return clean;

  console.error(chalk.red(`\nErrore: Campionato "${arg}" non valido!`));
  console.log(chalk.yellow(`Campionati disponibili: ${Object.keys(LEAGUES).join(', ')}`));
  process.exit(1);
}

async function getOrScrape(leagueKey, forceRefresh = false) {
  const scraper = new CalendarScraper({
    onProgress: (msg) => console.log(chalk.cyan(`ℹ ${msg}`))
  });
  return await scraper.scrapeLeague(leagueKey, { forceRefresh });
}

// COMANDO: scrape
program
  .command('scrape [league]')
  .description('Scarica o aggiorna i dati dei campionati (promozione-c, seconda-i, terza-arezzo o all)')
  .option('-r, --refresh', 'Forza il refresh ignorando la cache locale')
  .action(async (league, options) => {
    try {
      const scraper = new CalendarScraper({
        onProgress: (msg) => console.log(chalk.cyan(`ℹ ${msg}`))
      });

      if (league === 'all') {
        console.log(chalk.bold.green('\n⚽ Avvio scraping di tutti i campionati configurati...\n'));

        const keys = Object.keys(LEAGUES);
        const fromCache = [];

        for (const key of keys) {
          const data = await scraper.scrapeLeague(key, { forceRefresh: !!options.refresh });
          if (data.isStale) fromCache.push(LEAGUES[key].name);
        }

        if (fromCache.length === 0) {
          console.log(chalk.bold.green(`\n✔ Tutti i campionati (${keys.length}) sono stati aggiornati dal sito ufficiale.\n`));
        } else {
          const refreshed = keys.length - fromCache.length;
          console.warn(chalk.yellow(
            `\n⚠ Aggiornamento dal sito ufficiale riuscito per ${refreshed}/${keys.length} campionati.`
          ));
          console.warn(chalk.yellow(`  Dati non aggiornati (usata la cache locale): ${fromCache.join(', ')}`));
          console.warn(chalk.gray('  Causa tipica: blocco anti-bot/WAF sugli IP datacenter (es. runner GitHub Actions).\n'));

          // Exit code non-zero solo se NESSUN campionato è stato aggiornato,
          // così la CI può segnalare il problema senza perdere i dati in cache.
          if (refreshed === 0) process.exitCode = 1;
        }
      } else {
        const key = getLeagueKey(league);
        console.log(chalk.bold.green(`\n⚽ Aggiornamento dati per: ${LEAGUES[key].name}\n`));
        const data = await scraper.scrapeLeague(key, { forceRefresh: !!options.refresh });

        if (data.isStale) {
          console.warn(chalk.yellow('\n⚠ Aggiornamento dal sito ufficiale non riuscito: sono stati usati i dati in cache.\n'));
          process.exitCode = 1;
        } else {
          console.log(chalk.bold.green('\n✔ Aggiornamento completato con successo!\n'));
        }
      }
    } catch (err) {
      console.error(chalk.red('\nErrore durante lo scraping:'), err.message);
      process.exit(1);
    }
  });

// COMANDO: standings / classifica
program
  .command('standings [league]')
  .alias('table')
  .alias('classifica')
  .description('Mostra la classifica aggiornata del campionato')
  .option('-r, --refresh', 'Forza il refresh dei dati')
  .action(async (league, options) => {
    try {
      const key = getLeagueKey(league);
      const data = await getOrScrape(key, !!options.refresh);

      console.log(chalk.bold.yellow(`\n🏆 CLASSIFICA: ${data.name.toUpperCase()}`));
      console.log(chalk.gray(`Aggiornato al: ${new Date(data.lastUpdated).toLocaleString('it-IT')} | Giornata attuale: ${data.currentMatchDay}\n`));

      const table = new Table({
        head: ['#', 'Squadra', 'PT', 'G', 'V', 'N', 'P', 'GF', 'GS', 'DR'].map(h => chalk.bold.white(h)),
        style: { head: [], border: [] }
      });

      for (const row of data.standings) {
        let teamCell = row.team;
        if (row.zone === 'promotion') teamCell = chalk.green.bold(row.team);
        else if (row.zone === 'playoff') teamCell = chalk.cyan(row.team);
        else if (row.zone === 'playout') teamCell = chalk.magenta(row.team);
        else if (row.zone === 'retrocession') teamCell = chalk.red(row.team);

        table.push([
          row.position,
          teamCell,
          chalk.bold.yellow(row.points),
          row.played,
          row.won,
          row.drawn,
          row.lost,
          row.goalsFor,
          row.goalsAgainst,
          row.goalDiff > 0 ? chalk.green(`+${row.goalDiff}`) : row.goalDiff < 0 ? chalk.red(row.goalDiff) : '0'
        ]);
      }

      console.log(table.toString());
      console.log(chalk.gray('Legenda: ') + 
        chalk.green('■ Promozione diretta ') + 
        chalk.cyan('■ Playoff ') + 
        chalk.magenta('■ Playout ') + 
        chalk.red('■ Retrocessione\n'));
    } catch (err) {
      console.error(chalk.red('Errore:'), err.message);
      process.exit(1);
    }
  });

// COMANDO: calendar
program
  .command('calendar [league]')
  .alias('cal')
  .alias('calendario')
  .description('Mostra il calendario completo o filtrato per giornata / squadra')
  .option('-d, --day <number>', 'Numero di giornata specifico (es. -d 3)')
  .option('-t, --team <string>', 'Filtra per nome squadra (es. -t Lebowski)')
  .option('-r, --refresh', 'Forza il refresh dei dati')
  .action(async (league, options) => {
    try {
      const key = getLeagueKey(league);
      const data = await getOrScrape(key, !!options.refresh);

      const teamFilter = options.team ? options.team.toLowerCase() : null;
      const dayFilter = options.day ? parseInt(options.day, 10) : null;

      console.log(chalk.bold.yellow(`\n📅 CALENDARIO: ${data.name.toUpperCase()}`));
      if (teamFilter) console.log(chalk.cyan(`Filtro squadra: "${options.team}"`));
      if (dayFilter) console.log(chalk.cyan(`Giornata: ${dayFilter}`));
      console.log('');

      let matchedTotal = 0;

      for (const day of data.matchDays) {
        if (dayFilter && day.dayNumber !== dayFilter) continue;

        const filteredMatches = day.matches.filter(m => {
          if (!teamFilter) return true;
          return m.homeTeam.toLowerCase().includes(teamFilter) || m.awayTeam.toLowerCase().includes(teamFilter);
        });

        if (filteredMatches.length === 0) continue;

        console.log(chalk.bold.cyan(`▶ ${day.dayTitle} ${day.dayDate ? chalk.gray('(' + day.dayDate + ')') : ''}`));

        const table = new Table({
          head: ['Data', 'Ora', 'Casa', 'Ris.', 'Ospiti', 'Marcatori'].map(h => chalk.bold.white(h)),
          colWidths: [13, 8, 25, 9, 25, 30]
        });

        for (const m of filteredMatches) {
          matchedTotal++;
          let scoreText = chalk.gray('- vs -');
          if (m.isPlayed) {
            scoreText = chalk.bold.green(`${m.homeScore} - ${m.awayScore}`);
          } else if (m.status === 'LIVE') {
            scoreText = chalk.bold.red('LIVE');
          } else if (m.status === 'POSTPONED') {
            scoreText = chalk.bold.yellow('RINV.');
          }

          const allScorers = [];
          if (m.homeScorers && m.homeScorers.length > 0) {
            allScorers.push(`${chalk.gray(m.homeTeam)}: ${m.homeScorers.join(', ')}`);
          }
          if (m.awayScorers && m.awayScorers.length > 0) {
            allScorers.push(`${chalk.gray(m.awayTeam)}: ${m.awayScorers.join(', ')}`);
          }

          table.push([
            m.date || '',
            m.time || '',
            m.homeTeam,
            scoreText,
            m.awayTeam,
            allScorers.join('\n')
          ]);
        }

        console.log(table.toString());
        console.log('');
      }

      if (matchedTotal === 0) {
        console.log(chalk.yellow('Nessuna partita trovata con i filtri selezionati.\n'));
      }
    } catch (err) {
      console.error(chalk.red('Errore:'), err.message);
      process.exit(1);
    }
  });

// COMANDO: next (prossimo turno)
program
  .command('next [league]')
  .alias('prossimo')
  .description('Mostra le partite del prossimo turno in programma')
  .option('-t, --team <string>', 'Filtra per squadra')
  .option('-r, --refresh', 'Forza il refresh dei dati')
  .action(async (league, options) => {
    try {
      const key = getLeagueKey(league);
      const data = await getOrScrape(key, !!options.refresh);

      // Trova la prima giornata che ha partite non ancora giocate, oppure currentMatchDay
      let targetDay = data.matchDays.find(d => d.matches.some(m => !m.isPlayed));
      if (!targetDay) {
        targetDay = data.matchDays[data.matchDays.length - 1];
      }

      console.log(chalk.bold.green(`\n⚽ PROSSIMO TURNO: ${data.name.toUpperCase()}`));
      console.log(chalk.bold.cyan(`▶ ${targetDay.dayTitle} ${targetDay.dayDate ? chalk.gray('(' + targetDay.dayDate + ')') : ''}\n`));

      const teamFilter = options.team ? options.team.toLowerCase() : null;
      const matches = targetDay.matches.filter(m => {
        if (!teamFilter) return true;
        return m.homeTeam.toLowerCase().includes(teamFilter) || m.awayTeam.toLowerCase().includes(teamFilter);
      });

      const table = new Table({
        head: ['Data', 'Ora', 'Casa', 'vs', 'Ospiti'].map(h => chalk.bold.white(h)),
        colWidths: [14, 8, 28, 6, 28]
      });

      for (const m of matches) {
        table.push([
          m.date || targetDay.dayDate || '',
          m.time || '15:30',
          chalk.bold(m.homeTeam),
          'vs',
          chalk.bold(m.awayTeam)
        ]);
      }

      console.log(table.toString());
      console.log('');
    } catch (err) {
      console.error(chalk.red('Errore:'), err.message);
      process.exit(1);
    }
  });

// COMANDO: results (ultimi risultati)
program
  .command('results [league]')
  .alias('risultati')
  .description('Mostra i risultati dell\'ultimo turno disputato')
  .option('-t, --team <string>', 'Filtra per squadra')
  .option('-r, --refresh', 'Forza il refresh dei dati')
  .action(async (league, options) => {
    try {
      const key = getLeagueKey(league);
      const data = await getOrScrape(key, !!options.refresh);

      // Trova l'ultima giornata con partite giocate
      const playedDays = data.matchDays.filter(d => d.matches.some(m => m.isPlayed));
      const targetDay = playedDays.length > 0 ? playedDays[playedDays.length - 1] : data.matchDays[0];

      console.log(chalk.bold.green(`\n⚽ ULTIMI RISULTATI: ${data.name.toUpperCase()}`));
      console.log(chalk.bold.cyan(`▶ ${targetDay.dayTitle} ${targetDay.dayDate ? chalk.gray('(' + targetDay.dayDate + ')') : ''}\n`));

      const teamFilter = options.team ? options.team.toLowerCase() : null;
      const matches = targetDay.matches.filter(m => {
        if (!teamFilter) return true;
        return m.homeTeam.toLowerCase().includes(teamFilter) || m.awayTeam.toLowerCase().includes(teamFilter);
      });

      const table = new Table({
        head: ['Data', 'Ora', 'Casa', 'Risultato', 'Ospiti', 'Marcatori'].map(h => chalk.bold.white(h)),
        colWidths: [13, 8, 25, 11, 25, 32]
      });

      for (const m of matches) {
        const scoreStr = m.isPlayed ? chalk.bold.green(`${m.homeScore} - ${m.awayScore}`) : '-';
        const scorers = [];
        if (m.homeScorers && m.homeScorers.length > 0) scorers.push(`${m.homeTeam}: ${m.homeScorers.join(', ')}`);
        if (m.awayScorers && m.awayScorers.length > 0) scorers.push(`${m.awayTeam}: ${m.awayScorers.join(', ')}`);

        table.push([
          m.date || '',
          m.time || '',
          m.homeTeam,
          scoreStr,
          m.awayTeam,
          scorers.join('\n')
        ]);
      }

      console.log(table.toString());
      console.log('');
    } catch (err) {
      console.error(chalk.red('Errore:'), err.message);
      process.exit(1);
    }
  });

// COMANDO: export
program
  .command('export [league]')
  .description('Esporta i calendari nei formati JSON, CSV o ICS (Google/Apple Calendar)')
  .option('-f, --format <format>', 'Formato: json, csv, ics, all', 'all')
  .option('-t, --team <string>', 'Filtra solo le partite di una squadra specifica')
  .option('-o, --output <dir>', 'Directory di destinazione personalizzata')
  .option('-r, --refresh', 'Forza il refresh prima di esportare')
  .action(async (league, options) => {
    try {
      const outDir = options.output || EXPORT_DIR;
      const format = options.format.toLowerCase();
      const keys = (!league || league === 'all') ? Object.keys(LEAGUES) : [getLeagueKey(league)];

      for (const key of keys) {
        const data = await getOrScrape(key, !!options.refresh);
        const teamSlug = options.team ? `_${exportSlug(options.team)}` : '';
        const baseName = `${key}${teamSlug}`;

        console.log(chalk.bold.green(`\n📤 Esportazione per ${data.name}...`));
        if (options.team) console.log(chalk.cyan(`Filtro applicato: squadra "${options.team}"`));

        if (format === 'all' || format === 'json') {
          const p = path.join(outDir, `${baseName}.json`);
          exportToJson(data, p);
          console.log(chalk.green(`✔ JSON esportato: `) + chalk.white(p));
        }
        if (format === 'all' || format === 'csv') {
          const p = path.join(outDir, `${baseName}.csv`);
          exportToCsv(data, p, { team: options.team });
          console.log(chalk.green(`✔ CSV esportato:  `) + chalk.white(p));
        }
        if (format === 'all' || format === 'ics') {
          const p = path.join(outDir, `${baseName}.ics`);
          exportToIcs(data, p, { team: options.team });
          console.log(chalk.green(`✔ ICS esportato:  `) + chalk.white(p));
        }
      }

      console.log('');
    } catch (err) {
      console.error(chalk.red('Errore:'), err.message);
      process.exit(1);
    }
  });

// COMANDO: serve
program
  .command('serve')
  .description('Avvia la dashboard web interattiva su http://localhost:3000')
  .option('-p, --port <number>', 'Porta HTTP', process.env.PORT || '3000')
  .action((options) => {
    const port = parseInt(options.port, 10) || parseInt(process.env.PORT, 10) || 3000;
    startServer(port);
  });

// Se nessun comando viene passato
if (!process.argv.slice(2).length) {
  console.log(chalk.bold.green('\n⚽ Benvenuto nel Tool di Scraping Calendari Calcio Toscana!'));
  console.log(chalk.white('Campionati supportati:'));
  console.log('  1. ' + chalk.cyan('promozione-c') + ' : Promozione Toscana - Girone C');
  console.log('  2. ' + chalk.cyan('seconda-i') + '    : Seconda Categoria Toscana - Girone I');
  console.log('  3. ' + chalk.cyan('terza-arezzo') + ' : Terza Categoria Arezzo - Girone Unico\n');

  console.log(chalk.bold('Esempi di utilizzo:'));
  console.log(chalk.gray('  # Visualizza il prossimo turno'));
  console.log('  node bin/cli.js next promozione-c');
  console.log('  node bin/cli.js next seconda-i --team "Arezzo FA"');
  console.log('');
  console.log(chalk.gray('  # Visualizza la classifica aggiornata'));
  console.log('  node bin/cli.js standings promozione-c');
  console.log('  node bin/cli.js standings terza-arezzo');
  console.log('');
  console.log(chalk.gray('  # Visualizza il calendario filtrato'));
  console.log('  node bin/cli.js calendar promozione-c --day 4');
  console.log('  node bin/cli.js calendar promozione-c --team "Lebowski"');
  console.log('');
  console.log(chalk.gray('  # Esporta il file .ics per il tuo smartphone / calendario Google'));
  console.log('  node bin/cli.js export promozione-c --team "Lebowski" --format ics');
  console.log('');
  console.log(chalk.gray('  # Avvia l\'interfaccia web interattiva'));
  console.log('  node bin/cli.js serve\n');

  program.help();
}

program.parse(process.argv);
