const { exportSlug } = require('./exporters');

/**
 * Parsing di una stringa marcatore (es. "E. Focardi (27' pt)", "A. Rachidi (Rig.) (29' st)", "AUTOGOL (6' st)").
 */
function parseScorer(rawScorer) {
  if (!rawScorer || typeof rawScorer !== 'string') return null;
  const raw = rawScorer.trim();
  const isPenalty = /\(rig\.?\)/i.test(raw);
  const isOwnGoal = /\bautogol\b/i.test(raw);

  // Estrai minutaggio e tempo (es. "27' pt" o "30' st")
  let minute = null;
  let half = null;
  const timeMatch = raw.match(/\((\d+)'?\s*(pt|st)?\)/i);
  if (timeMatch) {
    minute = timeMatch[1];
    half = timeMatch[2] ? timeMatch[2].toLowerCase() : null;
  }

  // Nome pulito rimuovendo parentesi
  let cleanName = raw.replace(/\(.*?\)/g, '').trim();
  if (!cleanName && isOwnGoal) {
    cleanName = 'AUTOGOL';
  }

  return {
    raw,
    name: cleanName,
    minute,
    half,
    isPenalty: isPenalty ? 1 : 0,
    isOwnGoal: isOwnGoal ? 1 : 0
  };
}

/**
 * Importa o aggiorna una squadra nel database.
 */
function upsertTeam(db, teamName, logoUrl = null) {
  const slug = exportSlug(teamName);

  const selectStmt = db.prepare('SELECT id, logo_url FROM teams WHERE name = ?');
  const existing = selectStmt.get(teamName);

  if (existing) {
    if (logoUrl && !existing.logo_url) {
      db.prepare('UPDATE teams SET logo_url = ? WHERE id = ?').run(logoUrl, existing.id);
    }
    return existing.id;
  }

  const insertStmt = db.prepare('INSERT INTO teams (name, slug, logo_url) VALUES (?, ?, ?)');
  const res = insertStmt.run(teamName, slug, logoUrl);
  return Number(res.lastInsertRowid);
}

/**
 * Inserisce o aggiorna un intero documento JSON di un campionato nel database relazionale.
 */
function importLeagueDocument(db, leagueData, options = {}) {
  const seasonLabel = options.seasonLabel || '2026/27';

  db.exec('BEGIN TRANSACTION;');
  try {
    // 1. Inserisci o aggiorna campionato
    db.prepare(`
      INSERT INTO leagues (
        id, name, short_name, category, girone, region, province,
        url, round_id, current_match_day, total_match_days, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        short_name = excluded.short_name,
        category = excluded.category,
        girone = excluded.girone,
        region = excluded.region,
        province = excluded.province,
        url = excluded.url,
        round_id = excluded.round_id,
        current_match_day = excluded.current_match_day,
        total_match_days = excluded.total_match_days,
        last_updated = excluded.last_updated
    `).run(
      leagueData.id,
      leagueData.name,
      leagueData.shortName,
      leagueData.category,
      leagueData.girone,
      leagueData.region,
      leagueData.province || '',
      leagueData.url,
      leagueData.roundID,
      leagueData.currentMatchDay || 1,
      leagueData.totalMatchDays || 30,
      leagueData.lastUpdated || new Date().toISOString()
    );

    // 2. Stagione
    db.prepare(`
      INSERT INTO seasons (league_id, label, is_current)
      VALUES (?, ?, 1)
      ON CONFLICT(league_id, label) DO UPDATE SET is_current = 1
    `).run(leagueData.id, seasonLabel);

    const seasonRow = db.prepare('SELECT id FROM seasons WHERE league_id = ? AND label = ?').get(leagueData.id, seasonLabel);
    const seasonId = seasonRow.id;

    // 3. Squadre e classifica
    const teamMap = new Map(); // name -> team_id

    // Raccoglie i loghi dalle partite se presenti
    const logosMap = new Map();
    for (const md of leagueData.matchDays || []) {
      for (const m of md.matches || []) {
        if (m.homeTeam && m.homeLogo && !logosMap.has(m.homeTeam)) logosMap.set(m.homeTeam, m.homeLogo);
        if (m.awayTeam && m.awayLogo && !logosMap.has(m.awayTeam)) logosMap.set(m.awayTeam, m.awayLogo);
      }
    }

    for (const row of leagueData.standings || []) {
      const teamId = upsertTeam(db, row.team, logosMap.get(row.team));
      teamMap.set(row.team, teamId);

      // Snapshot classifica per la giornata attuale
      const dayNum = leagueData.currentMatchDay || 1;
      db.prepare(`
        INSERT INTO standings_snapshots (
          season_id, matchday_number, team_id, position, points,
          played, won, drawn, lost, goals_for, goals_against, goal_diff, zone, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id, matchday_number, team_id) DO UPDATE SET
          position = excluded.position,
          points = excluded.points,
          played = excluded.played,
          won = excluded.won,
          drawn = excluded.drawn,
          lost = excluded.lost,
          goals_for = excluded.goals_for,
          goals_against = excluded.goals_against,
          goal_diff = excluded.goal_diff,
          zone = excluded.zone,
          captured_at = excluded.captured_at
      `).run(
        seasonId,
        dayNum,
        teamId,
        row.position,
        row.points,
        row.played,
        row.won,
        row.drawn,
        row.lost,
        row.goalsFor,
        row.goalsAgainst,
        row.goalDiff,
        row.zone || '',
        leagueData.lastUpdated || new Date().toISOString()
      );
    }

    // 4. Giornate e partite
    const insertMatchdayStmt = db.prepare(`
      INSERT INTO matchdays (season_id, day_number, day_title, day_date)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(season_id, day_number) DO UPDATE SET
        day_title = excluded.day_title,
        day_date = excluded.day_date
    `);

    const insertMatchStmt = db.prepare(`
      INSERT INTO matches (
        season_id, matchday_number, home_team_id, away_team_id,
        home_score, away_score, is_played, status,
        date, time, date_time, match_link, source_key, score_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        home_score = CASE
          -- Regola anti-regressione: se già giocata e conclusa con punteggio, non sovrascrivere con null/vuoto
          WHEN matches.is_played = 1 AND matches.status = 'FINISHED' AND excluded.is_played = 0 THEN matches.home_score
          ELSE excluded.home_score
        END,
        away_score = CASE
          WHEN matches.is_played = 1 AND matches.status = 'FINISHED' AND excluded.is_played = 0 THEN matches.away_score
          ELSE excluded.away_score
        END,
        is_played = CASE
          WHEN matches.is_played = 1 AND matches.status = 'FINISHED' AND excluded.is_played = 0 THEN matches.is_played
          ELSE excluded.is_played
        END,
        status = CASE
          WHEN matches.is_played = 1 AND matches.status = 'FINISHED' AND excluded.is_played = 0 THEN matches.status
          ELSE excluded.status
        END,
        date = COALESCE(excluded.date, matches.date),
        time = COALESCE(excluded.time, matches.time),
        date_time = COALESCE(excluded.date_time, matches.date_time),
        match_link = excluded.match_link,
        score_updated_at = CASE
          WHEN excluded.is_played = 1 THEN COALESCE(excluded.score_updated_at, matches.score_updated_at)
          ELSE matches.score_updated_at
        END
    `);

    const selectMatchStmt = db.prepare('SELECT id FROM matches WHERE source_key = ?');
    const deleteGoalsStmt = db.prepare('DELETE FROM goals WHERE match_id = ?');
    const insertGoalStmt = db.prepare(`
      INSERT INTO goals (
        match_id, team_id, player_raw, player_name,
        minute, half, is_penalty, is_own_goal, ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const md of leagueData.matchDays || []) {
      insertMatchdayStmt.run(seasonId, md.dayNumber, md.dayTitle, md.dayDate);

      for (const m of md.matches || []) {
        const homeTeamId = teamMap.get(m.homeTeam) || upsertTeam(db, m.homeTeam, m.homeLogo);
        const awayTeamId = teamMap.get(m.awayTeam) || upsertTeam(db, m.awayTeam, m.awayLogo);
        teamMap.set(m.homeTeam, homeTeamId);
        teamMap.set(m.awayTeam, awayTeamId);

        // Se matchLink è presente, genera la source_key (es. "TO.P.C:1.1:acquaviva-resco-reggello")
        const sourceKey = m.matchLink || `${leagueData.id}:${md.dayNumber}:${exportSlug(m.homeTeam)}-${exportSlug(m.awayTeam)}`;

        insertMatchStmt.run(
          seasonId,
          md.dayNumber,
          homeTeamId,
          awayTeamId,
          m.homeScore !== undefined && m.homeScore !== null ? m.homeScore : null,
          m.awayScore !== undefined && m.awayScore !== null ? m.awayScore : null,
          m.isPlayed ? 1 : 0,
          m.status || 'SCHEDULED',
          m.date || null,
          m.time || null,
          m.dateTime || null,
          m.matchLink || '',
          sourceKey,
          m.isPlayed ? (leagueData.lastUpdated || new Date().toISOString()) : null
        );

        const matchRow = selectMatchStmt.get(sourceKey);
        if (matchRow) {
          const matchId = matchRow.id;
          deleteGoalsStmt.run(matchId);

          let ordinal = 1;
          for (const raw of m.homeScorers || []) {
            const parsed = parseScorer(raw);
            if (parsed) {
              insertGoalStmt.run(
                matchId, homeTeamId, parsed.raw, parsed.name,
                parsed.minute, parsed.half, parsed.isPenalty, parsed.isOwnGoal, ordinal++
              );
            }
          }

          for (const raw of m.awayScorers || []) {
            const parsed = parseScorer(raw);
            if (parsed) {
              insertGoalStmt.run(
                matchId, awayTeamId, parsed.raw, parsed.name,
                parsed.minute, parsed.half, parsed.isPenalty, parsed.isOwnGoal, ordinal++
              );
            }
          }
        }
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Ricostruisce l'esatto documento JSON del campionato a partire dal database relazionale.
 */
function reconstructLeagueDocument(db, leagueId, seasonLabel = '2026/27') {
  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);
  if (!league) return null;

  const season = db.prepare('SELECT id FROM seasons WHERE league_id = ? AND label = ?').get(leagueId, seasonLabel);
  if (!season) return null;
  const seasonId = season.id;

  // 1. Classifica più recente
  const currentDay = league.current_match_day || 1;
  const standingsRows = db.prepare(`
    SELECT
      s.position,
      t.name AS team,
      s.points,
      s.played,
      s.won,
      s.drawn,
      s.lost,
      s.goals_for AS goalsFor,
      s.goals_against AS goalsAgainst,
      s.goal_diff AS goalDiff,
      s.zone
    FROM standings_snapshots s
    JOIN teams t ON s.team_id = t.id
    WHERE s.season_id = ? AND s.matchday_number = ?
    ORDER BY s.position ASC
  `).all(seasonId, currentDay);

  const standings = standingsRows.map(r => ({
    position: r.position,
    team: r.team,
    points: r.points,
    played: r.played,
    won: r.won,
    drawn: r.drawn,
    lost: r.lost,
    goalsFor: r.goalsFor,
    goalsAgainst: r.goalsAgainst,
    goalDiff: r.goalDiff,
    zone: r.zone || undefined
  }));

  // 2. Giornate
  const matchdays = db.prepare(`
    SELECT day_number, day_title, day_date
    FROM matchdays
    WHERE season_id = ?
    ORDER BY day_number ASC
  `).all(seasonId);

  // Mappa di tutti i gol per match_id
  const goalsRows = db.prepare(`
    SELECT g.match_id, g.team_id, g.player_raw
    FROM goals g
    JOIN matches m ON g.match_id = m.id
    WHERE m.season_id = ?
    ORDER BY g.ordinal ASC
  `).all(seasonId);

  const goalsByMatch = new Map();
  for (const g of goalsRows) {
    if (!goalsByMatch.has(g.match_id)) goalsByMatch.set(g.match_id, []);
    goalsByMatch.get(g.match_id).push(g);
  }

  // Partite
  const matchesRows = db.prepare(`
    SELECT
      m.id,
      m.matchday_number,
      ht.name AS homeTeam,
      at.name AS awayTeam,
      ht.logo_url AS homeLogo,
      at.logo_url AS awayLogo,
      m.home_team_id,
      m.away_team_id,
      m.home_score,
      m.away_score,
      m.is_played,
      m.status,
      m.date,
      m.time,
      m.date_time,
      m.match_link
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at ON m.away_team_id = at.id
    WHERE m.season_id = ?
    ORDER BY m.matchday_number ASC, m.id ASC
  `).all(seasonId);

  const matchesByDay = new Map();
  for (const m of matchesRows) {
    if (!matchesByDay.has(m.matchday_number)) matchesByDay.set(m.matchday_number, []);

    const matchGoals = goalsByMatch.get(m.id) || [];
    const homeScorers = matchGoals.filter(g => g.team_id === m.home_team_id).map(g => g.player_raw);
    const awayScorers = matchGoals.filter(g => g.team_id === m.away_team_id).map(g => g.player_raw);

    matchesByDay.get(m.matchday_number).push({
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      homeScore: m.home_score,
      awayScore: m.away_score,
      isPlayed: Boolean(m.is_played),
      status: m.status,
      date: m.date || undefined,
      time: m.time || undefined,
      dateTime: m.date_time || undefined,
      homeScorers,
      awayScorers,
      homeLogo: m.homeLogo || '',
      awayLogo: m.awayLogo || '',
      matchLink: m.match_link
    });
  }

  const matchDays = matchdays.map(md => ({
    dayNumber: md.day_number,
    dayTitle: md.day_title,
    dayDate: md.day_date || '',
    matches: matchesByDay.get(md.day_number) || []
  }));

  return {
    id: league.id,
    name: league.name,
    shortName: league.short_name,
    category: league.category,
    girone: league.girone,
    region: league.region,
    province: league.province || '',
    url: league.url,
    roundID: league.round_id,
    currentMatchDay: league.current_match_day,
    totalMatchDays: league.total_match_days,
    lastUpdated: league.last_updated,
    standings,
    matchDays
  };
}

/**
 * Restituisce la classifica marcatori di uno specifico campionato.
 */
function getTopScorers(db, leagueId, limit = 20) {
  const rows = db.prepare(`
    SELECT
      player_name,
      team_name,
      total_goals,
      penalties
    FROM v_top_scorers
    WHERE league_id = ?
    ORDER BY total_goals DESC, player_name ASC
    LIMIT ?
  `).all(leagueId, limit);

  return rows.map((r, i) => ({
    position: i + 1,
    player: r.player_name,
    team: r.team_name,
    goals: r.total_goals,
    penalties: r.penalties
  }));
}

/**
 * Restituisce lo stato di forma recente (ultime N partite disputate) per ogni squadra del campionato.
 */
function getTeamsForm(db, leagueId, lastMatchesCount = 5) {
  const league = db.prepare('SELECT id FROM leagues WHERE id = ?').get(leagueId);
  if (!league) return [];

  // Tutte le partite concluse del campionato ordinate cronologicamente
  const matches = db.prepare(`
    SELECT
      m.id,
      m.matchday_number,
      ht.name AS home_team,
      at.name AS away_team,
      m.home_score,
      m.away_score
    FROM matches m
    JOIN seasons s ON m.season_id = s.id
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at ON m.away_team_id = at.id
    WHERE s.league_id = ? AND m.is_played = 1 AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
    ORDER BY m.matchday_number ASC, m.id ASC
  `).all(leagueId);

  // Mappa squadra -> array risultati ('V', 'N', 'P')
  const teamHistory = new Map();
  for (const m of matches) {
    if (!teamHistory.has(m.home_team)) teamHistory.set(m.home_team, []);
    if (!teamHistory.has(m.away_team)) teamHistory.set(m.away_team, []);

    let homeRes, awayRes;
    if (m.home_score > m.away_score) {
      homeRes = 'V';
      awayRes = 'P';
    } else if (m.home_score < m.away_score) {
      homeRes = 'P';
      awayRes = 'V';
    } else {
      homeRes = 'N';
      awayRes = 'N';
    }

    teamHistory.get(m.home_team).push({ res: homeRes, opponent: m.away_team, day: m.matchday_number, isHome: true, score: `${m.home_score}-${m.away_score}` });
    teamHistory.get(m.away_team).push({ res: awayRes, opponent: m.home_team, day: m.matchday_number, isHome: false, score: `${m.away_score}-${m.home_score}` });
  }

  const result = [];
  for (const [team, history] of teamHistory.entries()) {
    const recent = history.slice(-lastMatchesCount);
    const formString = recent.map(h => h.res).join('');
    const pointsInRecent = recent.reduce((sum, h) => sum + (h.res === 'V' ? 3 : h.res === 'N' ? 1 : 0), 0);

    result.push({
      team,
      playedTotal: history.length,
      recentCount: recent.length,
      form: formString,
      pointsRecent: pointsInRecent,
      history: recent
    });
  }

  // Ordina per punti nelle partite recenti
  return result.sort((a, b) => b.pointsRecent - a.pointsRecent || b.playedTotal - a.playedTotal);
}

module.exports = {
  parseScorer,
  upsertTeam,
  importLeagueDocument,
  reconstructLeagueDocument,
  getTopScorers,
  getTeamsForm
};
