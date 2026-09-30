FROM node:22-slim

# Installa Chromium e dipendenze di sistema necessarie per Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Copia i file di dipendenze (stessa versione Node usata in CI: 22)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia il codice sorgente e i dati iniziali
COPY . .

# Assicura permessi e cartelle dati
RUN mkdir -p data/cache data/exports

EXPOSE 3000

CMD ["node", "bin/cli.js", "serve"]
