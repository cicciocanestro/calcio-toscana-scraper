#!/usr/bin/env node
/**
 * Verifica se i dati *sportivi* (classifiche e partite) sono cambiati rispetto
 * all'ultimo commit.
 *
 * Serve a evitare un commit inutile ogni settimana quando gli unici campi
 * diversi sono quelli volatili (`lastUpdated` nella cache/export JSON e i
 * `DTSTAMP` negli ICS, che cambiano ad ogni generazione).
 *
 *   node bin/data-changed.js
 *
 * Exit code: 0 i dati sportivi sono cambiati (serve il commit), 1 invariati.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { LEAGUES, ROOT_DIR } = require('../src/config');

// Campi che cambiano ad ogni generazione senza che sia cambiato nulla di reale
const VOLATILE_KEYS = new Set(['lastUpdated', 'isStale', 'DTSTAMP']);

/**
 * Serializzazione stabile: chiavi ordinate, campi volatili esclusi.
 * Due dataset con gli stessi dati sportivi producono la stessa stringa.
 */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => !VOLATILE_KEYS.has(k)).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sportsFingerprint(leagueData) {
  if (!leagueData || typeof leagueData !== 'object') return '';
  return stableStringify({
    id: leagueData.id,
    standings: leagueData.standings || [],
    matchDays: leagueData.matchDays || []
  });
}

/**
 * Confronta i dati correnti con quelli precedenti.
 * @param {object} current - mappa id -> dati correnti
 * @param {function} readPrevious - (id) => dati precedenti oppure null
 * @returns {{changed:string[], unchanged:string[], isChanged:boolean}}
 */
function diffAgainstPrevious(current, readPrevious) {
  const changed = [];
  const unchanged = [];

  for (const id of Object.keys(current)) {
    const now = current[id];
    const before = readPrevious(id);

    if (!now || !before) {
      changed.push(id);
      continue;
    }

    if (sportsFingerprint(now) === sportsFingerprint(before)) unchanged.push(id);
    else changed.push(id);
  }

  return { changed, unchanged, isChanged: changed.length > 0 };
}

function readFromHead(relativePath) {
  try {
    const raw = execFileSync('git', ['show', `HEAD:${relativePath}`], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return JSON.parse(raw);
  } catch (err) {
    // File non presente nell'ultimo commit (o repo senza HEAD): consideralo cambiato
    return null;
  }
}

function main() {
  const current = {};

  for (const id of Object.keys(LEAGUES)) {
    const file = path.join(ROOT_DIR, 'data', 'cache', `${id}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      current[id] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      current[id] = null;
    }
  }

  const result = diffAgainstPrevious(current, (id) => readFromHead(`data/cache/${id}.json`));

  for (const id of result.unchanged) console.log(`= ${id}: dati sportivi invariati`);
  for (const id of result.changed) console.log(`* ${id}: dati sportivi CAMBIATI`);

  if (result.isChanged) {
    console.log('\n✔ Ci sono novità da committare.');
    process.exitCode = 0;
  } else {
    console.log('\n= Nessuna novità sportiva: il commit viene saltato.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { sportsFingerprint, diffAgainstPrevious, stableStringify, VOLATILE_KEYS };
