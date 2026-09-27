const path = require('path');
const fs = require('fs');
const os = require('os');

// Detect Chrome / Chromium executable
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const platform = os.platform();
  const candidates = [];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (platform === 'linux') {
    candidates.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium'
    );
  } else if (platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || `${os.homedir()}\\AppData\\Local`;

    candidates.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  throw new Error(
    'Nessun browser Chrome/Chromium/Brave trovato nel sistema.\n' +
    'Per favore specifica il percorso impostando la variabile di ambiente CHROME_PATH.'
  );
}

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');

// Assicura che le directory esistano
for (const dir of [DATA_DIR, CACHE_DIR, EXPORT_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const LEAGUES = {
  'promozione-c': {
    id: 'promozione-c',
    name: 'Promozione Toscana - Girone C',
    shortName: 'Promozione C',
    category: 'Promozione',
    girone: 'Girone C',
    region: 'Toscana',
    url: 'https://www.tuttocampo.it/Toscana/Promozione/GironeC/Risultati',
    roundID: 'TO.P.C',
    cacheFile: path.join(CACHE_DIR, 'promozione-c.json')
  },
  'seconda-i': {
    id: 'seconda-i',
    name: 'Seconda Categoria Toscana - Girone I',
    shortName: 'Seconda Cat. I',
    category: 'Seconda Categoria',
    girone: 'Girone I',
    region: 'Toscana',
    url: 'https://www.tuttocampo.it/Toscana/SecondaCategoria/GironeI/Risultati',
    roundID: 'TO.2.I',
    cacheFile: path.join(CACHE_DIR, 'seconda-i.json')
  },
  'terza-arezzo': {
    id: 'terza-arezzo',
    name: 'Terza Categoria Arezzo - Girone Unico',
    shortName: 'Terza Cat. Arezzo',
    category: 'Terza Categoria',
    girone: 'Girone Unico',
    region: 'Toscana',
    province: 'Arezzo',
    url: 'https://www.tuttocampo.it/Toscana/TerzaCategoria/GironeAArezzo/Risultati',
    roundID: 'TO.3.A.AR',
    cacheFile: path.join(CACHE_DIR, 'terza-arezzo.json')
  }
};

module.exports = {
  findChrome,
  ROOT_DIR,
  DATA_DIR,
  CACHE_DIR,
  EXPORT_DIR,
  LEAGUES,
  CACHE_TTL_MS: 2 * 60 * 60 * 1000 // 2 ore di cache per default
};
