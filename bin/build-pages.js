#!/usr/bin/env node
/**
 * Sincronizza gli asset della dashboard nella root del repository.
 *
 * GitHub Pages pubblica la root del branch, mentre il server Node serve
 * `public/`. Per evitare due copie mantenute a mano, `public/` è l'unica
 * fonte di verità e questo script rigenera le copie di root.
 *
 *   node bin/build-pages.js          # scrive/aggiorna gli asset di root
 *   node bin/build-pages.js --check  # verifica soltanto (exit 1 se divergono)
 */
const fs = require('fs');
const path = require('path');
const { ROOT_DIR, PUBLIC_DIR } = require('../src/config');

const checkOnly = process.argv.includes('--check');

function listFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, full));
    }
  }
  return files.sort();
}

function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error(`✖ Cartella public/ non trovata: ${PUBLIC_DIR}`);
    process.exit(1);
  }

  const files = listFiles(PUBLIC_DIR);
  if (files.length === 0) {
    console.error('✖ Nessun asset trovato in public/.');
    process.exit(1);
  }

  const outdated = [];
  const updated = [];

  for (const rel of files) {
    const src = path.join(PUBLIC_DIR, rel);
    const dest = path.join(ROOT_DIR, rel);
    const content = fs.readFileSync(src);
    const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;

    if (current && current.equals(content)) continue;

    if (checkOnly) {
      outdated.push(rel);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      updated.push(rel);
    }
  }

  if (checkOnly) {
    if (outdated.length > 0) {
      console.error('✖ Asset di root non allineati a public/: ' + outdated.join(', '));
      console.error('  Esegui `npm run build:pages` e committa il risultato.');
      process.exit(1);
    }
    console.log(`✔ Asset di root allineati a public/ (${files.length} file verificati).`);
    return;
  }

  if (updated.length === 0) {
    console.log(`✔ Asset di root già allineati a public/ (${files.length} file).`);
  } else {
    console.log(`✔ Asset di root aggiornati da public/: ${updated.join(', ')}`);
  }
}

main();
