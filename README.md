# ⚽ Calcio Toscana Scraper & Calendari Tool

> 🌐 **Dashboard Web Online:** **[https://cicciocanestro.github.io/calcio-toscana-scraper/](https://cicciocanestro.github.io/calcio-toscana-scraper/)**

Un tool completo e automatizzato di web scraping per estrarre, consultare ed esportare i **calendari aggiornati**, i **risultati** e le **classifiche** dei campionati dilettantistici toscani:

1. **Promozione Toscana - Girone C**
2. **Seconda Categoria Toscana - Girone I**
3. **Terza Categoria Arezzo - Girone Unico**

La fonte dati principale è [Tuttocampo.it](https://www.tuttocampo.it), con gestione integrata del bypass anti-bot/WAF, caricamento rapido di tutte le giornate, esportazione multipiattaforma e una **Dashboard Web** moderna.

---

## 🌟 Funzionalità Principali

- 📅 **Calendario Completo**: Tutte le giornate della stagione con date, orari, squadre in casa e trasferta, risultati finali e marcatori con minutaggio.
- 🏆 **Classifica Aggiornata**: Punti, partite giocate, vinte, nulle, perse, gol fatti/subiti, differenza reti ed evidenziazione delle zone (promozione diretta, playoff, playout, retrocessione).
- ⏭ **Prossimo Turno & Ultimi Risultati**: Visualizzazione istantanea delle partite del turno in programma e dei risultati dell'ultimo turno disputato.
- 🔍 **Filtro Squadra**: Possibilità di filtrare il calendario per qualsiasi squadra (es. *Centro Storico Lebowski*, *Arezzo FA*, *Monterchiese*, ecc.).
- 📥 **Esportazione Multi-Formato**:
  - **iCalendar (`.ics`)**: Importa il calendario direttamente su Google Calendar, Apple Calendar (iPhone/Mac) o Outlook. Puoi esportare sia l'intero campionato che solo le partite della tua squadra!
  - **CSV (`.csv`)**: Tabella con encoding UTF-8 BOM pronta per essere aperta su Microsoft Excel o Fogli Google.
  - **JSON (`.json`)**: Formato dati grezzo per sviluppatori e integrazioni API.
- ⚡ **Cache Intelligente**: I dati vengono salvati localmente in `data/cache/` per risposte istantanee (TTL configurabile), con opzione di refresh forzato (`--refresh` o bottone web).
- 💻 **Doppia Interfaccia**:
  - **CLI (Terminale)**: Tabelle formattate e colorate.
  - **Dashboard Web**: Interfaccia grafica responsive accessibile da browser.

---

## 🚀 Avvio Rapido

### 1. Requisiti
- **Node.js** (v20 o superiore; il progetto e la CI usano Node 22)
- Un browser basato su Chromium installato nel sistema (Google Chrome, Brave, Chromium o Edge). Viene rilevato automaticamente.
  Puoi forzare un percorso specifico con la variabile d'ambiente `CHROME_PATH`. La ricerca del browser è **lazy**: la dashboard web e gli export funzionano anche senza Chrome installato (serve solo per lo scraping live).

### 2. Installazione
I moduli principali sono già configurati nella cartella del progetto:
```bash
npm install
```

---

## 🖥️ Utilizzo da Riga di Comando (CLI)

Il tool offre comandi dedicati tramite `node bin/cli.js`:

### 🏆 Visualizzare la Classifica
```bash
# Promozione Girone C
node bin/cli.js standings promozione-c

# Seconda Categoria Girone I
node bin/cli.js standings seconda-i

# Terza Categoria Arezzo
node bin/cli.js standings terza-arezzo
```

### ⚽ Visualizzare il Prossimo Turno
```bash
node bin/cli.js next promozione-c
node bin/cli.js next seconda-i
node bin/cli.js next terza-arezzo
```

### 📋 Visualizzare gli Ultimi Risultati
```bash
node bin/cli.js results promozione-c
node bin/cli.js results seconda-i
node bin/cli.js results terza-arezzo
```

### 📅 Consultare il Calendario
```bash
# Mostra tutte le giornate
node bin/cli.js calendar promozione-c

# Mostra solo una giornata specifica (es. 4° giornata)
node bin/cli.js calendar promozione-c --day 4

# Mostra tutte le partite di una squadra specifica
node bin/cli.js calendar promozione-c --team "Lebowski"
node bin/cli.js calendar seconda-i --team "Arezzo FA"
node bin/cli.js calendar terza-arezzo --team "Monterchiese"
```

### 🔄 Aggiornare i Dati dal Web (Scraping)
```bash
# Aggiorna un singolo campionato forzando il download dal web
node bin/cli.js scrape promozione-c --refresh

# Aggiorna tutti i campionati contemporaneamente
node bin/cli.js scrape all --refresh
```

### 📤 Esportare i Dati (ICS, CSV, JSON)
```bash
# Esporta tutti i formati nella cartella data/exports/
node bin/cli.js export promozione-c

# Esporta il file .ics per sincronizzare le partite della tua squadra su Google Calendar / iPhone:
node bin/cli.js export promozione-c --team "Centro Storico Lebowski" --format ics
node bin/cli.js export seconda-i --team "Poppi" --format ics
node bin/cli.js export terza-arezzo --team "Monterchiese" --format ics
```

---

## 🌐 Dashboard Web Interattiva

Puoi avviare un'interfaccia grafica completa nel browser con un solo comando:

```bash
npm start
# oppure:
node bin/cli.js serve
```

Apri nel tuo browser: **[http://localhost:3000](http://localhost:3000)**

### Funzionalità della Dashboard Web:
- **Schede di selezione rapida** tra i 3 campionati.
- **Selettore di giornata** con navigazione `< Precedente` e `Successiva >`.
- **Tabella della classifica** con evidenziazione automatica dei colori per promozione diretta, playoff, playout e retrocessione.
- **Tab Ricerca Squadra**: seleziona una squadra per visualizzare il suo calendario completo e scaricare il file `.ics` dedicato con un click.
- **Pulsante "Aggiorna dal Web"**: riscarica i dati live e aggiorna la vista senza ricaricare la pagina.
- **Download con un click** di CSV, JSON e file di calendario per il tuo telefono.

### Come si comporta il backend (cache e aggiornamenti)
- `GET /api/leagues/:id` risponde **subito** con i dati in cache (anche se più vecchi delle 2 ore di TTL, marcati `isStale: true`)
  e, se la cache è scaduta, avvia in background l'aggiornamento dal sito ufficiale. La dashboard non resta mai bloccata per 30-60 secondi.
- `POST /api/leagues/:id/refresh` (pulsante "Aggiorna dal Web") oppure `GET /api/leagues/:id?refresh=true` forzano lo scraping live e attendono il risultato.
- Se lo scraping live fallisce (WAF, rete, timeout) ma esiste una copia in cache, viene servita quella marcata `isStale: true`
  invece di restituire un errore.
- Gli endpoint statici espongono **solo** `public/` (dashboard) e `/data` (cache ed export): sorgenti, configurazione e
  dipendenze non sono scaricabili.
- Se sulla macchina/istanza è impostata la variabile `REFRESH_TOKEN`, gli aggiornamenti forzati richiedono
  l'header `x-refresh-token` (vedi sotto). Senza la variabile tutto resta aperto come prima, comodo in locale.
- `GET /api/diagnostics` mostra il commit in esecuzione, la modalità di scraping attiva e **quale percorso**
  (HTTP o browser) ha prodotto i dati l'ultima volta per ogni campionato: utile per capire cosa succede
  sull'istanza remota senza leggere i log.
- `GET /api/health` è un health check minimale (`{ "status": "ok" }`) che **non legge la cache**: è quello
  configurato come `healthCheckPath` su Render, al posto di `/api/leagues` che deve interpretare i JSON di
  tutti i campionati a ogni ping.
- Dopo un **aggiornamento manuale** andato a buon fine (pulsante "Aggiorna dal Web") l'istanza chiede al
  workflow GitHub Actions di pubblicare i dati nel repository: vedi
  [Pubblicazione su GitHub](#-pubblicazione-su-github-dal-pulsante-di-render).

---

## 🔄 Aggiornamenti automatici senza tenere il PC acceso

Il WAF di Tuttocampo **blocca gli IP dei runner GitHub Actions** (`403 Forbidden`), quindi lo scraping non può
partire da GitHub. L'istanza **Render** invece non è bloccata: la pipeline usa Render per scaricare i dati e
GitHub Actions solo per committarli, così il sito su GitHub Pages resta sempre aggiornato senza alcun computer accesso.

```
GitHub Actions (cron domenica/lunedì)
   └─> node bin/fetch-from-render.js        # chiede i dati a Render (IP non bloccato)
         └─> Render: GET /api/leagues/:id?refresh=true   # scraping reale dal sito
   └─> node bin/cli.js export all           # rigenera CSV/ICS/JSON dalla cache fresca
   └─> node bin/data-changed.js             # salta il commit se non è cambiato nulla di sportivo
   └─> commit + push                        # GitHub Pages si ripubblica da solo
```

Se l'istanza remota non risponde, il workflow ripiega sullo scraping locale dal runner (che normalmente viene
bloccato) e in ultima istanza **conserva i dati in cache** emettendo un warning, senza mai rompere il sito.
Se i dati sportivi sono identici a quelli già pubblicati, **non viene creato nessun commit**: i campi volatili
(`lastUpdated`, `DTSTAMP` degli ICS) vengono scartati per non sporcare la cronologia ogni settimana.

### 🔘 Pubblicazione su GitHub dal pulsante di Render

Il pulsante "Aggiorna dal Web" della dashboard aggiorna i dati **anche sul sito pubblico**, non solo
sull'istanza. Funziona solo se configuri un token; senza token il comportamento resta quello di prima
(i dati vengono aggiornati solo sull'istanza e restano lì fino alla prossima esecuzione del cron).

```
Pulsante "Aggiorna dal Web" sulla dashboard Render
   └─> POST /api/leagues/refresh-all          # scraping reale sull'istanza (IP non bloccato)
   └─> il server avvia il workflow GitHub Actions (workflow_dispatch)
         └─> node bin/fetch-from-render.js --no-refresh   # riusa i dati appena scaricati
         └─> export + data-changed + commit + push        # stessa pipeline del cron
```

Perché così e non un push diretto da Render: il workflow resta **l'unico scrittore** del repository e
conosce le regole di pubblicazione (confronto dei soli dati sportivi, rigenerazione degli export, asset di
Pages). Il flag `--no-refresh` evita di pagare due volte il bootstrap del browser per la challenge WAF.

> Il workflow viene avviato **solo** dai refresh manuali (`POST .../refresh-all` e `POST .../:id/refresh`).
> Lo scraping forzato via `GET ?refresh=true`, che è quello usato dalla CI, non lo innesca: altrimenti ogni
> esecuzione del cron ne genererebbe un'altra all'infinito.

#### Configurazione (facoltativa)

| Dove | Nome | Tipo | A cosa serve |
|---|---|---|---|
| GitHub → Settings → Developer settings → **Fine-grained token** | `GITHUB_DISPATCH_TOKEN` | Env var su Render | PAT con permesso **Actions: Read and write** sul repo: abilita la pubblicazione automatica |
| Render → Environment | `GITHUB_REPOSITORY` | Env var | `owner/repo` (opzionale: se assente si usa `RENDER_GIT_REPO`, che Render imposta da solo) |
| Render → Environment | `GITHUB_BRANCH` | Env var | Branch del workflow (default: `main`) |

Se `GITHUB_DISPATCH_TOKEN` non è impostato il dispatcher è disattivato e non viene fatta nessuna chiamata
di rete: sviluppo locale e deploy esistenti continuano a funzionare senza modifiche.

### Sicurezza degli aggiornamenti forzati
Senza configurazione, chiunque conosca l'URL dell'istanza può farle avviare uno scraping. Per blindarlo basta
impostare **lo stesso valore** in due posti:

| Dove | Nome | Tipo | A cosa serve |
|---|---|---|---|
| Render → Environment | `REFRESH_TOKEN` | Env var | Il server richiede l'header `x-refresh-token` sugli aggiornamenti forzati |
| GitHub → Settings → Secrets and variables → Actions | `REFRESH_TOKEN` | Secret | Il workflow invia l'header nelle richieste a Render |

Se la variabile **non** è impostata su Render, il token inviato da GitHub viene semplicemente ignorato (utile in locale).
Se invece la imposti su Render con un valore diverso da quello del secret, gli aggiornamenti verranno rifiutati
(`401`) e il workflow conserverà i dati precedenti emettendo un warning.

### Altre configurazioni (facoltative)

| Dove | Nome | Tipo | A cosa serve |
|---|---|---|---|
| GitHub → Settings → Variables | `RENDER_URL` | Variable | Cambia l'URL dell'istanza (default: `https://calcio-toscana-scraper.onrender.com`) |
| Render (o locale) | `SCRAPER_MODE` | Env var | `auto` (default), `http` o `browser`: forza un percorso di scraping |
| Render (o locale) | `CHROME_USER_DATA_DIR` | Env var | Profilo Chrome in una cartella scrivibile (utile in sandbox/container) |

```bash
# Aggiornamento manuale dall'istanza remota verso la cache locale
node bin/fetch-from-render.js --url https://calcio-toscana-scraper.onrender.com --out data/cache

# Se l'istanza ha appena scrapato (es. pulsante "Aggiorna dal Web"), riusa la sua
# cache invece di forzare un secondo scraping (evita un altro bootstrap del browser)
node bin/fetch-from-render.js --no-refresh

# Verifica se i dati sportivi sono cambiati rispetto all'ultimo commit
node bin/data-changed.js   # exit 0 = cambiati, 1 = invariati
```

> **Nota Render (piano free)**: il filesystem è effimero e l'istanza va in sleep dopo 15 minuti di inattività.
> Non è un problema: i dati vengono riportati nel repository (che è la fonte durevole) e la prima visita
> successiva riattiva l'istanza in ~30-40 secondi.

---

## ⚡ Tre stadi di scraping: HTTP, ibrido e browser

Lo scraping sceglie automaticamente lo stadio più veloce che funziona, e tutti producono **gli stessi dati**
(verificato dal vivo con `npm run parity`):

| Stadio | Come | Quando si usa | Tempo per campionato |
|---|---|---|---|
| 1. **HTTP** | `fetch` + cookie `PHPSESSID` + token letti dall'HTML | IP non sospetti (residenziale, e in genere anche l'istanza Render) | **~0,7-1,0 s** |
| 2. **Ibrido** | Il browser risolve la challenge WAF **una volta sola per run**, poi i 31 payload di ogni campionato arrivano via HTTP riusando i cookie (`aws-waf-token`) | Quando lo stadio 1 riceve una challenge (`202`/`403`/`x-amzn-waf-action`) | ~2 s per campionato + **un** bootstrap (~60 s su Render free) |
| 3. **Browser** | Puppeteer naviga e scarica tutto dentro la pagina | Se anche il bootstrap non basta | ~3,4 s (Mac), ~45-85 s (Render free) |

Se anche l'ultimo stadio fallisce, si conserva la cache precedente: **il sito non si rompe mai**.

Misurato in produzione (Render): lo stadio 1 riceve una challenge `HTTP 202` dal WAF, quindi entra in gioco lo
stadio 2. Da IP residenziale lo stadio 1 funziona da solo (240 partite identiche alla cache in ~0,6 s).

Sull'istanza free il costo dominante è **avviare Chrome** (0,1 CPU), non scaricare i dati: per questo il
bootstrap è condiviso e viene fatto al massimo una volta per run, mentre i 3 campionati si scaricano via HTTP.

`GET /api/diagnostics` mostra quale stadio è stato usato l'ultima volta (`http`, `http-after-bootstrap`,
`browser-fallback`), con durata ed eventuale errore.

```bash
# Confronto dal vivo fra i percorsi (non scrive nulla nel repository)
npm run parity                                    # HTTP e browser completo
node bin/parity-check.js --http-only --vs-cache   # veloce: solo HTTP contro la cache
```

> **Modalità forzata**: `SCRAPER_MODE=http` (solo stadio 1), `SCRAPER_MODE=browser` (solo stadio 3),
> `SCRAPER_MODE=auto` (default, tutti gli stadi in cascata).

> **Attenzione al rate limiting**: il WAF ha regole basate sulla frequenza. Eseguire molti scrape completi in
> sequenza ravvicinata (come durante i test) può far comparire una verifica "Human Verification" che richiede
> intervento umano. Nell'uso normale (una manciata di richieste a settimana) non è un problema.

---

## 📁 Struttura del Progetto

```
scraping/
├── bin/
│   ├── cli.js            # Interfaccia a riga di comando (CLI)
│   ├── build-pages.js    # Rigenera gli asset di root per GitHub Pages da public/
│   ├── parity-check.js   # Confronta dal vivo i percorsi HTTP e browser
│   ├── fetch-from-render.js  # Scarica i dati dall'istanza sempre accesa (con retry)
│   └── data-changed.js   # Rileva se i dati sportivi sono cambiati (evita commit inutili)
├── src/
│   ├── config.js         # Configurazione campionati, URL e rilevamento Chrome
│   ├── scraper.js        # Orchestrazione: cache, modalità HTTP/browser, persistenza
│   ├── http-scraper.js   # Percorso veloce: fetch + cookie, senza browser
│   ├── parser.js         # Parsing HTML di giornate e classifiche (unica fonte di verità)
│   ├── exporters.js      # Generatori di esportazione JSON, CSV e ICS (RFC 5545)
│   ├── github-dispatch.js # Avvio del workflow GitHub dopo un refresh manuale (opzionale)
│   └── server.js         # Server Express per API e Web Dashboard
├── public/               # ⚠️ Sorgente della dashboard: modificare SOLO questi file
│   ├── index.html        # Pagina principale della Web Dashboard
│   ├── app.js            # Logica frontend (fetch API, filtri, rendering)
│   └── style.css         # Stile moderno e responsive
├── test/                 # Test automatici (node:test)
│   ├── parser.test.js
│   ├── exporters.test.js
│   ├── server.test.js
│   ├── fetch-render.test.js
│   ├── data-changed.test.js
│   ├── github-dispatch.test.js
│   ├── http-scraper.test.js
│   └── scraper-mode.test.js
├── index.html            # ┐
├── app.js                # ├ copie generate da public/ per GitHub Pages
├── style.css             # ┘ (npm run build:pages, committate dalla CI)
├── data/
│   ├── cache/            # Dati JSON cachati localmente
│   └── exports/          # File esportati (.csv, .ics, .json)
├── package.json
└── README.md
```

> **Nota sulla duplicazione degli asset**: GitHub Pages pubblica la root del branch, mentre il server Node serve `public/`.
> Per non mantenere due copie a mano, `public/` è l'unica fonte di verità: `index.html`, `app.js` e `style.css` nella root
> sono generati con `npm run build:pages` (la CI li rigenera e verifica ad ogni push con `npm run check:pages`).

---

## 🧪 Test e verifiche automatiche

```bash
# Suite di test (parser HTML, exporter CSV/ICS/JSON, API Express, cache,
# percorso HTTP, rilevazione WAF e dispatch delle modalità)
npm test

# Verifica che gli asset di root siano allineati a public/
npm run check:pages

# Entrambe le cose
npm run verify
```

I test girano con il test runner integrato di Node (`node:test`) e con `linkedom` come DOM di test: non richiedono
né browser né rete. Il workflow GitHub Actions esegue `check:pages` + `npm test` ad ogni push e pull request.

---

## 🧩 Campionati e ID supportati

| ID Campionato | Nome Completo | Categoria | Girone | Giornate |
|---|---|---|---|---|
| `promozione-c` | Promozione Toscana - Girone C | Promozione | Girone C | 30 |
| `seconda-i` | Seconda Categoria Toscana - Girone I | Seconda Categoria | Girone I | 30 |
| `terza-arezzo` | Terza Categoria Arezzo - Girone Unico | Terza Categoria | Girone Unico | 34 |

---

## ☁️ Come Deployare Gratis la Dashboard Web

Ci sono due modi gratuiti e semplicissimi per pubblicare questa dashboard online:

### 🥇 Opzione 1: Render.com (Consigliata per avere tutto attivo, incluso lo scraping live)
**Render.com** offre un piano gratuito con supporto Docker nativo, perfetto per eseguire Node.js ed il browser Chromium.

1. Carica il progetto su un tuo repository **GitHub**.
2. Registrati gratuitamente su **[Render.com](https://render.com)**.
3. Clicca su **New +** > **Web Service**.
4. Connetti il tuo repository GitHub.
5. Render rileverà in automatico il file `Dockerfile` e `render.yaml` già presenti nel progetto!
6. Seleziona il piano **Free** e clicca **Create Web Service**.
7. In circa 2-3 minuti il tuo sito sarà online con HTTPS gratuito del tipo:
   `https://tuo-progetto.onrender.com`

> **Nota sul Free Tier di Render**: Il server va in standby (sleep) dopo 15 minuti di inattività e si riattiva in circa 30-40 secondi alla prima visita successiva.

---

### 🥈 Opzione 2: GitHub Actions (100% Gratis, Zero Server in standby)

La dashboard è già online e attiva su:
👉 **[https://cicciocanestro.github.io/calcio-toscana-scraper/](https://cicciocanestro.github.io/calcio-toscana-scraper/)**

Nel repository è configurato il file `.github/workflows/update.yml`:
- Esegue in automatico lo scraping ogni **domenica sera alle 21:00 UTC** (dopo le partite) e ogni **lunedì mattina alle 08:00 UTC**.
- Rigenera gli asset della dashboard da `public/` (`npm run build:pages`), aggiorna i dati e fa commit automatico sul repository.
- Ad ogni **push e pull request** esegue invece il job di verifica: `npm run check:pages` (asset di root allineati a `public/`) e `npm test`.
- Il sito è ospitato sulla CDN globale di GitHub Pages, carica all'istante e non va mai in standby!

---

1. Esegui il comando di esportazione per la tua squadra, ad esempio:
   ```bash
   node bin/cli.js export promozione-c --team "Centro Storico Lebowski" --format ics
   ```
2. Troverai il file in `data/exports/promozione-c_centro_storico_lebowski.ics`.
3. **Google Calendar**: vai su Impostazioni > *Aggiungi calendario* > *Importa* e seleziona il file `.ics`.
4. **Apple Calendar (Mac/iPhone)**: fai doppio click sul file `.ics` o invialo via AirDrop/email al tuo iPhone per aggiungere tutte le partite all'agenda con data, ora esatta e marcatori.
