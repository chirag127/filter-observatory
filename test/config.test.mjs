import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeState, loadConfig, resolveProvider, acquireProcessLock } from '../src/config.mjs';
import { prepareReport } from '../src/reports.mjs';

function state(t) {
  const dir = mkdtempSync(join(tmpdir(), 'observatory-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('initialization is repeatable and preserves the connection token and operator configuration', t => {
  const dir = state(t);
  initializeState(dir);
  const token = readFileSync(join(dir, 'worker.token'), 'utf8');
  assert.match(token.trim(), /^[A-Za-z0-9_-]{43}$/);
  const config = loadConfig(dir);
  assert.equal(config.provider.enabled, false);
  assert.equal(config.publication.enabled, false);
  config.browser.instance = 'selected-browser';
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  initializeState(dir);
  assert.equal(readFileSync(join(dir, 'worker.token'), 'utf8'), token);
  assert.equal(loadConfig(dir).browser.instance, 'selected-browser');
});

test('configuration rejects credential-bearing endpoints, public plaintext APIs and unbounded budgets', t => {
  const dir = state(t);
  initializeState(dir);
  const base = loadConfig(dir);
  for (const mutate of [
    c => { c.provider.baseUrl = 'https://user:password@example.org/v1'; },
    c => { c.provider.baseUrl = 'http://example.org/v1'; },
    c => { c.provider.timeoutMs = 0; },
    c => { c.publication.minIntervalMs = 0; },
    c => { c.provider.apiKey = 'do-not-store-inline'; },
    c => { c.provider.enabled = 'true'; },
  ]) {
    const input = structuredClone(base);
    mutate(input);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(input));
    assert.throws(() => loadConfig(dir), { code: 'invalid_config' });
  }
});

test('provider resolution uses only the named environment key without changing saved configuration', t => {
  const dir = state(t);
  initializeState(dir);
  const config = loadConfig(dir);
  const provider = resolveProvider(config, { PROXY_API_KEY: 'fixture-secret', UNRELATED: 'private' });
  assert.equal(provider.apiKey, 'fixture-secret');
  assert.equal(provider.model, 'gpt-4.1');
  assert.equal(JSON.stringify(config).includes('fixture-secret'), false);
  assert.equal('UNRELATED' in provider, false);
});

test('process lock excludes a second operator until released and then permits recovery', async t => {
  const dir = state(t);
  initializeState(dir);
  const first = await acquireProcessLock(dir);
  t.after(() => first.release());
  await assert.rejects(acquireProcessLock(dir), { code: 'worker_busy' });
  await first.release();
  const replacement = await acquireProcessLock(dir);
  await replacement.release();
});

const threadSnapshot = (overrides = {}) => ({
  bodyHash: 'a'.repeat(64), verifiedAt: '2026-11-21T00:00:00Z', requirements: [], ...overrides,
});
const uassetsCatalog = [{ id: 'ubo', name: 'uBlock filters', owner: 'uBlockOrigin/uAssets', categories: ['ads'] }];

function threadFinding(url, lite = false) {
  const name = lite ? 'uBlock Origin Lite' : 'uBlock Origin';
  return {
    id: 'thread-finding', captureId: 'thread-capture', url, category: 'missed-ads',
    observation: 'An advertising banner covers the article.', expectedBehavior: 'The enabled advertising list hides the banner.',
    reproduction: ['Open the affected page.'], sensitivity: 'ordinary', listIds: ['ubo'], evidenceIds: ['screen-one'],
    images: [{ id: 'screen-one', url: 'https://evidence.example.com/screen.png', verifiedPublic: true, sanitized: true, sensitivity: 'ordinary' }],
    context: {
      sensitivity: 'ordinary', privacyChecked: true, pageState: 'usable',
      product: { name, version: '1.0', manifestVersion: lite ? 3 : 2, filteringMode: 'optimal' },
      browser: { name: 'Chrome', version: '158' }, os: { name: 'Windows', version: '11' },
      blockers: [{ id: 'ubo', name, version: '1.0', enabled: true }], lists: [{ id: 'ubo', enabled: true }],
      prerequisites: { filtersCurrent: true, browserCurrent: true, isolated: true, defaultsTested: true,
        customRulesExcluded: true, interferenceExcluded: true, developerModeDisabled: true },
      troubleshooting: 'Synthetic configuration from the support pane.', policy: {},
    },
  };
}

function savedPublication(directory, config) {
  writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
  return loadConfig(directory).publication;
}

test('saved special-thread snapshots reach reporting for all six supported routes', t => {
  const dir = state(t);
  initializeState(dir);
  const config = loadConfig(dir);
  const cases = [
    ['youtube-ubo', 'https://www.youtube.com/watch?v=fixture', false, 30157],
    ['youtube-lite', 'https://youtu.be/fixture', true, 30158],
    ['facebook', 'https://www.facebook.com/fixture', false, 3367],
    ['twitch', 'https://www.twitch.tv/fixture', false, 5184],
    ['spotify', 'https://open.spotify.com/fixture', false, 22198],
    ['shortener', 'https://links.example.com/fixture', false, 27472],
  ];
  config.publication.specialThreads = Object.fromEntries(cases.map(([key]) => [key,
    threadSnapshot(key === 'shortener' ? { nodeId: 'D_verified' } : {}),
  ]));
  const publication = savedPublication(dir, config);
  assert.equal(publication.enabled, false);
  for (const [key, url, lite, number] of cases) {
    const finding = threadFinding(url, lite);
    if (key === 'shortener') finding.context.policy.siteKind = 'shortener';
    const report = prepareReport(finding, { catalog: uassetsCatalog, config: publication });
    assert.equal(report.state, 'ready', `${key}: ${report.reasons.join(', ')}`);
    assert.deepEqual(report.destination, { kind: key === 'shortener' ? 'discussion-comment' : 'issue-comment',
      repo: 'uBlockOrigin/uAssets', number, ...(key === 'shortener' ? { nodeId: 'D_verified' } : {}) });
    assert.deepEqual(report.threadPolicy, { key, bodyHash: 'a'.repeat(64), verifiedAt: '2026-11-21T00:00:00Z' });
  }
  config.publication.specialThreads.facebook.number = 4000;
  const report = prepareReport(threadFinding('https://facebook.com/fixture'), { catalog: uassetsCatalog, config: savedPublication(dir, config) });
  assert.equal(report.destination.number, 4000);
});

test('loaded thread requirements compare measured context and keep absent facts unknown', t => {
  const dir = state(t);
  initializeState(dir);
  const config = loadConfig(dir);
  config.publication.specialThreads = { 'youtube-ubo': threadSnapshot({ requirements: [
    'filtersCurrent', { path: 'policy.paywall', equals: false },
    { path: 'product.manifestVersion', equals: 2 }, { path: 'pageState', equals: 'usable' },
  ] }) };
  const publication = savedPublication(dir, config);
  const finding = threadFinding('https://youtube.com/watch?v=fixture');
  finding.context.policy.paywall = false;
  assert.equal(prepareReport(finding, { catalog: uassetsCatalog, config: publication }).state, 'ready');
  delete finding.context.prerequisites.filtersCurrent;
  delete finding.context.policy.paywall;
  const report = prepareReport(finding, { catalog: uassetsCatalog, config: publication });
  assert.equal(report.state, 'deferred');
  assert.ok(report.reasons.includes('thread-prerequisite:prerequisites.filtersCurrent'));
  assert.ok(report.reasons.includes('thread-prerequisite:policy.paywall'));
  config.publication.specialThreads['youtube-ubo'].requirements = [{ path: 'policy.paywall', equals: null }];
  assert.ok(prepareReport(finding, { catalog: uassetsCatalog, config: savedPublication(dir, config) })
    .reasons.includes('thread-prerequisite:policy.paywall'));
});

test('loaded optional expiry, discussion identity and screenshot requests retain reporting dispositions', t => {
  const dir = state(t);
  initializeState(dir);
  const config = loadConfig(dir);
  const snapshot = threadSnapshot({ nodeId: 'D_verified' });
  config.publication.specialThreads = { shortener: snapshot };
  const finding = threadFinding('https://links.example.com/fixture');
  finding.context.policy.siteKind = 'shortener';
  finding.images = []; finding.evidenceIds = [];
  const prepare = () => prepareReport(finding, { catalog: uassetsCatalog, config: savedPublication(dir, config) });
  assert.equal(prepare().state, 'ready');
  snapshot.screenshotsRequested = true;
  assert.ok(prepare().reasons.includes('screenshot-evidence-required'));
  snapshot.screenshotsRequested = false;
  snapshot.expiresAt = '2000-01-01T00:00:00Z';
  assert.ok(prepare().reasons.includes('thread-policy-expired'));
  delete snapshot.expiresAt;
  delete snapshot.nodeId;
  assert.ok(prepare().reasons.includes('discussion-node-id-missing'));
});

test('special-thread configuration rejects unsupported names, malformed snapshots and unusable requirements', t => {
  const dir = state(t);
  initializeState(dir);
  const base = loadConfig(dir);
  const invalidSnapshots = [
    null, [], {}, threadSnapshot({ bodyHash: 'A'.repeat(64) }), threadSnapshot({ bodyHash: 'abc' }),
    threadSnapshot({ bodyHash: undefined }), threadSnapshot({ verifiedAt: undefined }), threadSnapshot({ requirements: undefined }),
    threadSnapshot({ verifiedAt: 123 }), threadSnapshot({ verifiedAt: 'not-a-date' }),
    threadSnapshot({ expiresAt: false }), threadSnapshot({ expiresAt: 'not-a-date' }),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '30157'].map(number => threadSnapshot({ number })),
    threadSnapshot({ nodeId: 'ignored-on-issue-routes' }), threadSnapshot({ screenshotsRequested: true }),
    threadSnapshot({ body: 'Unsupported full post' }), threadSnapshot({ requirements: 'filtersCurrent' }),
    ...[true, null, '', '__proto__.enabled', 'constructor', 'x'.repeat(108), {},
      { path: 'prerequisites.filtersCurrent' }, { equals: true }, { path: 'policy.paywall', equals: {} },
      { path: 'policy.paywall', equals: [] }, { path: 'policy.__proto__.enabled', equals: true },
      { path: 'constructor.name', equals: 'Object' }, { path: 'policy.prototype.enabled', equals: true },
      { path: 'policy[paywall]', equals: false }, { path: 'x'.repeat(122), equals: true },
      { path: 'policy.paywall', equals: false, optional: true },
    ].map(requirement => threadSnapshot({ requirements: [requirement] })),
  ];
  for (const [index, snapshot] of invalidSnapshots.entries()) {
    const config = structuredClone(base);
    config.publication.specialThreads = { 'youtube-ubo': snapshot };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    assert.throws(() => loadConfig(dir), { code: 'invalid_config' }, `snapshot ${index}`);
  }
  for (const specialThreads of [null, [], { youtube: threadSnapshot() },
    { shortener: threadSnapshot({ nodeId: 'invalid node' }) }, { shortener: threadSnapshot({ nodeId: 'D'.repeat(257) }) },
    { shortener: threadSnapshot({ screenshotsRequested: 'true' }) },
  ]) {
    const config = structuredClone(base);
    config.publication.specialThreads = specialThreads;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    assert.throws(() => loadConfig(dir), { code: 'invalid_config' });
  }
  base.publication.specialThreads = {};
  assert.equal(savedPublication(dir, base).enabled, false);
});
