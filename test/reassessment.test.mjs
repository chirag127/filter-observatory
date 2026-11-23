import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { createWorker } from '../src/worker.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

const list = { id: 'adguard:filter:2', name: 'AdGuard Base filter', enabled: true, version: '1' };
const observation = {
  category: 'missed-ads',
  observation: 'A paid banner remains beside the article',
  expectedBehavior: 'Hide the paid advertisement',
  reproduction: ['Open the recorded article'],
  evidenceIds: ['viewport', 'text'],
  confidence: 0.95,
  sensitivity: 'ordinary',
  suggestedListIds: [],
};
const notes = (lists = [list]) => ({
  source: 'Synthetic measured settings export',
  observedAt: '2026-11-21T16:01:00.000Z',
  context: {
    lists,
    pageState: 'usable',
    sensitivity: 'ordinary',
    privacyChecked: true,
    blockers: [{ id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.78', enabled: true }],
    product: { id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.78', manifestVersion: 3 },
    os: { name: 'Windows', version: '11' },
    prerequisites: { filtersCurrent: true, productCurrent: true, browserCurrent: true },
  },
  images: [{ id: 'viewport', sensitivity: 'ordinary', sanitized: true }],
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-reassessment-'));
  let store = openStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = openStore(directory);
      return store;
    },
  };
}

function accepted(store, capture, { count = 1, attributed = false } = {}) {
  store.ingest(capture);
  store.claimCapture(capture.id);
  const findings = Array.from({ length: count }, (_, index) => ({
    ...observation,
    id: `${capture.id}_finding_${index}`,
    captureId: capture.id,
    listIds: attributed ? [list.id] : [],
    context: { ...capture.context },
    observation: `Paid banner ${index}`,
  }));
  const result = { state: 'accepted', findings, provenance: { model: 'synthetic-original' } };
  const reports = findings.map((item) => ({
    id: `report_${item.id}`,
    captureId: capture.id,
    findingId: item.id,
    fingerprint: `original_${item.id}`,
    state: 'deferred',
    reasons: ['attribution-list-missing'],
    body: item.observation,
  }));
  store.finishCapture(capture.id, result, reports);
  return { result, findings, reports };
}

test('late measured lists queue one reassessment and preserve the original capture and analysis across reopen', (t) => {
  const f = fixture(t);
  const capture = captureFixture();
  const original = accepted(f.store, capture);
  f.store.annotateCapture(capture.id, notes());
  assert.equal(f.store.captureStatus(capture.id).state, 'queued');
  assert.equal(f.store.reassessmentPending(capture.id), true);
  f.reopen();
  assert.deepEqual(f.store.capture(capture.id), capture);
  assert.deepEqual(f.store.captureStatus(capture.id).result, original.result);
  assert.deepEqual(f.store.analysisHistory(capture.id)[0].result, original.result);
  const metadataOnly = notes();
  metadataOnly.source = 'Same export verified again';
  metadataOnly.observedAt = '2026-11-21T16:02:00.000Z';
  f.store.annotateCapture(capture.id, metadataOnly);
  assert.equal(f.store.claimCapture().id, capture.id);
  assert.equal(f.store.claimCapture(), null);
  assert.equal(f.store.analysisHistory(capture.id).length, 2);
});

test('accepted reassessment atomically replaces obsolete unsent findings and drafts with the deterministic IDs', (t) => {
  const { store } = fixture(t);
  const capture = captureFixture();
  const original = accepted(store, capture, { count: 2 });
  store.annotateCapture(capture.id, notes());
  assert.equal(store.claimCapture()?.id, capture.id);
  const finding = {
    ...original.findings[0],
    listIds: [list.id],
    suggestedListIds: [list.id],
    observation: 'Confirmed paid banner',
  };
  const report = {
    ...original.reports[0],
    fingerprint: 'attributed-banner',
    state: 'ready',
    reasons: [],
    body: 'Reassessed evidence',
  };
  store.finishCapture(
    capture.id,
    { state: 'accepted', findings: [finding], provenance: { model: 'synthetic-reassessment' } },
    [report],
  );
  assert.equal(store.captureStatus(capture.id).state, 'accepted');
  assert.equal(store.reassessmentPending(capture.id), false);
  assert.deepEqual(store.findings(), [finding]);
  assert.equal(store.reports().length, 1);
  assert.equal(store.reports()[0].id, original.reports[0].id);
  assert.equal(store.reports()[0].body, 'Reassessed evidence');
  assert.deepEqual(store.analysisHistory(capture.id)[0].result, original.result);
  assert.equal(store.analysisHistory(capture.id)[1].state, 'accepted');
  assert.deepEqual(store.capture(capture.id), capture);
});

test('a failed reassessment retains previous evidence and keeps stale drafts unavailable through recovery and retry', (t) => {
  const f = fixture(t);
  const capture = captureFixture();
  const original = accepted(f.store, capture);
  f.store.annotateCapture(capture.id, notes());
  assert.equal(f.store.claimCapture()?.id, capture.id);
  f.reopen().recoverInterrupted();
  assert.equal(f.store.captureStatus(capture.id).state, 'interrupted');
  assert.equal(f.store.reassessmentPending(capture.id), true);
  assert.deepEqual(f.store.findings(), original.findings);
  assert.equal(f.store.claimReport(), null);
  assert.equal(f.store.retryCapture(capture.id), true);
  assert.equal(f.store.claimCapture()?.id, capture.id);
  f.store.finishCapture(capture.id, {
    state: 'failed',
    reason: 'http_error',
    findings: [],
    provenance: {},
  });
  assert.deepEqual(f.store.findings(), original.findings);
  assert.equal(f.store.reassessmentPending(capture.id), true);
  assert.equal(f.store.analysisHistory(capture.id)[0].state, 'accepted');
  assert.equal(f.store.analysisHistory(capture.id)[1].state, 'interrupted');
  assert.equal(f.store.analysisHistory(capture.id)[2].state, 'failed');
  f.store.annotateCapture(capture.id, notes());
  assert.equal(f.store.captureStatus(capture.id).state, 'failed');
});

test('automatic reassessment is once per effective enabled-list context with a three-context budget', (t) => {
  const { store } = fixture(t);
  const capture = captureFixture();
  const original = accepted(store, capture);
  for (let version = 1; version <= 3; version++) {
    store.annotateCapture(capture.id, notes([{ ...list, version: String(version) }]));
    assert.equal(store.claimCapture()?.id, capture.id);
    store.finishCapture(
      capture.id,
      { ...original.result, provenance: { model: `attempt-${version}` } },
      original.reports,
    );
  }
  store.annotateCapture(capture.id, notes([{ ...list, version: '4' }]));
  assert.equal(store.claimCapture(), null);
  assert.equal(
    store.analysisHistory(capture.id).filter((item) => item.kind === 'reassessment').length,
    3,
  );
  assert.equal(
    store.captureStatus(capture.id).reassessment.reason,
    'reassessment_budget_exhausted',
  );
});

test('list-order and annotation-only changes never enqueue another provider request', (t) => {
  const { store } = fixture(t);
  const capture = captureFixture();
  const original = accepted(store, capture);
  const second = {
    id: 'adguard:filter:3',
    name: 'AdGuard Tracking Protection filter',
    enabled: true,
  };
  store.annotateCapture(capture.id, notes([list, second]));
  assert.equal(store.claimCapture()?.id, capture.id);
  store.finishCapture(capture.id, original.result, original.reports);
  const unchanged = notes([second, list]);
  unchanged.source = 'Reordered export';
  unchanged.observedAt = '2026-11-21T17:00:00.000Z';
  store.annotateCapture(capture.id, unchanged);
  assert.equal(store.claimCapture(), null);
  assert.equal(store.analysisHistory(capture.id).length, 2);
});

test('captured list readback and already-attributed findings do not trigger unnecessary reassessment', (t) => {
  const { store } = fixture(t);
  for (const attributed of [false, true]) {
    const capture = captureFixture({
      id: `capture_has_lists_${attributed}`,
      context: { lists: [list] },
    });
    accepted(store, capture, { attributed });
    store.annotateCapture(capture.id, notes([{ ...list, version: 'different-annotation' }]));
    assert.equal(store.captureStatus(capture.id).state, 'accepted');
  }
  assert.equal(store.claimCapture(), null);
});

test('protected publication identities and receipts prevent replacement by an automatic reassessment', (t) => {
  const { store } = fixture(t);
  for (const state of ['uncertain', 'created', 'appended']) {
    const capture = captureFixture({ id: `capture_protected_${state}` });
    const original = accepted(store, capture);
    store.finishReport(original.reports[0].id, {
      state,
      receipt: { number: 42, contentHash: 'original-content' },
    });
    const saved = store.report(original.reports[0].id);
    store.annotateCapture(capture.id, notes());
    assert.equal(store.captureStatus(capture.id).state, 'accepted');
    assert.deepEqual(store.report(saved.id), saved);
    assert.deepEqual(store.finding(original.findings[0].id), original.findings[0]);
  }
  assert.equal(store.claimCapture(), null);
});

test('list context arriving during the original analysis is queued after that attempt finishes', (t) => {
  const { store } = fixture(t);
  const capture = captureFixture();
  store.ingest(capture);
  store.claimCapture();
  store.annotateCapture(capture.id, notes());
  const finding = {
    ...observation,
    id: 'finding_original_race',
    captureId: capture.id,
    listIds: [],
  };
  store.finishCapture(capture.id, { state: 'accepted', findings: [finding], provenance: {} });
  assert.equal(store.captureStatus(capture.id).state, 'queued');
  assert.equal(store.reassessmentPending(capture.id), true);
  assert.equal(store.claimCapture()?.id, capture.id);
});

test('late companion annotations reach the real findings adapter and recover attribution without duplicate findings', async (t) => {
  const f = fixture(t);
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  const inputs = [];
  const worker = createWorker({
    store: f.store,
    config,
    env: {},
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const input = JSON.parse(body.messages[1].content[0].text);
      inputs.push(input.capture.context);
      const payload = {
        schemaVersion: 1,
        assessment: 'observed_issue',
        findings: [
          {
            ...observation,
            suggestedListIds: input.capture.context.lists?.map((item) => item.id) ?? [],
          },
        ],
        limitations: ['Synthetic transport fixture'],
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'fixture_reassessment',
                    type: 'function',
                    function: { name: 'return_findings', arguments: JSON.stringify(payload) },
                  },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  t.after(() => worker.stop());
  const capture = captureFixture({ context: { sensitivity: 'ordinary', pageState: 'usable' } });
  f.store.saveCatalog({
    source: 'manual',
    records: [{ ...list, owner: 'AdguardTeam/AdguardFilters', categories: ['ads'] }],
    counts: {},
  });
  f.store.ingest(capture);
  await worker.processCaptures();
  assert.equal(f.store.captureStatus(capture.id).state, 'accepted');
  assert.deepEqual(f.store.findings()[0].listIds, []);
  f.store.annotateCapture(capture.id, notes());
  await worker.processCaptures();
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].lists, undefined);
  assert.deepEqual(inputs[1].lists, [list]);
  assert.equal(f.store.findings().length, 1);
  assert.deepEqual(f.store.findings()[0].listIds, [list.id]);
  assert.equal(f.store.reports().length, 1);
  assert.equal(f.store.reports()[0].reasons.includes('attribution-list-missing'), false);
  assert.equal(f.store.reports()[0].reasons.includes('missing-evidence:text'), false);
  assert.equal(f.store.analysisHistory(capture.id).length, 2);
  await worker.processCaptures();
  assert.equal(inputs.length, 2);
});
