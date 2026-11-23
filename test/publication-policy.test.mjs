import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { imagePublicationKey } from '../src/annotations.mjs';
import { createWorker } from '../src/worker.mjs';
import { prepareReport } from '../src/reports.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

const repository = 'AdguardTeam/AdguardFilters';
const list = { id: 'adguard:filter:2', name: 'AdGuard Base filter', enabled: true };
const catalogRecord = { ...list, owner: repository, categories: ['ads'] };
const observation = {
  category: 'missed-ads',
  observation: 'A paid banner remains beside the article',
  expectedBehavior: 'Hide the paid advertisement',
  reproduction: ['Open the recorded article'],
  evidenceIds: ['viewport'],
  confidence: 0.95,
  sensitivity: 'ordinary',
  suggestedListIds: [list.id],
};
const notes = () => ({
  source: 'Synthetic publication-policy observation',
  observedAt: '2026-11-21T16:01:00.000Z',
  context: {
    sensitivity: 'ordinary',
    privacyChecked: true,
    os: { name: 'Windows', version: '11' },
    product: { id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', manifestVersion: 3 },
    prerequisites: { filtersCurrent: true, productCurrent: true, browserCurrent: true },
  },
  images: [{ id: 'viewport', sensitivity: 'ordinary', sanitized: true, redactions: [] }],
});

async function fixture(
  t,
  { states = ['ready'], prepare = prepareReport, publish, reconcile, upload } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-publication-policy-'));
  let store = openStore(directory);
  let worker;
  t.after(async () => {
    await worker?.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  config.publication.evidenceRepository = 'operator/evidence';
  config.publication.minIntervalMs = 1000;
  const dispatched = [];
  const uploads = [];
  const publisher = {
    async publish(report) {
      dispatched.push(structuredClone(report));
      return publish
        ? publish(report, store)
        : {
            state: 'created',
            receipt: {
              repository: report.destination.repo,
              issueNumber: 42,
              url: `https://github.com/${report.destination.repo}/issues/42`,
              submittedContentHash: createHash('sha256').update(report.body).digest('hex'),
            },
          };
    },
    async reconcile(report) {
      return reconcile ? reconcile(report) : { state: 'uncertain', reason: 'fixture-not-found' };
    },
    ...(upload
      ? {
          async uploadEvidence(image, config, options) {
            uploads.push({
              image: structuredClone(image),
              config: structuredClone(config),
              reconcileOnly: options.reconcileOnly,
            });
            return upload(image, config, options);
          },
        }
      : {}),
  };
  const offlineFetch = async () => {
    throw new Error('This fixture must not make network requests');
  };
  store.saveCatalog({ source: 'manual', records: [catalogRecord], counts: {} });
  for (const [index] of states.entries()) {
    const capture = captureFixture({
      id: `policy_capture_${index}`,
      url: `https://example.com/article-${index}`,
      context: {
        lists: [list],
        pageState: 'usable',
        sensitivity: 'ordinary',
        blockers: [
          { id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true },
        ],
      },
    });
    store.ingest(capture);
    store.annotateCapture(capture.id, notes());
    const image = capture.images[0];
    store.setRecord(
      imagePublicationKey(
        capture,
        image,
        store.annotations(capture.id),
        config.publication.evidenceRepository,
      ),
      {
        state: 'uploaded',
        image: {
          id: image.id,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          sensitivity: 'ordinary',
          sanitized: true,
          verifiedPublic: true,
          url: `https://raw.githubusercontent.com/operator/evidence/${'a'.repeat(40)}/policy-${index}.png`,
        },
      },
    );
  }
  worker = createWorker({
    store,
    config,
    env: {},
    fetchImpl: offlineFetch,
    analyze: async () => ({
      state: 'accepted',
      findings: [observation],
      provenance: { model: 'offline-fixture' },
    }),
    prepare: (finding, options) => ({
      ...prepareReport(finding, options),
      id: `canonical-${finding.captureId}`,
    }),
  });
  await worker.processCaptures();
  const ids = states.map((state, index) => {
    const id = `canonical-policy_capture_${index}`;
    assert.equal(store.report(id).state, 'ready', JSON.stringify(store.report(id).reasons));
    if (state === 'dry-run') store.finishReport(id, { state, reason: 'publication_disabled' });
    return id;
  });
  await worker.stop();
  config.provider.enabled = false;
  config.publication.enabled = true;
  const makeWorker = () =>
    createWorker({ store, config, env: {}, fetchImpl: offlineFetch, prepare, publisher });
  worker = makeWorker();
  return {
    config,
    ids,
    dispatched,
    uploads,
    get store() {
      return store;
    },
    get worker() {
      return worker;
    },
    async restart() {
      await worker.stop();
      store.close();
      store = openStore(directory);
      store.recoverInterrupted();
      worker = makeWorker();
    },
  };
}

for (const state of ['ready', 'dry-run']) {
  test(`unvisited ${state} drafts obey a revoked allowlist after restart`, async (t) => {
    const f = await fixture(t, { states: [state, state] });
    f.config.publication.allowedRepositories = [];
    f.config.scheduler.maxAnalysesPerCycle = 1;
    await f.restart();
    assert.equal((await f.worker.refreshReports()).prepared, 1);
    assert.equal(f.store.report(f.ids[1]).state, state);
    await f.worker.processPublications();
    assert.equal(f.dispatched.length, 0);
    for (const id of f.ids) {
      assert.equal(f.store.report(id).state, 'deferred');
      assert.ok(f.store.report(id).reasons.includes('repository-not-allowed'));
    }
  });
}

test('permitted current evidence replaces stale content durably without changing the canonical report ID', async (t) => {
  const f = await fixture(t, {
    states: ['dry-run'],
    publish(report, store) {
      const persisted = store.report(report.id);
      assert.equal(persisted.state, 'sending');
      assert.equal(persisted.body, report.body);
      assert.equal(persisted.marker, report.marker);
      assert.equal(persisted.fingerprint, report.fingerprint);
      return {
        state: 'created',
        receipt: {
          issueNumber: 42,
          submittedContentHash: createHash('sha256').update(report.body).digest('hex'),
        },
      };
    },
  });
  const before = f.store.report(f.ids[0]);
  const finding = f.store.finding(before.findingId);
  f.store.updateFinding(finding.id, {
    ...finding,
    observation: 'A newly measured paid banner remains',
  });
  await f.restart();
  await f.worker.processPublications();
  assert.equal(f.dispatched.length, 1);
  const sent = f.dispatched[0];
  assert.equal(sent.id, before.id);
  assert.equal(sent.findingId, before.findingId);
  assert.match(sent.body, /A newly measured paid banner remains/);
  assert.notEqual(sent.fingerprint, before.fingerprint);
  assert.equal(
    f.store.report(before.id).receipt.submittedContentHash,
    createHash('sha256').update(sent.body).digest('hex'),
  );
  await f.restart();
  await f.worker.processPublications();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.store.report(before.id).receipt.issueNumber, 42);
});

test('a changed evidence repository cannot reuse a stale screenshot receipt', async (t) => {
  const f = await fixture(t);
  f.config.publication.evidenceRepository = 'operator/replacement-evidence';
  await f.worker.processPublications();
  assert.equal(f.dispatched.length, 0);
  const report = f.store.report(f.ids[0]);
  assert.equal(report.state, 'deferred');
  assert.ok(report.reasons.includes('evidence-url-missing-or-nonpublic:viewport'));
});

for (const change of [
  {
    name: 'allowlist revocation',
    apply: (f) => {
      f.config.publication.allowedRepositories = [];
    },
    reason: 'repository-not-allowed',
  },
  {
    name: 'catalog policy change',
    apply: (f) =>
      f.store.saveCatalog({
        source: 'manual',
        records: [{ ...catalogRecord, categories: ['privacy'] }],
        counts: {},
      }),
    reason: 'selected-list-policy-does-not-cover-category',
  },
]) {
  test(
    `publication revalidation observes ${change.name} during pacing`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const waiting = Promise.withResolvers();
      const getRecord = f.store.getRecord.bind(f.store);
      t.mock.method(f.store, 'getRecord', (key) => {
        const value = getRecord(key);
        if (key === 'publication:lastDispatch') waiting.resolve();
        return value;
      });
      f.store.setRecord('publication:lastDispatch', Date.now());
      const pending = f.worker.processPublications();
      await waiting.promise;
      change.apply(f);
      await pending;
      assert.equal(f.dispatched.length, 0);
      assert.equal(f.store.report(f.ids[0]).state, 'deferred');
      assert.ok(f.store.report(f.ids[0]).reasons.includes(change.reason));
    },
  );
}

test('catalog changes while dispatch preparation is awaiting cannot authorize its old snapshot', async (t) => {
  const preparing = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  t.after(() => proceed.resolve());
  const f = await fixture(t, {
    prepare: async (finding, options) => {
      const prepared = prepareReport(finding, options);
      preparing.resolve();
      await proceed.promise;
      return prepared;
    },
  });
  const pending = f.worker.processPublications();
  await preparing.promise;
  f.store.saveCatalog({
    source: 'manual',
    records: [{ ...catalogRecord, categories: ['privacy'] }],
    counts: {},
  });
  proceed.resolve();
  await pending;
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.store.report(f.ids[0]).state, 'deferred');
});

test('annotations changed during dispatch preparation stay deferred', async (t) => {
  const preparing = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  t.after(() => proceed.resolve());
  const f = await fixture(t, {
    prepare: async (finding, options) => {
      const prepared = prepareReport(finding, options);
      preparing.resolve();
      await proceed.promise;
      return prepared;
    },
  });
  const pending = f.worker.processPublications();
  await preparing.promise;
  const changed = notes();
  changed.context.privacyChecked = false;
  changed.images[0].sanitized = false;
  f.store.annotateCapture('policy_capture_0', changed);
  proceed.resolve();
  await pending;
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.store.report(f.ids[0]).state, 'deferred');
  assert.equal(f.store.annotations('policy_capture_0').context.privacyChecked, false);
});

test('uncertain attempt metadata survives restart and policy revocation for reconciliation only', async (t) => {
  let attempt;
  let original;
  const f = await fixture(t, {
    publish(report) {
      original = structuredClone(report);
      attempt = {
        destination: report.destination,
        marker: report.marker,
        submittedContentHash: createHash('sha256').update(report.body).digest('hex'),
        at: '2026-11-21T16:05:00.000Z',
      };
      return { state: 'uncertain', reason: 'response_lost', attempt };
    },
    reconcile(report) {
      assert.deepEqual(report.attempt, attempt);
      assert.equal(report.body, original.body);
      assert.equal(report.fingerprint, original.fingerprint);
      return {
        state: 'created',
        receipt: { issueNumber: 42, submittedContentHash: attempt.submittedContentHash },
      };
    },
  });
  await f.worker.processPublications();
  assert.equal(f.store.report(f.ids[0]).state, 'uncertain');
  assert.deepEqual(f.store.report(f.ids[0]).attempt, attempt);
  f.config.publication.allowedRepositories = [];
  f.store.saveCatalog({
    source: 'manual',
    records: [{ ...catalogRecord, categories: ['privacy'] }],
    counts: {},
  });
  await f.restart();
  await f.worker.refreshReports();
  await f.worker.processPublications();
  assert.deepEqual(f.store.report(f.ids[0]).attempt, attempt);
  assert.equal(f.dispatched.length, 1);
  await f.worker.reconcileReports();
  assert.equal(f.store.report(f.ids[0]).receipt.submittedContentHash, attempt.submittedContentHash);
  assert.equal(f.dispatched.length, 1);
});

test('publication remains dry-run when disabled and can resume with current permitted evidence', async (t) => {
  const f = await fixture(t);
  f.config.publication.enabled = false;
  await f.worker.processPublications();
  assert.equal(f.store.report(f.ids[0]).state, 'dry-run');
  assert.equal(f.dispatched.length, 0);
  f.config.publication.enabled = true;
  await f.restart();
  await f.worker.processPublications();
  assert.equal(f.store.report(f.ids[0]).state, 'created');
  assert.equal(f.dispatched.length, 1);
});

test('a ready label without its recorded finding cannot authorize publication', async (t) => {
  const f = await fixture(t, { states: [] });
  f.store.saveReport({
    id: 'orphan-report',
    fingerprint: 'orphan-fingerprint',
    state: 'ready',
    findingId: 'missing-finding',
    captureId: 'missing-capture',
    title: 'Orphan',
    body: 'Old draft',
    reasons: [],
  });
  await f.worker.processPublications();
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.store.report('orphan-report').state, 'deferred');
});

function awaitPacing(t, store) {
  const waiting = Promise.withResolvers();
  const getRecord = store.getRecord.bind(store);
  t.mock.method(store, 'getRecord', (key) => {
    const value = getRecord(key);
    if (key === 'publication:lastDispatch') waiting.resolve();
    return value;
  });
  store.setRecord('publication:lastDispatch', Date.now());
  return waiting.promise;
}

function removePublishedImage(f) {
  const capture = f.store.capture('policy_capture_0');
  const key = imagePublicationKey(
    capture,
    capture.images[0],
    f.store.annotations(capture.id),
    f.config.publication.evidenceRepository,
  );
  f.store.setRecord(key, { state: 'deferred' });
  return key;
}

for (const change of [
  {
    name: 'allowlist revocation',
    apply: (f) => {
      f.config.publication.allowedRepositories = [];
    },
    reason: 'repository-not-allowed',
  },
  {
    name: 'catalog policy change',
    apply: (f) =>
      f.store.saveCatalog({
        source: 'manual',
        records: [{ ...catalogRecord, categories: ['privacy'] }],
        counts: {},
      }),
    reason: 'selected-list-policy-does-not-cover-category',
  },
]) {
  test(`evidence upload observes ${change.name} during pacing`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t, {
      upload: async () => ({ state: 'failed', reason: 'unexpected_upload' }),
    });
    removePublishedImage(f);
    const waiting = awaitPacing(t, f.store);
    const pending = f.worker.refreshReports();
    await waiting;
    change.apply(f);
    await pending;
    assert.equal(f.uploads.length, 0);
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.store.report(f.ids[0]).state, 'deferred');
    assert.ok(f.store.report(f.ids[0]).reasons.includes(change.reason));
    assert.deepEqual(f.store.leases(), []);
  });
}

for (const phase of ['preparation', 'publication', 'upload']) {
  test(`pending reassessment blocks stale ${phase}`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t, {
      upload: async () => ({ state: 'failed', reason: 'unexpected_upload' }),
    });
    let pendingReassessment = phase === 'preparation';
    const original = f.store.reassessmentPending;
    f.store.reassessmentPending = () => pendingReassessment;
    t.after(() => {
      f.store.reassessmentPending = original;
    });
    if (phase === 'upload') removePublishedImage(f);
    const waiting = phase === 'preparation' ? null : awaitPacing(t, f.store);
    const pending =
      phase === 'publication' ? f.worker.processPublications() : f.worker.refreshReports();
    if (waiting) {
      await waiting;
      pendingReassessment = true;
    }
    await pending;
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.uploads.length, 0);
    const report = f.store.report(f.ids[0]);
    assert.equal(report.state, 'deferred');
    assert.ok(report.reasons.includes('analysis_reassessment_pending'));
    assert.deepEqual(f.store.leases(), []);
  });
}

test('bounded publication preserves unvisited dry runs and permits each current draft once', async (t) => {
  const f = await fixture(t, { states: ['dry-run', 'dry-run'] });
  assert.equal((await f.worker.processPublications({ limit: 1 })).processed, 1);
  assert.deepEqual(
    f.dispatched.map((report) => report.id),
    [f.ids[0]],
  );
  assert.equal(f.store.report(f.ids[1]).state, 'dry-run');
  assert.equal((await f.worker.processPublications({ limit: 1 })).processed, 1);
  assert.deepEqual(
    f.dispatched.map((report) => report.id),
    f.ids,
  );
  assert.equal(f.store.reports().filter((report) => report.state === 'created').length, 2);
});

test('recovered sending debt retains its old body and unknown attempt hash without revalidation', async (t) => {
  let original;
  let reconciled = 0;
  const f = await fixture(t, {
    reconcile(report) {
      reconciled++;
      assert.equal(report.body, original.body);
      assert.equal(report.fingerprint, original.fingerprint);
      assert.equal(report.attempt, undefined);
      return { state: 'uncertain', reason: 'fixture-not-found', submittedContentHash: null };
    },
  });
  original = f.store.claimReport();
  f.config.publication.allowedRepositories = [];
  await f.restart();
  await f.worker.processPublications();
  await f.worker.reconcileReports();
  assert.equal(f.dispatched.length, 0);
  assert.equal(reconciled, 1);
  assert.equal(f.store.report(original.id).state, 'uncertain');
  assert.equal(f.store.report(original.id).attempt, undefined);
});
