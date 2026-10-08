/**
 * Avvio del workflow GitHub Actions che pubblica i dati aggiornati nel repository.
 *
 * Perché non pushare direttamente da Render: il workflow è l'unico scrittore del
 * repository e conosce le regole di pubblicazione (confronto dei soli dati
 * sportivi, rigenerazione degli export, asset di GitHub Pages). Render si limita
 * a chiedere al workflow di partire dopo un aggiornamento manuale riuscito.
 *
 * Tutto è opzionale: se le variabili non sono configurate il dispatcher è null e
 * il server si comporta esattamente come prima (sviluppo locale incluso).
 *
 * Variabili d'ambiente:
 *  - GITHUB_DISPATCH_TOKEN : PAT con scope "actions: write" (o "workflow")
 *  - GITHUB_REPOSITORY     : "owner/repo" (in alternativa si usa RENDER_GIT_REPO,
 *                            che Render imposta da solo)
 *  - GITHUB_BRANCH         : branch su cui far girare il workflow (default: main)
 *  - GITHUB_WORKFLOW_FILE  : file del workflow (default: update.yml)
 */
const DEFAULT_BRANCH = 'main';
const DEFAULT_WORKFLOW_FILE = 'update.yml';
const GITHUB_API = 'https://api.github.com';

/**
 * Normalizza un riferimento di repository in "owner/repo".
 * Accetta "owner/repo", "https://github.com/owner/repo" e la forma con ".git".
 */
function normalizeRepo(value) {
  if (!value) return '';
  const raw = String(value).trim();

  const fromUrl = raw.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (fromUrl) return `${fromUrl[1]}/${fromUrl[2]}`;

  const clean = raw.replace(/\.git$/, '').replace(/\/$/, '');
  return /^[^/\s]+\/[^/\s]+$/.test(clean) ? clean : '';
}

/**
 * Legge token e repository dall'ambiente senza validarli.
 *
 * Nota sui nomi: Render espone il repository come `RENDER_GIT_REPO_SLUG`
 * (formato `utente/repo`, vedi https://render.com/docs/environment-variables).
 * `RENDER_GIT_REPO` non è documentato ma resta come ripiego.
 */
function readCredentials(env = process.env) {
  const token = env.GITHUB_DISPATCH_TOKEN || env.GITHUB_TOKEN || '';
  const repo = normalizeRepo(env.GITHUB_REPOSITORY)
    || normalizeRepo(env.RENDER_GIT_REPO_SLUG)
    || normalizeRepo(env.RENDER_GIT_REPO)
    || '';
  return { token, repo };
}

/** Nome della variabile da cui arriva il token (mai il valore). */
function tokenSource(env = process.env) {
  if (env.GITHUB_DISPATCH_TOKEN) return 'GITHUB_DISPATCH_TOKEN';
  if (env.GITHUB_TOKEN) return 'GITHUB_TOKEN';
  return null;
}

/** Nome della variabile da cui è stato ricavato il repository. */
function repoSource(env = process.env) {
  if (normalizeRepo(env.GITHUB_REPOSITORY)) return 'GITHUB_REPOSITORY';
  if (normalizeRepo(env.RENDER_GIT_REPO_SLUG)) return 'RENDER_GIT_REPO_SLUG';
  if (normalizeRepo(env.RENDER_GIT_REPO)) return 'RENDER_GIT_REPO';
  return null;
}

/**
 * Configurazione del dispatcher, oppure null se manca token o repository.
 * @returns {{token:string, tokenFrom:string, repo:string, branch:string, workflowFile:string}|null}
 */
function resolveConfig(env = process.env) {
  const { token, repo } = readCredentials(env);
  if (!token || !repo) return null;

  return {
    token,
    tokenFrom: tokenSource(env),
    repo,
    branch: env.GITHUB_BRANCH || DEFAULT_BRANCH,
    workflowFile: env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE
  };
}

/**
 * Stato della configurazione per /api/diagnostics: dice se la pubblicazione
 * automatica è attiva e, se non lo è, QUALE dei due requisiti manca. Il token
 * non viene mai esposto, solo il nome della variabile che lo contiene.
 */
function describeConfig(env = process.env) {
  const { token, repo } = readCredentials(env);

  return {
    publishConfigured: !!(token && repo),
    tokenFound: !!token,
    tokenFrom: tokenSource(env),
    repoFound: !!repo,
    repo: repo || null,
    repoFrom: repoSource(env),
    branch: env.GITHUB_BRANCH || DEFAULT_BRANCH,
    workflowFile: env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE
  };
}

/**
 * Chiede a GitHub di avviare il workflow (workflow_dispatch).
 *
 * Con `inputs.use_cache` il workflow riusa i dati già scrapati da questa
 * istanza invece di riscaricarli, così un refresh non costa due volte.
 *
 * @throws {Error} se GitHub risponde con uno status diverso da 204.
 */
async function dispatchWorkflow(config, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('dispatchWorkflow richiede fetch (Node 18+ oppure l\'opzione `fetch`)');
  }

  const url = `${GITHUB_API}/repos/${config.repo}/actions/workflows/${config.workflowFile}/dispatches`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'calcio-toscana-scraper'
    },
    body: JSON.stringify({
      ref: config.branch,
      inputs: { use_cache: 'true' }
    })
  });

  // La workflow_dispatch API risponde 204 No Content quando accetta la richiesta
  if (res.status !== 204) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub ha risposto ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  return { dispatched: true, repo: config.repo, workflow: config.workflowFile, branch: config.branch };
}

/**
 * Dispatcher pronto all'uso, oppure null se la configurazione è assente.
 * @param {object} [env] variabili d'ambiente (iniettabili nei test)
 * @param {object} [options] opzioni passate a dispatchWorkflow (`fetch`)
 */
function createWorkflowDispatcher(env = process.env, options = {}) {
  const config = resolveConfig(env);
  if (!config) return null;
  return () => dispatchWorkflow(config, options);
}

module.exports = {
  normalizeRepo,
  readCredentials,
  tokenSource,
  repoSource,
  resolveConfig,
  describeConfig,
  dispatchWorkflow,
  createWorkflowDispatcher,
  DEFAULT_BRANCH,
  DEFAULT_WORKFLOW_FILE
};
