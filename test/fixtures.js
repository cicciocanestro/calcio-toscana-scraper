/**
 * Fixture HTML ispirate alle risposte reali di Tuttocampo
 * (ResultsView.php e RankingView.php) usate dai test del parser.
 */

// Classifica: 3 squadre "normali" + 1 squadra senza partite giocate ("-").
// Struttura colonne: [last_match, logo, team, points, G, V, N, P, F, S, DR, details]
const STANDINGS_HTML = `
<table class="table_ranking">
  <tbody>
    <tr class="team_stats_row"><td colspan="12">Statistiche squadra</td></tr>
    <tr class="promotion">
      <td class="last_match">V</td>
      <td class="team_logo"><img src="/logo1.png"></td>
      <td class="team"><a class="team-name">Montagnano 1966</a></td>
      <td class="points">9</td>
      <td>3</td><td>3</td><td>0</td><td>0</td><td>7</td><td>0</td><td>7</td>
      <td class="details"></td>
    </tr>
    <tr class="playoff">
      <td class="last_match">V</td>
      <td class="team_logo"><img src="/logo2.png"></td>
      <td class="team"><a class="team-name">Acquaviva</a></td>
      <td class="points">6</td>
      <td>3</td><td>2</td><td>0</td><td>1</td><td>5</td><td>3</td><td>2</td>
      <td class="details"></td>
    </tr>
    <tr class="playout">
      <td class="last_match">P</td>
      <td class="team_logo"><img src="/logo3.png"></td>
      <td class="team"><a class="team-name">Resco Reggello</a></td>
      <td class="points">3</td>
      <td>3</td><td>1</td><td>0</td><td>2</td><td>2</td><td>4</td><td>-2</td>
      <td class="details"></td>
    </tr>
    <tr class="retrocession">
      <td class="last_match">-</td>
      <td class="team_logo"></td>
      <td class="team"><a class="team-name">Riposo FC</a></td>
      <td class="pt">-</td>
      <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
      <td class="details"></td>
    </tr>
  </tbody>
</table>
`;

// Giornata con: partita giocata (con marcatori), partita da giocare e partita rinviata.
const MATCHDAY_HTML = `
<div id="match_day"> 4° Giornata </div>
<div id="match_date"> 19|09|2026 - 20|09|2026 </div>
<table class="table-results">
  <tr class="date"><td>Sab. 19 settembre</td></tr>
  <tr class="match" data-link="https://www.tuttocampo.it/Toscana/Promozione/GironeC/Partita/1.4/acquaviva-resco-reggello">
    <td class="team home">
      <a class="team-name">Acquaviva</a>
      <span class="goal">2</span>
      <ul class="scorers">
        <li>M. Rossi (12' pt)</li>
        <li><a class="delete">Elimina</a></li>
      </ul>
    </td>
    <td class="match-time"><span class="hour">15:30</span></td>
    <td class="team away">
      <a class="team-name">Resco Reggello</a>
      <span class="goal">1</span>
      <ul class="scorers"><li>L. Bianchi (30' st)</li></ul>
    </td>
  </tr>
  <tr class="date"><td>Domenica 20 settembre</td></tr>
  <tr class="match">
    <td class="team home"><a class="team-name">Squadra B</a><span class="goal">-</span></td>
    <td class="match-time"><span class="hour">15:00</span></td>
    <td class="team away"><a class="team-name">Squadra C</a><span class="goal">-</span></td>
  </tr>
  <tr class="match">
    <td class="team home"><a class="team-name">Squadra D</a></td>
    <td class="match-time">Rinviata</td>
    <td class="team away"><a class="team-name">Squadra E</a></td>
  </tr>
</table>
`;

// Dati minimi di campionato usati dai test degli exporter.
function sampleLeagueData() {
  return {
    id: 'promozione-c',
    name: 'Promozione Toscana - Girone C',
    shortName: 'Promozione C',
    category: 'Promozione',
    girone: 'Girone C',
    region: 'Toscana',
    province: '',
    url: 'https://www.tuttocampo.it/Toscana/Promozione/GironeC/Risultati',
    roundID: 'TO.P.C',
    currentMatchDay: 2,
    totalMatchDays: 2,
    lastUpdated: '2026-09-28T10:00:00.000Z',
    standings: [
      { position: 1, team: 'Montagnano 1966', points: 6, played: 2, won: 2, drawn: 0, lost: 0, goalsFor: 5, goalsAgainst: 1, goalDiff: 4, zone: 'promotion' }
    ],
    matchDays: [
      {
        dayNumber: 1,
        dayTitle: '1° Giornata',
        dayDate: '13|09|2026',
        matches: [
          {
            homeTeam: 'Centro Storico Lebowski',
            awayTeam: 'Acquaviva',
            homeScore: 2,
            awayScore: 1,
            isPlayed: true,
            status: 'FINISHED',
            date: '2026-09-13',
            time: '15:30',
            dateTime: '2026-09-13T15:30:00',
            homeScorers: ["M. Rossi (12' pt)"],
            awayScorers: [],
            matchLink: 'https://www.tuttocampo.it/partita/1'
          }
        ]
      },
      {
        dayNumber: 2,
        dayTitle: '2° Giornata',
        dayDate: '20|09|2026',
        matches: [
          {
            homeTeam: 'Resco, Reggello',
            awayTeam: 'Squadra B',
            homeScore: null,
            awayScore: null,
            isPlayed: false,
            status: 'SCHEDULED',
            date: '2026-09-20',
            time: '15:00',
            dateTime: '2026-09-20T15:00:00',
            homeScorers: [],
            awayScorers: [],
            matchLink: ''
          }
        ]
      }
    ]
  };
}

module.exports = { STANDINGS_HTML, MATCHDAY_HTML, sampleLeagueData };
