#!/usr/bin/env node
/**
 * Utility per impostare il PIN di aggiornamento da browser.
 * Cifra il token GitHub con il PIN scelto dall'utente usando AES-256-GCM + PBKDF2
 * e salva il payload cifrato in public/auth.json (e nella root per GitHub Pages).
 *
 * Utilizzo:
 *   node bin/set-pin.js [PIN] [TOKEN_GITHUB]
 * oppure in modalità interattiva:
 *   node bin/set-pin.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { PUBLIC_DIR, ROOT_DIR } = require('../src/config');

function encryptToken(pin, token) {
  const cleanPin = String(pin).trim();
  const cleanToken = String(token).trim();

  if (!cleanPin) throw new Error('Il PIN non può essere vuoto.');
  if (!cleanToken) throw new Error('Il token GitHub non può essere vuoto.');

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(cleanPin, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(cleanToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: enc.toString('hex'),
    created_at: new Date().toISOString()
  };
}

function saveEncryptedAuth(payload) {
  const jsonStr = JSON.stringify(payload, null, 2) + '\n';
  const pubPath = path.join(PUBLIC_DIR, 'auth.json');
  const rootPath = path.join(ROOT_DIR, 'auth.json');

  fs.writeFileSync(pubPath, jsonStr, 'utf8');
  fs.writeFileSync(rootPath, jsonStr, 'utf8');

  console.log(`\n✔ Configurazione salvata con successo in:`);
  console.log(`   - ${pubPath}`);
  console.log(`   - ${rootPath}`);
  console.log(`\nOra sul sito web basterà inserire il tuo PIN per avviare l'aggiornamento sul Raspberry Pi!`);
}

async function promptInteractive() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise(resolve => rl.question(query, resolve));

  try {
    console.log('=== Configurazione PIN Aggiornamento Calcio Toscana ===\n');
    const pin = await question('1. Inserisci il PIN facile da ricordare (es. 1234 o una parola): ');
    const token = await question('2. Incolla il tuo Token GitHub (github_pat_...): ');

    if (!pin.trim() || !token.trim()) {
      console.error('❌ Errore: PIN e Token sono entrambi obbligatori.');
      process.exit(1);
    }

    const payload = encryptToken(pin, token);
    saveEncryptedAuth(payload);
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length >= 2) {
    const [pin, token] = args;
    const payload = encryptToken(pin, token);
    saveEncryptedAuth(payload);
    return;
  }
  await promptInteractive();
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Errore:', err.message);
    process.exit(1);
  });
}

module.exports = { encryptToken, saveEncryptedAuth };
