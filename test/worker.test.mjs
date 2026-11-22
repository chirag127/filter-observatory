import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { createWorker } from '../src/worker.mjs';
import { validateCapture } from '../src/capture.mjs';
import { analyzeEvidence } from '../src/analysis.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-worker-'));
  const store = openStore(directory);
  const config = structuredClone(defaultConfig);
  config.provider.enabled = true;
  config.autoProcess = false;
  config.browser.instance = 'fixture-browser';
  const worker = createWorker({ store, config, env: {}, ...options });
  t.after(async () => { await worker.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, config, worker };
}

const finding = {
  category: 'missed-ads', observation: 'Sponsored banner remains', expectedBehavior: 'Remove the paid advertisement',
  reproduction: ['Open the recorded page'], evidenceIds: ['viewport'], confidence: 0.95,
  sensitivity: 'ordinary', suggestedListIds: ['known', 'invented'],
};
const readyReport = item => ({ id: `report-${item.id}`, fingerprint: `fp-${item.id}`, findingId: item.id,
  state: 'ready', title: 'example.com: missed advertisement', body: 'Recorded evidence', reasons: [],
  destination: { kind: 'issue', repo: 'example/filters' } });

test('one accepted analysis creates durable findings with observed context and only real enabled list IDs', async t => {
  const { store, worker } = fixture(t, {
    analyze: async () => ({ state: 'accepted', findings: [finding], provenance: { model: 'fixture' } }),
    prepare: readyReport,
  });
  store.ingest(captureFixture({ context: { lists: [{ id: 'known', name: 'Known list', enabled: true }] } }));
  await worker.cycle();
  assert.equal(store.captureStatus('capture_fixture_01').state, 'accepted');
  assert.deepEqual(store.findings()[0].listIds, ['known']);
  assert.equal(store.findings()[0].context.browser.version, '158.0.8127.37');
  assert.equal(store.reports()[0].state, 'dry-run');
  assert.equal(JSON.stringify(store.findings()).includes('dataBase64'), false);
  await worker.cycle();
  assert.equal(store.findings().length, 1);
  assert.equal(store.reports().length, 1);
});

test('disabled or restricted inference never turns a queued or abstained capture into a clean-site result', async t => {
  const { store, config, worker } = fixture(t, { analyze: async () => { throw new Error('Must not dispatch this evidence'); } });
  store.ingest(captureFixture({ context: { sensitivity: 'nsfw' } }));
  config.provider.enabled = false;
  assert.equal((await worker.processCaptures()).state, 'disabled');
  assert.equal(store.captureStatus('capture_fixture_01').state, 'queued');
  config.provider.enabled = true;
  await worker.processCaptures();
  assert.equal(store.captureStatus('capture_fixture_01').result.reason, 'evidence_class_not_enabled');
  assert.equal(store.reports().length, 0);
});

test('uncertain creation is reconciled to its original remote receipt and never dispatched a second time', async t => {
  let dispatches = 0;
  const publisher = {
    async publish() { dispatches++; throw new Error('Response lost after send'); },
    async reconcile() { return { state: 'created', receipt: { url: 'https://github.com/example/filters/issues/42', number: 42 } }; },
    async followUp() { return { state: 'closed', verifiedFix: false }; },
  };
  const { store, config, worker } = fixture(t, { publisher, prepare: readyReport });
  config.publication.enabled = true;
  const capture = captureFixture();
  store.ingest(capture); store.claimCapture(capture.id);
  const recorded = { ...finding, id: 'finding-one', captureId: capture.id };
  store.finishCapture(capture.id, { state: 'accepted', findings: [recorded], provenance: {} },
    [{ ...readyReport(recorded), id: 'report-one', captureId: capture.id }]);
  await worker.processPublications();
  assert.equal(store.report('report-one').state, 'uncertain');
  await worker.reconcileReports();
  await worker.processPublications();
  assert.equal(dispatches, 1);
  assert.equal(store.report('report-one').receipt.number, 42);
  await worker.followUp();
  assert.equal(store.getRecord('followup:report-one').result.verifiedFix, false);
});

test('a bounded browser run persists successes and acquisition failures without repeating completed entries', async t => {
  const visited = [];
  const { store, worker } = fixture(t, { browserFactory: async () => ({
    async capture(url) {
      visited.push(url);
      if (url.includes('example.org')) throw Object.assign(new Error('No page'), { code: 'navigation_failed' });
      return captureFixture({ source: 'audit' });
    },
    async close() {},
  }) });
  const run = store.createRun({ entries: [
    { id: 'one', url: 'https://example.com/' }, { id: 'two', url: 'https://example.org/' },
  ] });
  await worker.run(run.id);
  assert.equal(store.run(run.id).counts.completed, 1);
  assert.equal(store.run(run.id).counts.failed, 1);
  assert.equal(store.entries(run.id)[1].result.reason, 'navigation_failed');
  await worker.run(run.id);
  assert.equal(visited.length, 2);
  assert.equal(store.leases().length, 0);
});

test('comparison recovery retains a failed restore and frees the lease only after actual journal cleanup', async t => {
  let restored = false;
  const { store, worker } = fixture(t, {
    browserFactory: async () => ({ async close() {} }),
    recover: async (_adapter, journal) => {
      if (restored) await journal.clear();
      return { state: restored ? 'restored' : 'failed' };
    },
  });
  store.acquireLease('browser:fixture-browser', 'old-worker');
  await store.journal('fixture-browser').write({ phase: 'restoring', original: [{ id: 'adguard', enabled: true }] });
  await worker.recoverBrowserState();
  assert.equal(store.journals().length, 1);
  assert.equal(store.leases().length, 1);
  restored = true;
  await worker.recoverBrowserState();
  assert.equal(store.journals().length, 0);
  assert.equal(store.leases().length, 0);
});

test('analysis receives effective capture-compatible fields without annotation-only prerequisites', async t => {
  let received;
  const { store, worker } = fixture(t, { analyze: async evidence => {
    received = validateCapture(evidence);
    return { state: 'accepted', findings: [], provenance: {} };
  } });
  const capture = captureFixture({ context: { condition: 'installed', pageState: 'unknown',
    prerequisites: { isolated: false } } });
  store.ingest(capture);
  const lists = [{ id: 'known', name: 'Known list', enabled: true }];
  const blockers = [{ id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true }];
  store.annotateCapture(capture.id, { source: 'Synthetic observed settings', observedAt: '2026-11-21T16:01:00.000Z',
    context: { lists, blockers, pageState: 'usable', sensitivity: 'ordinary', privacyChecked: true,
      os: { name: 'Windows', version: '11' },
      prerequisites: { filtersCurrent: true, isolated: true, detectionResolvedWhenDisabled: true, documentationChecked: true } },
    images: [{ id: 'viewport', sensitivity: 'ordinary', sanitized: true }] });
  await worker.processCaptures();
  assert.equal(store.captureStatus(capture.id).state, 'accepted');
  assert.deepEqual(received.context, { condition: 'installed', pageState: 'usable', lists, blockers,
    sensitivity: 'ordinary', prerequisites: { filtersCurrent: true, isolated: false } });
  assert.deepEqual(store.capture(capture.id), capture);
});

for (const pageState of ['challenge', 'login-required']) {
  test(`annotated ${pageState} abstains before any provider request`, async t => {
    let requests = 0;
    const { store, worker } = fixture(t, { analyze: analyzeEvidence,
      fetchImpl: async () => { requests++; throw new Error('No provider request is expected'); } });
    const capture = captureFixture({ context: { pageState: 'unknown' } });
    store.ingest(capture);
    store.annotateCapture(capture.id, { source: 'Synthetic page observation', observedAt: '2026-11-21T16:01:00.000Z',
      context: { pageState }, images: [] });
    await worker.processCaptures();
    assert.equal(requests, 0);
    assert.equal(store.captureStatus(capture.id).state, 'abstained');
    assert.equal(store.reports().length, 0);
  });
}

for (const [text, available] of [['Recorded page text', true], [' \n\t', false]]) {
  test(`captured text availability is worker-owned when available=${available}`, async t => {
    const { store, worker } = fixture(t, {
      analyze: async () => ({ state: 'accepted', findings: [{ ...finding,
        textEvidence: { id: 'forged', available: !available } }], provenance: {} }),
      prepare: readyReport,
    });
    store.ingest(captureFixture({ text }));
    await worker.processCaptures();
    assert.deepEqual(store.findings()[0].textEvidence, { id: 'text', available });
    assert.equal(Object.hasOwn(store.findings()[0], 'text'), false);
    assert.equal(store.reports()[0].body.includes(text), false);
  });
}
