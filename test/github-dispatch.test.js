const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRepo,
  resolveConfig,
  describeConfig,
  dispatchWorkflow,
  createWorkflowDispatcher,
  DEFAULT_BRANCH,
  DEFAULT_WORKFLOW_FILE
} = require('../src/github-dispatch');

const ENV = {
  GITHUB_DISPATCH_TOKEN: 'ghp_segreto',
  GITHUB_REPOSITORY: 'cicciocanestro/calcio-toscana-scraper'
};

const okFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  return new Response(null, { status: 204 });
};

test('normalizeRepo accetta owner/repo, URL GitHub e la forma con .git', () => {
  assert.equal(normalizeRepo('owner/repo'), 'owner/repo');
  assert.equal(normalizeRepo('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(normalizeRepo('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(normalizeRepo('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(normalizeRepo('owner/repo/'), 'owner/repo');
  assert.equal(normalizeRepo(''), '');
  assert.equal(normalizeRepo('non-un-repo'), '');
});

test('resolveConfig è null senza token o senza repository', () => {
  assert.equal(resolveConfig({}), null);
  assert.equal(resolveConfig({ GITHUB_DISPATCH_TOKEN: 'x' }), null);
  assert.equal(resolveConfig({ GITHUB_REPOSITORY: 'a/b' }), null);
});

test('resolveConfig usa RENDER_GIT_REPO come fallback e i valori di default', () => {
  const config = resolveConfig({
    GITHUB_DISPATCH_TOKEN: 'tok',
    RENDER_GIT_REPO: 'https://github.com/a/b.git'
  });

  assert.deepEqual(config, {
    token: 'tok',
    tokenFrom: 'GITHUB_DISPATCH_TOKEN',
    repo: 'a/b',
    branch: DEFAULT_BRANCH,
    workflowFile: DEFAULT_WORKFLOW_FILE
  });
});

test('resolveConfig segnala quando il token arriva da GITHUB_TOKEN', () => {
  const config = resolveConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'a/b' });
  assert.equal(config.tokenFrom, 'GITHUB_TOKEN');
});

test('describeConfig dice se la pubblicazione è attiva senza esporre il token', () => {
  assert.deepEqual(describeConfig(null), {
    publishConfigured: false,
    repo: null,
    branch: null,
    workflowFile: null,
    tokenFrom: null
  });

  const described = describeConfig(resolveConfig(ENV));

  assert.equal(described.publishConfigured, true);
  assert.equal(described.repo, 'cicciocanestro/calcio-toscana-scraper');
  assert.equal(described.tokenFrom, 'GITHUB_DISPATCH_TOKEN');
  assert.equal(
    JSON.stringify(described).includes('ghp_segreto'),
    false,
    'il token non deve mai comparire nella diagnostica'
  );
});

test('resolveConfig accetta branch e file di workflow personalizzati', () => {
  const config = resolveConfig({ ...ENV, GITHUB_BRANCH: 'sviluppo', GITHUB_WORKFLOW_FILE: 'altro.yml' });
  assert.equal(config.branch, 'sviluppo');
  assert.equal(config.workflowFile, 'altro.yml');
});

test('dispatchWorkflow chiama la workflow_dispatch API chiedendo use_cache', async () => {
  const calls = [];
  const result = await dispatchWorkflow(resolveConfig(ENV), { fetch: okFetch(calls) });

  assert.equal(result.dispatched, true);
  assert.equal(result.repo, 'cicciocanestro/calcio-toscana-scraper');
  assert.equal(calls.length, 1);

  const { url, init } = calls[0];
  assert.equal(
    url,
    'https://api.github.com/repos/cicciocanestro/calcio-toscana-scraper/actions/workflows/update.yml/dispatches'
  );
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer ghp_segreto');
  assert.deepEqual(JSON.parse(init.body), {
    ref: 'main',
    inputs: { use_cache: 'true' }
  });
});

test('dispatchWorkflow segnala lo status di errore restituito da GitHub', async () => {
  const notFound = async () => new Response('{"message":"Not Found"}', { status: 404 });

  await assert.rejects(
    () => dispatchWorkflow(resolveConfig(ENV), { fetch: notFound }),
    /GitHub ha risposto 404/
  );
});

test('createWorkflowDispatcher è null se non configurato, altrimenti invia la richiesta', async () => {
  assert.equal(createWorkflowDispatcher({}), null);

  const calls = [];
  const dispatcher = createWorkflowDispatcher(ENV, { fetch: okFetch(calls) });
  assert.equal(typeof dispatcher, 'function');

  const result = await dispatcher();
  assert.equal(result.dispatched, true);
  assert.equal(calls.length, 1);
});
