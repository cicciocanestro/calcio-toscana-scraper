# ⚽ Calcio Toscana Scraper & Calendari Tool

> 🌐 **Dashboard Web Online:** **[https://cicciocanestro.github.io/calcio-toscana-scraper/](https://cicciocanestro.github.io/calcio-toscana-scraper/)**

Un tool completo e automatizzato di web scraping e database relazionale per estrarre, consultare ed esportare i **calendari aggiornati**, i **risultati**, le **classifiche**, la **classifica marcatori** e lo **stato di forma** dei campionati dilettantistici toscani:

1. **Promozione Toscana - Girone C**
2. **Seconda Categoria Toscana - Girone I**
3. **Terza Categoria Arezzo - Girone Unico**

La fonte dati principale è [Tuttocampo.it](https://www.tuttocampo.it), con gestione integrata del bypass anti-bot/WAF, caricamento rapido incrementale, persistenza su database relazionale **SQLite**, snapshot testuale versionato su Git e una **Dashboard Web** moderna.

---

## 🌟 Funzionalità Principali

- 📅 **Calendario Completo**: Tutte le giornate della stagione con date, orari, squadre in casa e trasferta, risultati finali e marcatori con minutaggio.
- 🏆 **Classifica Aggiornata**: Punti, partite giocate, vinte, nulle, perse, gol fatti/subiti, differenza reti ed evidenziazione delle zone (promozione diretta, playoff, playout, retrocessione).
- ⚽ **Classifica Marcatori (Novità Database)**: Tabella marcatori aggregata per girone con gol totali, rigori e squadra di appartenenza.
- 📈 **Stato di Forma (Novità Database)**: Analisi delle ultime partite disputate da ogni squadra con striscia risultati (`V`, `N`, `P`) e punti conquistati.
- ⏭ **Prossimo Turno & Ultimi Risultati**: Visualizzazione istantanea delle partite del turno in programma e dei risultati dell'ultimo turno disputato.
- 🔍 **Filtro Squadra**: Possibilità di filtrare il calendario per qualsiasi squadra (es. *Centro Storico Lebowski*, *Arezzo FA*, *Monterchiese*, ecc.).
- 📥 **Esportazione Multi-Formato**:
  - **iCalendar (`.ics`)**: Importa il calendario direttamente su Google Calendar, Apple Calendar (iPhone/Mac) o Outlook. Puoi esportare sia l'intero campionato che solo le partite della tua squadra!
  - **CSV (`.csv`)**: Tabella con encoding UTF-8 BOM pronta per essere aperta su Microsoft Excel o Fogli Google.
  - **JSON (`.json`)**: Formato dati grezzo per sviluppatori e integrazioni API.
- 🗄️ **Database SQLite & Snapshot Git**: Persistenza relazionale su `data/db/calcio.sqlite` con dump testuale versionato `data/db/snapshot.jsonl` (auto-rebuild all'avvio in < 50ms).
- ⚡ **Scraping Incrementale Intelligente**: Aggiorna miratamente solo la giornata corrente, precedente e successiva riducendo del 90% il traffico e azzerando i rischi di blocco WAF.
- 💻 **Doppia Interfaccia**:
  - **CLI (Terminale)**: Tabelle formattate e colorate.
  - **Dashboard Web & REST API**: Interfaccia grafica responsive accessibile da browser ed endpoint JSON dedicati.

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
node bin/cli.js standings promozione-c
node bin/cli.js standings seconda-i
node bin/cli.js standings terza-arezzo
```

### ⚽ Visualizzare la Classifica Marcatori (Nuovo)
```bash
# Mostra i primi 15 marcatori
node bin/cli.js scorers promozione-c
node bin/cli.js scorers seconda-i
node bin/cli.js scorers terza-arezzo

# Con limite personalizzato
node bin/cli.js scorers promozione-c --limit 25
```

### 📈 Visualizzare lo Stato di Forma (Nuovo)
```bash
# Mostra la forma nelle ultime 5 partite
node bin/cli.js form promozione-c
node bin/cli.js form seconda-i --matches 3
node bin/cli.js form terza-arezzo
```

### ⚽ Visualizzare il Prossimo Turno & Risultati
```bash
node bin/cli.js next promozione-c
node bin/cli.js results promozione-c
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
# Scraping incrementale veloce (giornata corrente + precedente + successiva):
node bin/cli.js scrape all --refresh --incremental
node bin/cli.js scrape promozione-c --refresh -i

# Scraping completo di tutte le 30-34 giornate:
node bin/cli.js scrape all --refresh
```

### 📤 Esportare i Dati (ICS, CSV, JSON)
```bash
# Esporta tutti i formati nella cartella data/exports/
node bin/cli.js export all

# Esporta il file .ics per una squadra specifica:
node bin/cli.js export promozione-c --team "Centro Storico Lebowski" --format ics
node bin/cli.js export seconda-i --team "Poppi" --format ics
node bin/cli.js export terza-arezzo --team "Monterchiese" --format ics
```

---

## 🗄️ Gestione Database SQLite & Snapshot Git

I dati relazionali vivono in `data/db/calcio.sqlite` e vengono salvati in formato testuale diffabile su Git tramite lo snapshot JSON Lines (`data/db/snapshot.jsonl`):

```bash
# Stato del database e conteggio record per tabella
npm run db:status
# oppure: node bin/db-snapshot.js status

# Esporta SQLite nel file snapshot JSONL per Git
npm run db:dump
# oppure: node bin/db-snapshot.js dump

# Ripristina SQLite dallo snapshot JSONL
npm run db:restore
# oppure: node bin/db-snapshot.js restore

# Popola SQLite partendo dai file cache data/cache/*.json
npm run db:import
# oppure: node bin/db-import.js
```

---

## 🌐 Dashboard Web & API Server

Puoi avviare l'interfaccia grafica e le API nel browser con un solo comando:

```bash
npm start
# oppure:
node bin/cli.js serve
```

Apri nel tuo browser: **[http://localhost:3000](http://localhost:3000)**

### Nuovi Endpoint API REST:
- `GET /api/leagues`: elenco campionati, stato cache e aggiornamenti.
- `GET /api/leagues/:id`: dati completi del campionato.
- `GET /api/leagues/:id/scorers?limit=20`: classifica marcatori aggregata.
- `GET /api/leagues/:id/form?matches=5`: stato di forma recente delle squadre.
- `GET /api/leagues/:id/export/:format`: download al volo di file `.ics`, `.csv` o `.json`.

---

## 🔄 Come funziona l'architettura da Remoto (Render + GitHub Actions)

Il WAF di Tuttocampo **blocca gli IP datacenter aggressivi (come GitHub Actions e Oracle Cloud)** con un errore `403 Forbidden`. L'istanza **Render** invece possiede un indirizzo IP non bloccato.

L'architettura sfrutta questa sinergia a costo zero:

```
[Visitatore / Smartphone] ───> GitHub Pages (CDN globale sempre attiva, zero sleep)
                                    ▲
                                    │ commit + push automatico
                                    │
                              GitHub Actions (Cron dom/lun o manuale)
                                    ▲
                                    │ chiede i dati freschi
                                    │
                               Render.com (Istanza Node.js con IP fidato)
                                    ▲
                                    │ scraping incrementale HTTP
                                    │
                              Tuttocampo.it (Sito ufficiale)
```

1. **GitHub Pages** ospita il sito statico pubblico: è sempre attivo, veloce e non va mai in standby.
2. **Render** fa da motore di scraping senza blocchi IP.
3. **GitHub Actions** sincronizza i dati, aggiorna SQLite, crea lo snapshot Git `data/db/snapshot.jsonl` e pubblica il sito aggiornato.

---

## 📁 Struttura del Progetto

```
scraping/
├── bin/
│   ├── cli.js            # Interfaccia a riga di comando (CLI)
│   ├── db-import.js      # Popola SQLite partendo dai file cache JSON
│   ├── db-snapshot.js    # Dump e restore dello snapshot JSONL per Git
│   ├── build-pages.js    # Rigenera gli asset di root per GitHub Pages da public/
│   ├── parity-check.js   # Confronta dal vivo i percorsi HTTP e browser
│   ├── fetch-from-render.js  # Scarica i dati dall'istanza remota
│   └── data-changed.js   # Rileva se i dati sportivi sono cambiati
├── src/
│   ├── config.js         # Configurazione campionati, percorsi e database
│   ├── db.js             # Inizializzazione SQLite DDL e auto-restore
│   ├── db-sync.js        # Import/export dati relazionali e query analitiche
│   ├── db-snapshot.js    # Logica di dump/restore JSON Lines
│   ├── store.js          # Layer di astrazione memoria (BaseStore, JsonStore, SqliteStore)
│   ├── scraper.js        # Orchestrazione scraping e guardie anti-regressione
│   ├── http-scraper.js   # Scraping HTTP incrementale ultra-veloce
│   ├── parser.js         # Parsing HTML di giornate e classifiche
│   ├── exporters.js      # Generatori di esportazione JSON, CSV e ICS (RFC 5545)
│   ├── github-dispatch.js # Innesco workflow GitHub Actions
│   └── server.js         # Server Express per API e Web Dashboard
├── data/
│   ├── db/
│   │   ├── snapshot.jsonl  # Snapshot testuale del database (tracciato da Git)
│   │   └── calcio.sqlite   # Database SQLite locale (ignorato da Git)
│   ├── cache/            # Cache JSON per campionato
│   └── exports/          # File esportati (.csv, .ics, .json)
├── public/               # Sorgente della dashboard web
├── test/                 # Suite di test automatizzati (node:test)
├── package.json
└── README.md
```

---

## 🧪 Test e verifiche automatiche

```bash
# Esegue tutti i test e verifica l'allineamento degli asset
npm run verify

# Esegue solo i test unitari
npm test
```

I test girano con il test runner integrato di Node (`node:test`) senza dipendenze esterne pesanti e includono la verifica di parità sportiva al 100% tra SQLite e i file JSON.
