# 📋 Handover Progetto: `calcio-toscana-scraper`

Questo documento fornisce il contesto tecnico completo dell'architettura, delle decisioni progettuali, dei bug risolti e dello stato corrente per il passaggio di consegne ad altri agenti AI o sviluppatori.

---

## 1. Panoramica del Progetto
Tool full-stack in Node.js (CommonJS, Node >=20, testato su Node 22/24) per web scraping, gestione database relazionale, esportazione calendari multi-formato e consultazione web responsive per campionati dilettantistici toscani:
1. **Promozione Toscana - Girone C** (`promozione-c`)
2. **Seconda Categoria Toscana - Girone I** (`seconda-i`)
3. **Terza Categoria Arezzo - Girone Unico** (`terza-arezzo`)
4. Scheda speciale territoriale **CC Camucia** (Cortona Camucia, Fratta, Fratticciola, Montecchio, Monsigliolo) raggruppata per weekend.

---

## 2. Punti di Accesso e URL Attivi
- **Sito Web Pubblico (GitHub Pages):**  
  👉 **`https://cicciocanestro.github.io/calcio-toscana-scraper/`**  
  *(Statico, CDN globale sempre attiva, 100% gratuito, zero sleep).*
- **Server Web Locale (Raspberry Pi 3):**  
  👉 **`http://calcio-pi:3000`** oppure **`http://192.168.1.151:3000`** *(dominio modem `.home`)*.  
  *(Gestito in background con PM2, nome processo `calcio-scraper`).*
- **Istanza Cloud di Riserva (Render):**  
  `https://calcio-toscana-scraper.onrender.com` *(mantenuta come fallback nel workflow)*.

---

## 3. Architettura Operativa Attuale
```
[Visitatore / Smartphone] ───> GitHub Pages (CDN globale gratuita)
                                     ▲
                                     │ push automatico di data/, export e asset
                                     │
                             GitHub Actions (Workflow update.yml)
                             [runs-on: [self-hosted, linux]]
                                     ▲
                                     │ delega l'esecuzione
                                     │
                             Raspberry Pi 3 (A casa su Wi-Fi)
                             - IP residenziale (zero blocchi AWS WAF)
                             - Scraping HTTP puro (~2s a campionato)
                             - Database SQLite + Dump snapshot.jsonl
                             - Servizio actions-runner (systemd)
                                     ▲
                                     │ richieste HTTP interne
                                     │
                               Tuttocampo.it (Sito ufficiale)
```

1. **Scraping dall'IP di casa:**  
   Tuttocampo è protetto da AWS WAF, che blocca con `403` gli IP dei data center cloud (GitHub, Oracle, Google Cloud). L'IP residenziale domestico del Raspberry Pi non riceve blocchi WAF ed esegue lo scraping in modalità HTTP pura in pochissimi secondi senza browser.
2. **Trigger automatico:** Cron schedulato la domenica alle 21:00 UTC e il lunedì alle 08:00 UTC.
3. **Trigger manuale con PIN dal sito web:**  
   Dalla dashboard su GitHub Pages, cliccando *"🔄 Aggiorna dal Web"* viene richiesto un **PIN a 4 cifre (`6619`)**. Il browser usa la **Web Crypto API (AES-256-GCM + PBKDF2)** per decifrare in memoria locale il token GitHub memorizzato in forma cifrata in `auth.json`, e lancia la chiamata `POST /actions/workflows/update.yml/dispatches` che attiva il Raspberry Pi.

---

## 4. Bug Risolti nelle Ultime Sessioni

1. **Orari `.ics` anticipati/posticipati per le partite alle `:00` (`src/exporters.js`, `public/app.js`):**  
   Risolto il bug `hh || 15, mm || 30`: quando i minuti erano `00`, in JS `0` era falsy e diventava `30` (es. `15:00` esportato come `15:30` su 340 partite). Ora gestito con `Number.isFinite(mm) ? mm : 30` in UTC.
2. **Conformità RFC 5545 per eventi giornalieri (`VALUE=DATE`):**  
   Corretto `DTEND` che ora punta al giorno successivo (in RFC 5545 è esclusivo).
3. **Troncamento accenti in `exportSlug`:**  
   Aggiunta normalizzazione Unicode `normalize('NFD').replace(/[\u0300-\u036f]/g, '')` (es. *"Pian Di Scò"* → `pian_di_sco` invece di `pian_di_sc`).
4. **Anticipi al sabato nel parser HTML (`src/parser.js`):**  
   Il passaggio d'anno a Capodanno ora confronta i mesi di riferimento e non una condizione `parsed < currentDate` generica, evitando che un anticipo di sabato su giornata singola spostasse la data di +1 anno.
5. **Scraping incrementale ignorato (`src/scraper.js`, `src/http-scraper.js`):**  
   Inoltrate le opzioni `incremental` e `matchDays` attraverso la catena dello scraper ed eliminato il doppio log contraddittorio.
6. **Stabilità SQLite e rigenerazione ID gol (`src/db-sync.js`, `src/db-snapshot.js`):**  
   - Evitata la cancellazione e reinserimento cieco dei gol invariati (gli ID in `data/db/snapshot.jsonl` non crescono più ad ogni import).
   - Preservati i marcatori anche in caso di regressione dati su partite già concluse.
   - Aggiunto reset di `sqlite_sequence` durante il restore.
7. **Rate Limiting e Trust Proxy (`src/server.js`):**  
   Aggiunto `app.set('trust proxy', 1)` per isolare correttamente gli IP dietro reverse proxy ed eliminato il leak di connessioni SQLite su `/api/leagues/:id/scorers`.
8. **Eliminati 404 in console su GitHub Pages (`public/app.js`):**  
   In ambiente statico, `fetchLeagueData` salta direttamente la chiamata a `/api/leagues/...` e legge subito i JSON in `data/cache/`.
9. **Timestamp non aggiornato su refresh manuale (`.github/workflows/update.yml`):**  
   `data-changed.js` saltava il commit se i risultati sportivi non cambiavano. Ora, se il workflow è avviato manualmente via `workflow_dispatch`, il commit con il timestamp aggiornato viene forzato e pubblicato sempre.

---

## 5. Nuove Funzionalità Aggiunte
- **Scheda ⚽ Marcatori nella Dashboard:** Vista dedicata (`#view-scorers`) con classifica marcatori, gol totali, rigori e filtro squadra, funzionante sia su GitHub Pages (calcolata dai dati JSON escludendo gli autogol) sia via endpoint API SQLite `/api/leagues/:id/scorers`. Rimossa la funzionalità "Forma" come richiesto.
- **Favicon Ufficiale:** Icona vettoriale `public/favicon.svg` (e `favicon.svg` in root) integrata nell'HTML.
- **Modale Conferma Aggiornamento con PIN:**  
  - Script CLI di configurazione: `node bin/set-pin.js [PIN] [TOKEN]`
  - Cifratura simmetrica AES-256-GCM + PBKDF2 (100.000 iterazioni SHA-256).
  - File di configurazione cifrato pubblico: `auth.json` / `public/auth.json`.
  - PIN attivo: **`6619`**.
- **Runner GitHub Actions Self-Hosted su Raspberry Pi 3:**  
  - Configurato con `actions-runner` linux-arm64 come servizio di avvio `actions.runner.*.service`.
  - Rimosso `actions/setup-node` ridondante dal runner self-hosted: l'esecuzione della CI sul Pi è scesa da ~6 minuti a **meno di 2 minuti totali**.
- **Guida Operativa:** Creato **`RASPBERRY.md`** per tutte le operazioni da terminale e gestione PM2/Runner.

---

## 6. Mappa dei File Chiave del Repository
```
.
├── .github/workflows/update.yml  # Workflow CI/CD: esegue su [self-hosted, linux]
├── bin/
│   ├── cli.js                   # CLI principale (scrape, standings, scorers, results, next, export)
│   ├── set-pin.js               # Utility per generare/aggiornare auth.json cifrato con PIN
│   ├── db-import.js             # Importa i file data/cache/*.json nel DB SQLite
│   ├── db-snapshot.js           # Dump (dump) e restore (restore) di data/db/snapshot.jsonl
│   └── build-pages.js           # Sincronizza gli asset da public/ alla root del repo per Pages
├── src/
│   ├── config.js                # Definizione dei campionati (LEAGUES) e percorsi
│   ├── db.js                    # Inizializzazione SQLite (node:sqlite DatabaseSync) e DDL
│   ├── db-sync.js               # Logica relazionale: importLeagueDocument, reconstructLeagueDocument, getTopScorers
│   ├── db-snapshot.js           # Dump/Restore atomico in JSON Lines per Git diff stabili
│   ├── store.js                 # Layer di memorizzazione (JsonStore con sync su SQLite)
│   ├── http-scraper.js          # Scraper HTTP puro ultra-veloce (undici/fetch)
│   ├── scraper.js               # Scraper orchestrator (HTTP + fallback Puppeteer se serve)
│   ├── parser.js                # Parser HTML unificato (linkedom in Node, DOM nativo in browser)
│   └── exporters.js             # Generatori CSV (BOM UTF-8), ICS (RFC 5545) e JSON
├── public/                      # Sorgente statica della dashboard web
│   ├── index.html               # Markup con tab Marcatori e modale PIN
│   ├── app.js                   # Logica client-side (render, decifratura PIN WebCrypto, polling)
│   ├── style.css                # Stile responsive
│   ├── favicon.svg              # Favicon
│   └── auth.json                # Payload cifrato del token GitHub (salt, iv, tag, data)
├── data/
│   ├── cache/                   # JSON grezzi scrapati per campionato
│   ├── exports/                 # Export pregenerati (.ics, .csv, .json)
│   └── db/
│       ├── calcio.sqlite        # Database SQLite locale (ignorato da git)
│       └── snapshot.jsonl       # Snapshot testuale tracciato da Git
├── test/                        # 135 unit test con node:test (100% passati)
├── RASPBERRY.md                 # Guida operativa Raspberry Pi SSH e comandi
├── README.md                    # Documentazione generale aggiornata
├── HANDOVER.md                  # Questo documento per agenti AI
└── package.json
```

---

## 7. Stato Corrente e Comandi Utili
- **Suite di Test:** Eseguire `npm run verify` (verifica parità asset di root con `check:pages` ed esegue i 135 test con `node --test`). Attualmente **135/135 passati**.
- **Working Tree Git:** Pulito, allineato su `main` con il remote `origin/main`.
- **Come avviare lo scraping da Raspberry via SSH:**
  ```bash
  cd ~/calcio-toscana-scraper
  node bin/cli.js scrape all --refresh -i   # Veloce incrementale (~5-10s)
  node bin/cli.js scrape all --refresh      # Completo 94 giornate (~60s)
  ```
- **Come riavviare il server web locale sul Raspberry:**
  ```bash
  pm2 restart calcio-scraper
  ```
