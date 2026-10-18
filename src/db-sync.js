const { exportSlug } = require('./exporters');
const { getCurrentSeasonLabel, getSeasonFromLeagueData } = require('./config');

/**
 * Parsing di una stringa marcatore (es. "E. Focardi (27' pt)", "A. Rachidi (Rig.) (29' st)", "AUTOGOL (6' st)").
 */
function parseScorer(rawScorer) {
  if (!rawScorer || typeof rawScorer !== 'string') return null;
  const raw = rawScorer.trim();
  const isPenalty = /\(rig\.?\)/i.test(raw);
  const isOwnGoal = /(\bautogol\b|\(aut\.?\))/i.test(raw);

  // Estrai minutaggio e tempo (es. "27' pt", "30' st" o recupero "45'+2 pt")
  let minute = null;
  let half = null;
  const timeMatch = raw.match(/\((\d+(?:\+\d+)?)'?\s*(pt|st|dts|pts)?\)/i);
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

  const selectStmt = db.prepare('SELECT id, name, logo_url FROM teams WHERE name = ? OR slug = ?');
  const existing = selectStmt.get(teamName, slug);

  if (existing) {
    if (existing.name !== teamName) {
      db.prepare('INSERT OR IGNORE INTO team_aliases (team_id, alias) VALUES (?, ?)').run(existing.id, teamName);
    }
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
  const seasonLabel = options.seasonLabel || getSeasonFromLeagueData(leagueData);

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
        last_updated = CASE
          WHEN leagues.current_match_day IS NOT excluded.current_match_day
            OR leagues.name IS NOT excluded.name
            THEN excluded.last_updated
          ELSE leagues.last_updated
        END
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
    db.prepare('UPDATE seasons SET is_current = 0 WHERE league_id = ? AND label != ?').run(leagueData.id, seasonLabel);
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
          captured_at = CASE
            WHEN standings_snapshots.points IS NOT excluded.points
              OR standings_snapshots.played IS NOT excluded.played
              OR standings_snapshots.position IS NOT excluded.position
              OR standings_snapshots.goals_for IS NOT excluded.goals_for
              OR standings_snapshots.goals_against IS NOT excluded.goals_against
              THEN excluded.captured_at
            ELSE standings_snapshots.captured_at
          END
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
          -- Aggiorna score_updated_at solo se il punteggio è effettivamente cambiato rispetto a prima
          WHEN excluded.is_played = 1 AND (matches.home_score IS NOT excluded.home_score OR matches.away_score IS NOT excluded.away_score OR matches.score_updated_at IS NULL)
            THEN COALESCE(excluded.score_updated_at, matches.score_updated_at)
          ELSE matches.score_updated_at
        END
    `);

    const selectExistingMatchByTeamsStmt = db.prepare(`
      SELECT id, source_key, is_played, status
      FROM matches
      WHERE season_id = ? AND matchday_number = ? AND home_team_id = ? AND away_team_id = ?
    `);
    const updateMatchSourceKeyStmt = db.prepare('UPDATE matches SET source_key = ? WHERE id = ?');
    const selectMatchStmt = db.prepare('SELECT id, is_played, status FROM matches WHERE source_key = ?');
    const selectGoalsStmt = db.prepare('SELECT team_id, player_raw, ordinal FROM goals WHERE match_id = ? ORDER BY ordinal ASC');
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

        // Evita duplicati se una partita già registrata senza matchLink ne riceve uno in seguito
        const existingByTeams = selectExistingMatchByTeamsStmt.get(seasonId, md.dayNumber, homeTeamId, awayTeamId);
        const wasPlayedFinished = Boolean(
          existingByTeams && existingByTeams.is_played === 1 && existingByTeams.status === 'FINISHED'
        );
        if (existingByTeams && existingByTeams.source_key !== sourceKey) {
          updateMatchSourceKeyStmt.run(sourceKey, existingByTeams.id);
        }

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
          // Anti-regressione sui marcatori: se la partita era già conclusa e il nuovo dato
          // non risulta giocato, preserviamo anche i gol già registrati.
          if (wasPlayedFinished && !m.isPlayed) {
            continue;
          }

          const incomingGoals = [];
          let ordinal = 1;
          for (const raw of m.homeScorers || []) {
            const parsed = parseScorer(raw);
            if (parsed) {
              incomingGoals.push({ teamId: homeTeamId, parsed, ordinal: ordinal++ });
            }
          }
          for (const raw of m.awayScorers || []) {
            const parsed = parseScorer(raw);
            if (parsed) {
              incomingGoals.push({ teamId: awayTeamId, parsed, ordinal: ordinal++ });
            }
          }

          // Riscrive i gol solo se sono effettivamente cambiati, evitando di far crescere
          // inutilmente gli ID AUTOINCREMENT ad ogni importazione.
          const currentGoals = selectGoalsStmt.all(matchId);
          const sameGoals = currentGoals.length === incomingGoals.length && currentGoals.every(
            (g, i) => g.team_id === incomingGoals[i].teamId
              && g.player_raw === incomingGoals[i].parsed.raw
              && g.ordinal === incomingGoals[i].ordinal
          );

          if (!sameGoals) {
            deleteGoalsStmt.run(matchId);
            for (const g of incomingGoals) {
              insertGoalStmt.run(
                matchId, g.teamId, g.parsed.raw, g.parsed.name,
                g.parsed.minute, g.parsed.half, g.parsed.isPenalty, g.parsed.isOwnGoal, g.ordinal
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
function reconstructLeagueDocument(db, leagueId, seasonLabel = null) {
  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);
  if (!league) return null;

  let season = null;
  if (seasonLabel) {
    season = db.prepare('SELECT id FROM seasons WHERE league_id = ? AND label = ?').get(leagueId, seasonLabel);
  }
  if (!season) {
    // Scegli la stagione con partite associate o la più recente
    season = db.prepare(`
      SELECT s.id
      FROM seasons s
      LEFT JOIN matches m ON m.season_id = s.id
      WHERE s.league_id = ?
      GROUP BY s.id
      ORDER BY COUNT(m.id) DESC, s.id DESC
      LIMIT 1
    `).get(leagueId);
    if (!season) return null;
  }
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
    ORDER BY m.matchday_number ASC, m.date ASC, m.id ASC
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
    ORDER BY total_goals DESC, penalties ASC, player_name ASC
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

module.exports = {
  parseScorer,
  upsertTeam,
  importLeagueDocument,
  reconstructLeagueDocument,
  getTopScorers
};
