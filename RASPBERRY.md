# 🍓 Guida Raspberry Pi - Scraping & Automazione

Questa guida spiega come utilizzare e gestire il tuo **Raspberry Pi 3** come motore di scraping locale, server della dashboard web e runner autonomo per GitHub Actions.

---

## 🌟 Perché il Raspberry Pi è l'ambiente ideale?

1. **Zero blocchi WAF / Anti-Bot**: Utilizzando la connessione Wi-Fi di casa (IP residenziale italiano), Tuttocampo non mostra alcuna challenge CAPTCHA o blocco WAF: lo scraping avviene in **modalità HTTP pura in pochissimi secondi** senza dover aprire Chromium.
2. **Consumo energetico quasi nullo**: Il Raspberry Pi 3 consuma meno di 2–3 Watt ed è sempre attivo e pronto 24/7.
3. **Completamente autonomo**: Tramite il servizio di sistema (`actions.runner`), GitHub Actions delega l'aggiornamento automatico della domenica sera e del lunedì direttamente al Pi.

---

## 🔌 1. Connessione al Raspberry Pi via SSH

Dal tuo Mac (collegato alla stessa rete Wi-Fi di casa):

```bash
# Tramite indirizzo IP locale:
ssh cicciocanestro@192.168.1.151

# Oppure tramite nome host:
ssh cicciocanestro@calcio-pi
```

Inserisci la tua password quando richiesto.

Entra nella cartella del progetto:
```bash
cd ~/calcio-toscana-scraper
```

---

## 🔄 2. Eseguire lo Scraping dal Raspberry

### A. Scraping Veloce Incrementale (~5-10 secondi) ⚡
Aggiorna miratamente solo la giornata corrente, precedente e successiva:
```bash
node bin/cli.js scrape all --refresh -i
```

### B. Scraping Completo di tutte le 94 giornate (~30-60 secondi)
Riscarica da zero ogni giornata, risultato e marcatore della stagione:
```bash
node bin/cli.js scrape all --refresh
```

### C. Scraping di un singolo campionato
```bash
node bin/cli.js scrape promozione-c --refresh
node bin/cli.js scrape seconda-i --refresh
node bin/cli.js scrape terza-arezzo --refresh
```

---

## 📊 3. Consultare i Dati dal Terminale

Puoi visualizzare tabelle formattate a colori direttamente dentro la sessione SSH:

```bash
# 🏆 Classifica aggiornata con evidenziazione zone playoff/playout
node bin/cli.js standings promozione-c
node bin/cli.js standings seconda-i
node bin/cli.js standings terza-arezzo

# ⚽ Classifica marcatori con gol e rigori
node bin/cli.js scorers promozione-c
node bin/cli.js scorers seconda-i
node bin/cli.js scorers terza-arezzo --limit 20

# ⏭ Prossimo turno in programma
node bin/cli.js next promozione-c
node bin/cli.js next seconda-i --team "Arezzo FA"

# ⚽ Ultimi risultati disputati con marcatori
node bin/cli.js results promozione-c

# 📅 Calendario completo o per squadra
node bin/cli.js calendar promozione-c --day 6
node bin/cli.js calendar promozione-c --team "Lebowski"
```

---

## 🌐 4. Pubblicare su GitHub Pages direttamente dal Raspberry

Se esegui lo scraping manualmente da SSH e desideri pubblicare subito i nuovi calendari sul sito pubblico (`cicciocanestro.github.io`), il comando rapido fa tutto da solo:

```bash
# Allinea il DB allo snapshot, scarica i dati, rigenera export e asset, poi commit e push
npm run sync
```

`npm run sync` esegue in sequenza: `db:sync` (allinea SQLite se serve, senza mai cancellare righe presenti solo nel DB) → scraping incrementale → `db:import` → `db:dump` → export CSV/ICS → `build:pages` → commit → push.

> 🧭 **Se lo scraping trova dati in calo** (classifica più corta o meno partite con risultato) il comando si ferma senza committare e ti indica il motivo. Se il calo è reale — per esempio Tuttocampo ha annullato una partita — rilancia con:
>
> ```bash
> node bin/cli.js scrape all --refresh --accept-regression
> ```

Se preferisci il controllo manuale passo per passo:

```bash
node bin/db-snapshot.js sync && \
node bin/cli.js scrape all --refresh && \
npm run db:import && \
npm run db:dump && \
npm run export && \
npm run build:pages && \
git commit -am "chore(data): aggiornamento manuale da Raspberry Pi" && \
git push origin main
```

---

## 📥 4b. Dopo un `git pull` sul Raspberry

Il database locale `data/db/calcio.sqlite` non è versionato: se il pull ha portato dati nuovi, va riallineato prima di usarlo. Ci pensa `npm run db:sync` (gratuito quando è già a posto, perché confronta un checksum e non le date):

```bash
cd ~/calcio-toscana-scraper
git pull origin main
npm run db:sync      # ripristina solo se serve
pm2 restart calcio-scraper
```

> ⚠️ **Il sync non sovrascrive mai un DB più avanti dello snapshot.** Se sul Pi hai premuto "Aggiorna dal Web" (o fatto `db:import` senza `dump`), il database contiene classifiche e marcatori che lo snapshot non ha — oppure valori più recenti sulle stesse righe: in entrambi i casi il comando si ferma con un avviso (indicando le tabelle o i "valori locali più recenti"). Le due strade:
>
> ```bash
> npm run db:dump                 # esporta prima quello che c'è nel DB
> npm run db:sync -- --force      # oppure forza (backup automatico)
> ```
>
> I backup non si sovrascrivono: il primo è `data/db/calcio.sqlite.bak`, i successivi hanno un nome con timestamp (`calcio.sqlite.<data>.bak`).
>
> `npm test` **non** tocca il database: l'allineamento non è più agganciato ai test.

---

## ⚙️ 5. Gestione dei Servizi in Background

Sul Raspberry Pi sono attivi due servizi che ripartono automaticamente all'avvio:

### 1. Dashboard Web Locale (PM2)
La dashboard web locale è raggiungibile da qualsiasi dispositivo connesso al Wi-Fi:
👉 **`http://calcio-pi:3000`** *(oppure `http://192.168.1.151:3000`)*

Comandi utili per PM2:
```bash
# Visualizza lo stato del server (CPU, RAM, Uptime)
pm2 status

# Visualizza i log in tempo reale del server
pm2 logs calcio-scraper

# Riavvia il server web
pm2 restart calcio-scraper

# Ferma o riavvia
pm2 stop calcio-scraper
pm2 start calcio-scraper
```

### 2. GitHub Actions Self-Hosted Runner
È il demone che ascolta GitHub e fa partire lo scraping quando premi *"Aggiorna dal Web"* sul sito (autorizzato via token nel browser) o durante il cron settimanale:

```bash
# Controlla lo stato del runner
cd ~/actions-runner && sudo ./svc.sh status

# Riavvia il runner se necessario
cd ~/actions-runner && sudo ./svc.sh restart

# Ferma o avvia il servizio
cd ~/actions-runner && sudo ./svc.sh stop
cd ~/actions-runner && sudo ./svc.sh start
```

---

## 📈 6. Benchmark & Telemetria Risorse (Test Reale su Raspberry Pi 3)

I seguenti dati sono stati misurati empiricamente in tempo reale sul Raspberry Pi 3 durante uno scraping intensivo con campionamento delle metriche a 1 Hz:

### A. Modalità Ordinaria (Scraping Completo di tutte le 94 giornate in HTTP puro)
- ⏱ **Tempo totale esecuzione:** **~15–18 secondi**
- 🧠 **Carico CPU:** **Media 18.2%** | **Picco 49%** (solo 2 core Cortex-A53 attivi su 4)
- 💾 **Memoria RAM occupata:** **Picco 428 MB** su 905 MB totali (**476 MB liberi**, oltre il 50% di margine)
- 💽 **Utilizzo Swap su MicroSD:** **0 MB** (zero usura del disco e zero rallentamenti)
- 🌡 **Temperatura SoC:** **Media 50.5°C** | **Picco 52.1°C** (nessun rischio di throttling, soglia a 80°C)

### B. Modalità Stress Estremo (Scraping ravvicinati con fallback browser Chromium)
Se per via di richieste ravvicinate scatta la challenge WAF e viene avviato Chromium in modalità headless:
- 🧠 **Carico CPU:** Picco ~65%
- 💾 **Memoria RAM occupata:** Picco massimo di **553 MB** (**351 MB rimasti liberi**)
- 💽 **Utilizzo Swap:** 157 MB (su 904 MB di swap disponibili)
- 🌡 **Temperatura SoC:** Picco di **59.6°C** (ben 25°C sotto la soglia di allarme)
- 🧹 **Rilascio memoria:** Terminato il bootstrap del WAF, Chromium viene arrestato immediatamente e la RAM torna a **262 MB occupati**.

---

## 🛠️ 7. Domande Frequenti e Risoluzione Problemi

### Se va via la corrente o riavvio il Raspberry?
Il Raspberry Pi riparte automaticamente:
- Il servizio **PM2** riaccende la dashboard web.
- Il servizio **actions-runner** si ricollega a GitHub in pochi secondi.
Non devi fare nulla!

### Come riavviare il Raspberry Pi via SSH?
```bash
sudo reboot
```

### Come spegnere in sicurezza il Raspberry Pi?
```bash
sudo shutdown -h now
```

### Se aggiorno il codice del progetto su GitHub dal Mac?
Per allineare anche la copia locale sul Raspberry:
```bash
cd ~/calcio-toscana-scraper
git pull
pm2 restart calcio-scraper
```
*(Nota: il runner GitHub Actions scarica comunque sempre l'ultimo commit all'inizio di ogni esecuzione).*
