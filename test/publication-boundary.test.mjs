import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from '../src/worker.mjs';
import { createGitHubPublisher, prepareReport } from '../src/reports.mjs';
import { imagePublicationKey, sanitizedImage } from '../src/annotations.mjs';
import { stableJson } from '../src/capture.mjs';
import { openStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

const AG = 'AdguardTeam/AdguardFilters';
const UA = 'uBlockOrigin/uAssets';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const metadata = repo => ({ full_name: repo, private: false, archived: false, disabled: false, has_issues: true,
  has_discussions: true, default_branch: 'main', permissions: { admin: true, push: true } });
const issue = (repo, number, body = 'Earlier report for https://example.com/article-0') => ({ id: number * 100, number,
  html_url: `https://github.com/${repo}/issues/${number}`, title: 'example.com', body, comments: 0, state: 'closed', locked: false, labels: [] });
const comment = (repo, number, id, body) => ({ id, body, html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${id}` });
const discussion = () => ({ id: 'D_boundary', number: 27472, url: `https://github.com/${UA}/discussions/27472`,
  repository: { nameWithOwner: UA }, title: 'Shortener thread', body: 'Current first post', locked: false, isAnswered: false,
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });

async function fixture(t, { kind = 'issue', count = 1, hosted = true, fetchImpl, transport } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-publication-boundary-'));
  let store = openStore(directory);
  let worker;
  t.after(async () => { await worker?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const repo = kind === 'issue' ? AG : UA;
  const ubo = repo === UA;
  const list = { id: ubo ? 'ubo:filters' : 'adguard:filter:2', name: ubo ? 'uBlock filters' : 'AdGuard Base filter', enabled: true };
  const record = { ...list, owner: repo, categories: ['ads'] };
  const product = { id: ubo ? 'ubo' : 'adguard', name: ubo ? 'uBlock Origin' : 'AdGuard AdBlocker', version: ubo ? '1.67.0' : '5.5.4.76' };
  const notes = { source: 'Synthetic boundary regression', observedAt: '2026-11-21T16:01:00.000Z', context: {
    privacyChecked: true, sensitivity: 'ordinary', os: { name: 'Windows', version: '11' }, product: { ...product, manifestVersion: ubo ? 2 : 3 },
    prerequisites: { filtersCurrent: true, productCurrent: true, browserCurrent: true,
      ...(ubo ? { isolated: true, defaultsTested: true, customRulesExcluded: true, interferenceExcluded: true } : {}) },
    ...(ubo ? { troubleshooting: 'Actual configuration represented by a synthetic fixture.' } : {}),
    ...(kind === 'discussion-comment' ? { policy: { siteKind: 'shortener' } } : {}),
  }, images: [{ id: 'viewport', sensitivity: 'ordinary', sanitized: true, redactions: [] }] };
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  config.publication.enabled = false;
  config.publication.evidenceRepository = 'operator/evidence';
  config.publication.minIntervalMs = 1000;
  if (kind === 'discussion-comment') config.publication.specialThreads = { shortener: {
    number: 27472, nodeId: 'D_boundary', bodyHash: sha('Current first post'), verifiedAt: notes.observedAt, requirements: [],
  } };
  const observed = { category: 'missed-ads', observation: 'A paid banner remains beside the article.', expectedBehavior: 'Hide the paid advertisement.',
    reproduction: ['Open the recorded article.'], evidenceIds: ['viewport'], sensitivity: 'ordinary', confidence: 0.95, suggestedListIds: [list.id] };
  const captures = [];
  store.saveCatalog({ source: 'manual', records: [record], counts: {} });
  for (let index = 0; index < count; index++) {
    const capture = captureFixture({ id: `boundary_capture_${index}`, url: `https://example.com/article-${index}`,
      context: { sensitivity: 'ordinary', pageState: 'usable', lists: [list], blockers: [{ ...product, enabled: true }] } });
    store.ingest(capture);
    store.annotateCapture(capture.id, structuredClone(notes));
    if (hosted) store.setRecord(imagePublicationKey(capture, capture.images[0], store.annotations(capture.id), config.publication.evidenceRepository), {
      state: 'uploaded', image: { id: 'viewport', url: 'https://raw.githubusercontent.com/operator/evidence/main/boundary.png',
        sanitized: true, verifiedPublic: true, sensitivity: 'ordinary' },
    });
    captures.push(capture);
  }
  const requests = [];
  const injectedFetch = async (url, options) => {
    const request = { url: new URL(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    assert.equal(request.url.origin, 'https://api.github.com');
    if (fetchImpl) return fetchImpl(request, store);
    throw new Error('Unexpected injected request');
  };
  const makeWorker = () => createWorker({ store, config, env: {},
    fetchImpl: async () => { throw new Error('Network is not available to this fixture'); }, prepare: prepareReport,
    analyze: async () => ({ state: 'accepted', findings: [observed], provenance: { fixture: true } }),
    publisher: transport ?? createGitHubPublisher({ token: 'boundary-fixture-token', fetchImpl: injectedFetch }) });
  worker = makeWorker();
  await worker.processCaptures();
  config.provider.enabled = false;
  config.publication.enabled = true;
  return { config, notes, record, captures, requests, get store() { return store; }, get worker() { return worker; },
    async restart() { await worker.stop(); store.close(); store = openStore(directory); store.recoverInterrupted(); worker = makeWorker(); } };
}

for (const kind of ['issue', 'issue-comment', 'discussion-comment']) {
  test(`mutation boundary: current policy is checked after ${kind} preflight`, { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers();
    const proceed = Promise.withResolvers();
    t.after(() => proceed.resolve());
    const repo = kind === 'issue' ? AG : UA;
    const f = await fixture(t, { kind, fetchImpl: async request => {
      const path = request.url.pathname;
      if (path === `/repos/${repo}`) return json(metadata(repo));
      const lastRead = (kind === 'issue' && path === '/search/issues') ||
        (kind === 'issue-comment' && request.method === 'GET' && path.endsWith('/comments')) ||
        (kind === 'discussion-comment' && request.body?.query?.startsWith('query'));
      if (lastRead) { entered.resolve(); await proceed.promise; }
      if (path === '/search/issues') return json({ total_count: kind === 'issue' ? 0 : 1, incomplete_results: false, items: kind === 'issue' ? [] : [issue(UA, 24)] });
      if (request.body?.query?.startsWith('query')) return json({ data: { repository: { discussion: discussion() } } });
      if (request.method === 'GET') return json(path.endsWith('/comments') ? [] : issue(UA, 24));
      if (path.endsWith('/comments')) return json(comment(UA, 24, 701, request.body.body), 201);
      if (path === '/graphql') return json({ data: { addDiscussionComment: { comment: { id: 'DC_701', databaseId: 701,
        url: `https://github.com/${UA}/discussions/27472#discussioncomment-701`, body: request.body.variables.input.body,
        discussion: { id: 'D_boundary', number: 27472 } } } } });
      return json(issue(repo, 41, request.body.body), 201);
    } });
    const pending = f.worker.processPublications();
    await entered.promise;
    f.store.saveCatalog({ source: 'manual', records: [{ ...f.record, categories: ['privacy'] }], counts: {} });
    proceed.resolve();
    await pending;
    const mutations = f.requests.filter(request => request.method === 'PUT' || (request.method === 'POST' && !request.body?.query?.startsWith('query')));
    assert.equal(mutations.length, 0);
    assert.equal(f.store.reports()[0].state, 'deferred');
    assert.equal(f.store.reports()[0].attempt, undefined);
  });
}

test('mutation boundary: an upload cannot outlive catalog eligibility while its metadata read is pending', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  t.after(() => proceed.resolve());
  const f = await fixture(t, { hosted: false, fetchImpl: async request => {
    if (request.url.pathname === '/repos/operator/evidence') { entered.resolve(); await proceed.promise; return json(metadata('operator/evidence')); }
    if (request.method === 'GET') return json({}, 404);
    const bytes = Buffer.from(request.body.content, 'base64');
    return json({ content: { type: 'file', path: request.url.pathname.split('/contents/')[1],
      sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }, commit: { sha: 'a'.repeat(40) } }, 201);
  } });
  const pending = f.worker.refreshReports();
  await entered.promise;
  f.store.saveCatalog({ source: 'manual', records: [{ ...f.record, categories: ['privacy'] }], counts: {} });
  proceed.resolve();
  await pending;
  assert.equal(f.requests.filter(request => request.method === 'PUT').length, 0);
  assert.equal(f.store.reports()[0].state, 'deferred');
});

test('mutation boundary: a route suppressing screenshots never uploads analysis-only citations', async t => {
  const uploads = [];
  const f = await fixture(t, { kind: 'discussion-comment', hosted: false, transport: {
    async uploadEvidence(image) { uploads.push(image.id); return { state: 'failed', reason: 'unexpected-upload' }; },
  } });
  assert.equal(f.store.reports()[0].state, 'ready');
  assert.deepEqual(f.store.reports()[0].evidence, []);
  await f.worker.refreshReports();
  assert.deepEqual(uploads, []);
  assert.deepEqual(f.store.reports()[0].uploadEvidenceIds, []);
});

const legacyKey = (capture, image, annotations, repository) => `image-publication:${capture.id}:${image.id}:${sha(stableJson({
  data: image.dataBase64, note: annotations.images.find(note => note.id === image.id), privacyChecked: annotations.context.privacyChecked === true, repository,
}))}`;

for (const withReceipt of [false, true]) {
  test(`upload identity: legacy uncertainty survives an equivalent annotation edit after restart (receipt=${withReceipt})`, async t => {
    const f = await fixture(t, { hosted: false, fetchImpl: async request => request.url.pathname === '/repos/operator/evidence'
      ? json(metadata('operator/evidence')) : json({}, 404) });
    const capture = f.captures[0];
    const image = capture.images[0];
    const oldAnnotations = f.store.annotations(capture.id);
    const oldKey = legacyKey(capture, image, oldAnnotations, f.config.publication.evidenceRepository);
    const outgoing = sanitizedImage(image, oldAnnotations.images[0]);
    const digest = sha(Buffer.from(outgoing.dataBase64, 'base64'));
    const previous = { state: 'uncertain', reason: 'response-lost', captureId: capture.id, imageId: image.id,
      ...(withReceipt ? { receipt: { repo: 'operator/evidence', operation: 'evidence-upload', branch: 'main',
        path: `screenshots/${digest}.png`, contentHash: digest, sourceSha256: digest } } : {}) };
    f.store.setRecord(oldKey, previous);
    const changed = structuredClone(f.notes);
    delete changed.images[0].redactions;
    f.store.annotateCapture(capture.id, changed);
    await f.restart();
    await f.worker.refreshReports();
    assert.equal(f.requests.filter(request => request.method === 'PUT').length, 0);
    assert.ok(f.requests.some(request => request.method === 'GET' && request.url.pathname.endsWith(`/screenshots/${digest}.png`)));
    const key = imagePublicationKey(capture, image, f.store.annotations(capture.id), f.config.publication.evidenceRepository);
    assert.equal(f.store.getRecord(key).state, 'uncertain');
    assert.deepEqual(f.store.getRecord(oldKey), previous);
    await f.restart();
    await f.worker.refreshReports();
    assert.ok(f.requests.every(request => request.method === 'GET'));
  });
}

test('upload identity: equivalent outgoing pixels share unresolved debt across captures and restart', async t => {
  const modes = [];
  const f = await fixture(t, { hosted: false, count: 2, transport: { async uploadEvidence(_image, _config, options) {
    modes.push(options.reconcileOnly);
    return { state: 'uncertain', reason: 'fixture-response-lost' };
  } } });
  await f.worker.refreshReports({ limit: 1 });
  await f.restart();
  await f.worker.refreshReports({ limit: 1 });
  assert.deepEqual(modes, [false, true]);
});

test('reconciliation boundary: the durable cursor advances past persistent uncertainty across restart', async t => {
  const visited = [];
  const f = await fixture(t, { count: 2, transport: { async reconcile(report) {
    visited.push(report.id); return { state: 'uncertain', reason: 'not-found' };
  } } });
  const reports = f.store.reports();
  for (const report of reports) f.store.finishReport(report.id, { state: 'uncertain', reason: 'response-lost' });
  f.config.scheduler.maxPublicationsPerCycle = 1;
  await f.worker.reconcileReports();
  await f.restart();
  await f.worker.reconcileReports();
  assert.deepEqual(visited, reports.map(report => report.id));
});

test('reconciliation boundary: saved report and last-read retry deadlines do not consume the fair batch', async t => {
  const visited = [];
  const f = await fixture(t, { count: 3, transport: { async reconcile(report) {
    visited.push(report.id); return { state: 'uncertain', reason: 'not-found' };
  } } });
  const reports = f.store.reports();
  const retryAt = new Date(Date.now() + 120000).toISOString();
  for (const [index, report] of reports.entries()) f.store.finishReport(report.id, { state: 'uncertain', reason: 'response-lost', ...(index === 0 ? { retryAt } : {}) });
  f.store.setRecord(`reconcile:${reports[1].id}`, { at: new Date().toISOString(), result: { state: 'uncertain', reason: 'rate-limited', retryAt } });
  f.config.scheduler.maxPublicationsPerCycle = 1;
  await f.restart();
  await f.worker.reconcileReports();
  assert.deepEqual(visited, [reports[2].id]);
});

test('reconciliation boundary: a persisted resolved append target bypasses a stale empty search index', async t => {
  let persisted;
  const f = await fixture(t, { kind: 'issue-comment', fetchImpl: async request => {
    const path = request.url.pathname;
    if (path === `/repos/${UA}`) return json(metadata(UA));
    if (path === '/search/issues') return json({ total_count: persisted ? 0 : 1, incomplete_results: false, items: persisted ? [] : [issue(UA, 24)] });
    if (request.method === 'GET') return json(path.endsWith('/comments') ? persisted ? [persisted] : [] : issue(UA, 24));
    persisted = comment(UA, 24, 701, request.body.body);
    throw new Error('Synthetic lost append response');
  } });
  await f.worker.processPublications();
  const lost = f.store.reports()[0];
  assert.equal(lost.state, 'uncertain');
  assert.equal(lost.attempt.number, 24);
  await f.restart();
  const before = f.requests.length;
  await f.worker.reconcileReports();
  assert.equal(f.store.report(lost.id).state, 'appended');
  assert.equal(f.store.report(lost.id).receipt.commentId, 701);
  assert.deepEqual(f.requests.slice(before).map(request => [request.method, request.url.pathname]), [
    ['GET', `/repos/${UA}/issues/24`], ['GET', `/repos/${UA}/issues/24/comments`],
  ]);
});

async function branchRecoveryFixture(t) {
  const remote = { defaultBranch: 'main', visible: true, puts: 0, assets: new Map() };
  const f = await fixture(t, { hosted: false, fetchImpl: async request => {
    const path = request.url.pathname;
    if (path === '/repos/operator/evidence') return json({ ...metadata('operator/evidence'), default_branch: remote.defaultBranch });
    assert.ok(path.startsWith('/repos/operator/evidence/contents/screenshots/'));
    if (request.method === 'GET') {
      const asset = remote.assets.get(`${request.url.searchParams.get('ref')}:${path}`);
      return remote.visible && asset ? json(asset) : json({}, 404);
    }
    assert.equal(request.method, 'PUT');
    const bytes = Buffer.from(request.body.content, 'base64');
    remote.puts++;
    remote.assets.set(`${request.body.branch}:${path}`, { type: 'file', path: path.split('/contents/')[1],
      sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
    throw new Error('Synthetic lost upload response');
  } });
  await f.worker.refreshReports();
  const capture = f.captures[0];
  const key = imagePublicationKey(capture, capture.images[0], f.store.annotations(capture.id), f.config.publication.evidenceRepository);
  const lost = f.store.getRecord(key);
  assert.equal(lost.state, 'uncertain');
  assert.equal(lost.receipt.branch, 'main');
  assert.equal(remote.puts, 1);
  return { f, remote, key, lost };
}

test('upload branch recovery: a lost response pins the resolved branch before a new default is observed', async t => {
  const { f, remote, key, lost } = await branchRecoveryFixture(t);
  remote.defaultBranch = 'replacement';
  await f.restart();
  const before = f.requests.length;
  await f.worker.refreshReports();
  const recovered = f.store.getRecord(key);
  assert.equal(recovered.state, 'existing');
  assert.equal(lost.identity.destination.branch, 'main');
  assert.equal(recovered.identity.destination.branch, 'main');
  assert.equal(recovered.receipt.branch, 'main');
  assert.equal(recovered.receipt.contentHash, lost.receipt.contentHash);
  assert.equal(recovered.receipt.sourceSha256, lost.receipt.sourceSha256);
  assert.ok(recovered.image.url.includes('/operator/evidence/main/screenshots/'));
  assert.deepEqual(f.requests.slice(before).filter(request => request.url.pathname.includes('/contents/'))
    .map(request => [request.method, request.url.searchParams.get('ref')]), [['GET', 'main']]);
  assert.equal(remote.puts, 1);
  assert.equal(f.store.reports()[0].state, 'ready');
});

for (const state of ['sending', 'uncertain']) {
  test(`upload branch recovery: pre-fix ${state} debt uses its saved receipt branch after reopen`, async t => {
    const { f, remote, key, lost } = await branchRecoveryFixture(t);
    const preFix = { ...lost, state, identity: { contentHash: lost.receipt.contentHash, destination: { repo: 'operator/evidence' } } };
    f.store.setRecord(key, preFix);
    remote.defaultBranch = 'replacement';
    await f.restart();
    const before = f.requests.length;
    await f.worker.refreshReports();
    const recovered = f.store.getRecord(key);
    assert.equal(recovered.state, 'existing');
    assert.equal(recovered.identity.destination.branch, 'main');
    assert.equal(recovered.receipt.branch, 'main');
    assert.ok(f.requests.slice(before).every(request => request.method === 'GET'));
    assert.deepEqual(f.requests.slice(before).filter(request => request.url.pathname.includes('/contents/'))
      .map(request => request.url.searchParams.get('ref')), ['main']);
    assert.equal(remote.puts, 1);
  });
}

test('upload branch recovery: missing pinned content preserves the original receipt across repeated restarts', async t => {
  const { f, remote, key, lost } = await branchRecoveryFixture(t);
  remote.visible = false;
  remote.defaultBranch = 'replacement';
  const before = f.requests.length;
  for (let round = 0; round < 2; round++) {
    await f.restart();
    await f.worker.refreshReports();
    const unresolved = f.store.getRecord(key);
    assert.equal(unresolved.state, 'uncertain');
    assert.deepEqual(unresolved.receipt, lost.receipt);
    assert.equal(unresolved.identity.destination.branch, 'main');
  }
  assert.deepEqual(f.requests.slice(before).filter(request => request.url.pathname.includes('/contents/'))
    .map(request => [request.method, request.url.searchParams.get('ref')]), [['GET', 'main'], ['GET', 'main']]);
  assert.equal(remote.puts, 1);
});

test('upload branch recovery: malformed or conflicting saved receipts cannot select a recovery destination', async t => {
  const { f, remote, key, lost } = await branchRecoveryFixture(t);
  for (const change of [{ branch: '../replacement' }, { repo: 'other/evidence' }, { contentHash: 'a'.repeat(64) },
    { path: 'screenshots/unrelated.png' }, { operation: 'issue' }, { branch: 'replacement' }]) {
    const saved = { ...lost, receipt: { ...lost.receipt, ...change },
      identity: { contentHash: lost.receipt.contentHash, destination: { repo: 'operator/evidence', branch: 'main' } } };
    f.store.setRecord(key, saved);
    await f.restart();
    const before = f.requests.length;
    await f.worker.refreshReports();
    const unresolved = f.store.getRecord(key);
    assert.equal(unresolved.state, 'uncertain');
    assert.deepEqual(unresolved.receipt, saved.receipt);
    assert.deepEqual(unresolved.identity, saved.identity);
    assert.equal(f.requests.length, before);
  }
  assert.equal(remote.puts, 1);
});

test('upload branch recovery: a conflicting recovery result cannot overwrite the recorded original destination', async t => {
  let calls = 0;
  let saved;
  const f = await fixture(t, { hosted: false, transport: { async uploadEvidence(image, config, options) {
    calls++;
    assert.equal(options.reconcileOnly, true);
    assert.equal(config.evidenceRepository.branch, 'main');
    return { state: 'existing', image: { id: image.id, sanitized: true, sensitivity: 'ordinary', verifiedPublic: true,
      url: `https://raw.githubusercontent.com/operator/evidence/replacement/${saved.receipt.path}` },
    receipt: { ...saved.receipt, branch: 'replacement' } };
  } } });
  const capture = f.captures[0];
  const outgoing = sanitizedImage(capture.images[0], f.notes.images[0]);
  const contentHash = sha(Buffer.from(outgoing.dataBase64, 'base64'));
  const key = imagePublicationKey(capture, capture.images[0], f.store.annotations(capture.id), f.config.publication.evidenceRepository);
  saved = { state: 'uncertain', identity: { contentHash, destination: { repo: 'operator/evidence', branch: 'main' } },
    receipt: { repo: 'operator/evidence', operation: 'evidence-upload', branch: 'main', contentHash,
      sourceSha256: contentHash, path: `screenshots/${contentHash}.png` } };
  f.store.setRecord(key, saved);
  await f.restart();
  await f.worker.refreshReports();
  const unresolved = f.store.getRecord(key);
  assert.equal(calls, 1);
  assert.equal(unresolved.state, 'uncertain');
  assert.deepEqual(unresolved.receipt, saved.receipt);
  assert.deepEqual(unresolved.identity, saved.identity);
  assert.equal(unresolved.image, undefined);
  assert.equal(f.store.reports()[0].state, 'deferred');
});
