# ⚽ Calcio Toscana Scraper & Calendari Tool

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
- **Node.js** (v18 o superiore raccomandato)
- Un browser basato su Chromium installato nel sistema (Google Chrome, Brave, Chromium o Edge). Viene rilevato automaticamente.

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

---

## 📁 Struttura del Progetto

```
scraping/
├── bin/
│   └── cli.js            # Interfaccia a riga di comando (CLI)
├── src/
│   ├── config.js         # Configurazione campionati, URL e rilevamento Chrome
│   ├── scraper.js        # Motore Puppeteer per estrazione dati e gestione WAF
│   ├── parser.js         # Parsing HTML di giornate, date e classifiche
│   ├── exporters.js      # Generatori di esportazione JSON, CSV e ICS (RFC 5545)
│   └── server.js         # Server Express per API e Web Dashboard
├── public/
│   ├── index.html        # Pagina principale della Web Dashboard
│   ├── app.js            # Logica frontend (fetch API, filtri, rendering)
│   └── style.css         # Stile moderno e responsive
├── data/
│   ├── cache/            # Dati JSON cachati localmente
│   └── exports/          # File esportati (.csv, .ics, .json)
├── package.json
└── README.md
```

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
Nel repository è già configurato il file `.github/workflows/update.yml`:
- Esegue in automatico lo scraping ogni **domenica sera alle 23:00** (dopo le partite) e ogni **lunedì mattina**.
- Aggiorna i dati e fa commit automatico sul repository.
- Puoi attivare **GitHub Pages** (Settings > Pages > Deploy from branch > cartella `public` o `root`) per avere il sito online su una CDN ad altissima velocità che non va mai in standby!

---

1. Esegui il comando di esportazione per la tua squadra, ad esempio:
   ```bash
   node bin/cli.js export promozione-c --team "Centro Storico Lebowski" --format ics
   ```
2. Troverai il file in `data/exports/promozione-c_centro_storico_lebowski.ics`.
3. **Google Calendar**: vai su Impostazioni > *Aggiungi calendario* > *Importa* e seleziona il file `.ics`.
4. **Apple Calendar (Mac/iPhone)**: fai doppio click sul file `.ics` o invialo via AirDrop/email al tuo iPhone per aggiungere tutte le partite all'agenda con data, ora esatta e marcatori.
