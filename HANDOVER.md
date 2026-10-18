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
3. **Trigger manuale dal sito web (Personal Access Token):**  
   Dalla dashboard su GitHub Pages, cliccando *"🔄 Aggiorna dal Web"* è possibile inserire il proprio Personal Access Token GitHub (raccomandato un Fine-Grained PAT con permessi minimi solo su questo repository). Il token viene gestito unicamente in memoria locale nel browser (e salvato su richiesta solo nel `localStorage` del dispositivo utente, mai committato o esposto pubblicamente), e lancia la chiamata `POST /actions/workflows/update.yml/dispatches` che attiva il Raspberry Pi.

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

10. **Sicurezza Token GitHub e dismissione archivio auth.json cifrato con PIN:**  
    Rimosso il pattern insicuro di pubblicazione del token cifrato con un PIN a 4 cifre in `auth.json`. L'autorizzazione manuale via browser ora accetta direttamente il Personal Access Token inserito dall'utente e memorizzato unicamente nel `localStorage` del suo browser personale.

11. **Hardening di dashboard, API e CLI (sessione corrente):**
    - **CSP nella dashboard:** `public/index.html` dichiara una `Content-Security-Policy` (`script-src 'self'`, `connect-src 'self' https://api.github.com`) perché il PAT vive nel `localStorage`.
    - **Validazione `matchLink`:** `safeExternalUrl()` (in `src/exporters.js` e nel frontend) accetta solo `http/https` e rifiuta gli URL con a capo, impedendo sia link `javascript:` sia iniezioni di righe negli `.ics`.
    - **Rate limit sulle API di lettura:** `/api/leagues`, `/api/leagues/:id` e `/api/leagues/:id/scorers` passano da `apiRateLimit` (default 300 richieste/minuto per IP, configurabile con `options.apiRateLimit`).
    - **Errori per singola lega in `scrape all`:** un campionato che fallisce non interrompe più il giro; a fine run viene stampato l'elenco dei falliti ed esce con codice 1.
    - **Flag `--accept-regression`** (o `ACCEPT_REGRESSION=1`): consente di accettare esplicitamente un calo reale dei dati (es. partita annullata) invece di scartarlo in silenzio.
    - **Regressione non più silenziosa:** `scrapeLeague` arricchisce il fallback con `staleReason` (messaggio originale) e `staleCause` (`regression` | `waf` | `network` | `unknown`). La classificazione usa il **tipo** dell'errore (`err.code = 'REGRESSION'`, `err.waf`, `err.status`) e solo in ultima istanza il testo con confini di parola, per non scambiare "riga 4032" per un HTTP 403. La CLI stampa il motivo per ogni lega e, in caso di regressione, esce con **codice 3** (`EXIT_REGRESSION`) anche se altre leghe sono state aggiornate.
    - **`--report-file <path>`:** il CLI scrive un JSON con `{ total, refreshed, regressions, fromCache, failed, exitCode }`. La CI lo legge per sapere quante leghe sono state davvero aggiornate.
    - **Comportamento della CI con exit 3:** le leghe sane vengono comunque importate, esportate e **committate** (altrimenti i dati buoni andrebbero persi al checkout successivo), il fallback remoto non parte, e un ultimo step fa **fallire il job** con `::error` + dettaglio delle regressioni, così GitHub notifica invece di lasciare solo un'annotazione.
    - **Campi di servizio mai esposti:** `stripInternalFields()` (in `src/exporters.js`) rimuove `isStale`, `staleReason` e `staleCause` da `filterLeagueData`, dagli export e da tutte le risposte del server (`/api/leagues/:id`, refresh singolo e globale). `staleReason` contiene il messaggio d'errore grezzo, quindi poteva rivelare percorsi del filesystem (es. `/home/pi/actions-runner/...`).
    - **Cache HTTP rispettata:** il frontend aggiunge `?t=Date.now()` e `cache: 'no-cache'` solo dopo un aggiornamento o durante il polling, così le richieste normali possono ricevere 304.

---

## 5. Nuove Funzionalità Aggiunte
- **Scheda ⚽ Marcatori nella Dashboard:** Vista dedicata (`#view-scorers`) con classifica marcatori, gol totali, rigori e filtro squadra, funzionante sia su GitHub Pages (calcolata dai dati JSON escludendo gli autogol) sia via endpoint API SQLite `/api/leagues/:id/scorers`. Rimossa la funzionalità "Forma" come richiesto.
- **Favicon Ufficiale:** Icona vettoriale `public/favicon.svg` (e `favicon.svg` in root) integrata nell'HTML.
- **Modale Conferma Aggiornamento Web (Client-side PAT):**  
  - Permette di avviare il workflow `update.yml` invocando l'API ufficiale di GitHub Actions.
  - Nessun segreto salvato nel repository: il token viene memorizzato unicamente nel `localStorage` del browser dell'utente (opzione "Ricorda su questo browser").
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
│   ├── db-import.js             # Importa i file data/cache/*.json nel DB SQLite
│   ├── db-snapshot.js           # Dump (dump), restore (restore) e allineamento (sync) di data/db/snapshot.jsonl
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
│   ├── index.html               # Markup con tab Marcatori e modale aggiornamento
│   ├── app.js                   # Logica client-side (render, dispatch GitHub Actions, polling)
│   ├── style.css                # Stile responsive
│   └── favicon.svg              # Favicon
├── data/
│   ├── cache/                   # JSON grezzi scrapati per campionato
│   ├── exports/                 # Export pregenerati (.ics, .csv) — il JSON vive solo in cache/
│   └── db/
│       ├── calcio.sqlite        # Database SQLite locale (ignorato da git)
│       └── snapshot.jsonl       # Snapshot testuale tracciato da Git
├── test/                        # 150 unit test con node:test (100% passati)
├── RASPBERRY.md                 # Guida operativa Raspberry Pi SSH e comandi
├── README.md                    # Documentazione generale aggiornata
├── HANDOVER.md                  # Questo documento per agenti AI
└── package.json
```

---

## 7. Stato Corrente e Comandi Utili
- **Telemetria Benchmark su Raspberry Pi 3:**  
  Scraping completo di 94 giornate testato empiricamente via SSH: durata ~18s, CPU picco 49% (media 18%), RAM picco 428 MB (476 MB sempre liberi su 905 MB), Swap 0 MB, temperatura 50–52°C. Anche in caso di fallback forzato su Chromium la RAM non supera i 553 MB e la temperatura resta sotto i 60°C.
- **Suite di Test:** Eseguire `npm run verify` (verifica parità asset di root con `check:pages` ed esegue i test con `node --test`). Attualmente **175/175 passati**.
- **Working Tree Git:** Pulito, allineato su `main` con il remote `origin/main`.
- **Allineamento DB dopo un pull:** `npm run db:sync` (`node bin/db-snapshot.js sync`) ripristina `calcio.sqlite` dallo snapshot **solo se il DB è indietro**, confrontando il **corpo** dello snapshot su disco con quello ricostruito dal DB (non il checksum dichiarato nell'header, che un merge può lasciare disallineato). **Non distrugge dati**: il ripristino viene annullato se il DB contiene righe assenti dallo snapshot *oppure* se porta timestamp dei dati più recenti (`compareFreshness` su `last_updated`/`captured_at`/`score_updated_at`). Il criterio è di contenuto e non usa i mtime: aprire SQLite riscrive `-wal`/`-shm`, quindi una guardia sulle date dei file scattava quasi sempre (bug corretto). Il confronto usa **chiavi naturali** (`NATURAL_KEYS`: `slug` per le squadre, `source_key` per le partite, `match_id+team_id+ordinal` per i gol, ecc.), non gli `id` AUTOINCREMENT: un `db-import` che rigenera i gol con id nuovi non viene più scambiato per "DB più avanti". `--force` esegue comunque il ripristino dopo aver salvato un backup: il primo è `calcio.sqlite.bak`, i successivi hanno un nome con timestamp e non sovrascrivono i precedenti. È il primo passo di `npm run sync`; **non** è agganciato a `npm test`, che non deve modificare il DB (l'auto-restore di `initDatabase` copre il caso del file assente, come in CI).
- **Come avviare lo scraping da Raspberry via SSH:**
  ```bash
  cd ~/calcio-toscana-scraper
  node bin/cli.js scrape all --refresh -i   # Veloce incrementale (~5-10s)
  node bin/cli.js scrape all --refresh      # Completo 94 giornate (~60s)
  npm run sync                              # scrape + export + commit + push (con db:sync iniziale)
  ```
- **Come riavviare il server web locale sul Raspberry:**
  ```bash
  pm2 restart calcio-scraper
  ```
