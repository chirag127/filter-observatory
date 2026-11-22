import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { openStore } from '../src/store.mjs';
import { effectiveContext } from '../src/annotations.mjs';
import { defaultConfig } from '../src/config.mjs';
import { prepareReport } from '../src/reports.mjs';
import { createWorker } from '../src/worker.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

const repository = 'AdguardTeam/AdguardFilters';
const baseList = { id: 'adguard:filter:2', name: 'AdGuard Base filter', enabled: true, version: '1' };
const otherList = { id: 'adguard:filter:11', name: 'AdGuard Mobile Ads filter', enabled: true, version: '1' };
const catalog = [baseList, otherList].map(list => ({ ...list, owner: repository, categories: ['ads'] }));
const above = 'A paid banner remains above the article.';
const below = 'A paid banner remains below the article.';
const hash = value => createHash('sha256').update(value).digest('hex');
const versionedLists = version => [{ ...baseList, version: String(version) }];

function notes(lists = [], context = {}) {
  return { source: 'Synthetic measured settings export', observedAt: '2026-11-21T16:01:00.000Z',
    context: { lists, pageState: 'usable', sensitivity: 'ordinary', privacyChecked: true,
      blockers: [{ id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.78', enabled: true }],
      product: { id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.78', manifestVersion: 3 },
      os: { name: 'Windows', version: '11' }, otherExtensions: [],
      prerequisites: { filtersCurrent: true, productCurrent: true, browserCurrent: true }, ...context },
    images: [{ id: 'viewport', sensitivity: 'ordinary', sanitized: context.privacyChecked !== false }] };
}

function fixture(t) {
  const root = join(tmpdir(), 'opencode');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'observatory-reassessment-review-'));
  let store = openStore(directory);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network operation in reassessment regression'); });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = openStore(directory); return store; } };
}

function derived(store, capture, observations = [above], listIds = []) {
  const annotations = store.annotations(capture.id);
  const context = effectiveContext(capture, annotations);
  const findings = observations.map((observation, index) => ({
    id: hash(`${capture.id}:${index}`), captureId: capture.id, url: capture.url, title: capture.title,
    category: 'missed-ads', observation, expectedBehavior: 'Hide the paid advertisement.',
    reproduction: ['Open the captured article.'], evidenceIds: ['viewport'], confidence: 0.9,
    sensitivity: 'ordinary', suggestedListIds: [...listIds], listIds: [...listIds], context,
    annotationRevision: annotations?.revision ?? null,
    textEvidence: { id: 'text', available: Boolean(capture.text.trim()) },
    images: capture.images.map(({ dataBase64, ...image }) => ({ ...image,
      url: 'https://raw.githubusercontent.com/operator/evidence/main/screenshots/synthetic.png',
      verifiedPublic: true, sensitivity: 'ordinary',
      sanitized: annotations?.images.find(note => note.id === image.id)?.sanitized === true })),
  }));
  const reports = findings.map(finding => ({
    ...prepareReport(finding, { catalog, config: { allowedRepositories: [repository] } }),
    captureId: capture.id, findingId: finding.id, annotationRevision: finding.annotationRevision,
  }));
  return { findings, reports, result: { state: 'accepted', findings,
    provenance: { model: 'synthetic-review', assessment: findings.length ? 'observed_issue' : 'no_issue_observed' } } };
}

function accepted(store, id, { lists = [], listIds = [], observations = [above], privacyChecked = true } = {}) {
  const capture = captureFixture({ id });
  store.ingest(capture);
  store.annotateCapture(capture.id, notes(lists, { privacyChecked }));
  assert.equal(store.claimCapture(capture.id)?.id, capture.id);
  const prepared = derived(store, capture, observations, listIds);
  store.finishCapture(capture.id, prepared.result, prepared.reports);
  return { capture, ...prepared };
}

test('a clean reassessment for an obsolete in-flight list revision retains active evidence and queues the latest context', async t => {
  const f = fixture(t);
  const original = accepted(f.store, 'capture_review_stale_clean');
  f.store.annotateCapture(original.capture.id, notes(versionedLists(1)));
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  const dispatchedVersions = [];
  const worker = createWorker({ store: f.store, config, env: {}, prepare: prepareReport,
    analyze: async evidence => {
      dispatchedVersions.push(evidence.context.lists[0].version);
      f.store.annotateCapture(original.capture.id, notes(versionedLists(2)));
      return { state: 'accepted', findings: [], provenance: { assessment: 'no_issue_observed' } };
    } });
  try { await worker.processCaptures({ limit: 1 }); }
  finally { await worker.stop(); }

  assert.deepEqual(dispatchedVersions, ['1']);
  const history = f.store.analysisHistory(original.capture.id);
  assert.equal(history.length, 2);
  assert.equal(history[1].context.lists[0].version, '1');
  assert.equal(history[1].result.provenance.assessment, 'no_issue_observed');
  assert.deepEqual(history[0].result, original.result);
  assert.deepEqual(f.store.findings(), original.findings);
  assert.deepEqual(f.store.reports().map(report => [report.id, report.fingerprint, report.body]),
    original.reports.map(report => [report.id, report.fingerprint, report.body]));
  assert.equal(f.store.captureStatus(original.capture.id).state, 'queued');
  assert.equal(f.store.reassessmentPending(original.capture.id), true);
  assert.equal(f.store.claimReport(), null);
  f.reopen();
  assert.deepEqual(f.store.capture(original.capture.id), original.capture);
  assert.equal(f.store.claimCapture(original.capture.id)?.id, original.capture.id);
  assert.equal(f.store.analysisHistory(original.capture.id).at(-1).context.lists[0].version, '2');
});

test('reordering observations between deterministic finding slots preserves two canonical drafts without a duplicate cycle', t => {
  const { store } = fixture(t);
  const original = accepted(store, 'capture_review_swap', { lists: versionedLists(1), observations: [above, below] });
  assert.ok(original.reports.every(report => report.reasons.includes('attribution-list-missing')));
  store.annotateCapture(original.capture.id, notes(versionedLists(2)));
  assert.equal(store.claimCapture(original.capture.id)?.id, original.capture.id);
  const replacement = derived(store, original.capture, [below, above]);
  assert.deepEqual(replacement.reports.map(report => report.fingerprint),
    [original.reports[1].fingerprint, original.reports[0].fingerprint]);
  store.finishCapture(original.capture.id, replacement.result, replacement.reports);

  assert.equal(store.captureStatus(original.capture.id).state, 'accepted');
  assert.equal(store.reassessmentPending(original.capture.id), false);
  assert.deepEqual(store.findings(), replacement.findings);
  const canonical = store.reports().filter(report => report.state !== 'duplicate');
  assert.equal(canonical.length, 2);
  for (const expected of replacement.reports) {
    const matches = canonical.filter(report => report.fingerprint === expected.fingerprint);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].findingId, expected.findingId);
    assert.equal(matches[0].body, expected.body);
  }
  assert.deepEqual(store.analysisHistory(original.capture.id)[0].result, original.result);
  store.annotateCapture(original.capture.id, notes(versionedLists(3)));
  assert.equal(store.claimCapture(original.capture.id)?.id, original.capture.id,
    'A false protected duplicate must not strand subsequent reassessment');
});

test('reassessment avoids a canonical report ID promoted to another capture and preserves its delivered receipt', t => {
  const f = fixture(t);
  const first = accepted(f.store, 'capture_review_promoted_A', {
    lists: versionedLists(1), listIds: [baseList.id], privacyChecked: false,
  });
  const second = accepted(f.store, 'capture_review_promoted_B', { lists: versionedLists(1), listIds: [baseList.id] });
  assert.equal(first.reports[0].state, 'deferred');
  assert.equal(second.reports[0].state, 'ready');
  assert.equal(first.reports[0].fingerprint, second.reports[0].fingerprint);
  const canonicalId = first.reports[0].id;
  assert.equal(f.store.reports().length, 1);
  assert.equal(f.store.report(canonicalId).captureId, second.capture.id);
  assert.equal(f.store.claimReport()?.id, canonicalId);
  f.store.finishReport(canonicalId, { state: 'created', receipt: {
    repo: repository, operation: 'issue', issueNumber: 42, issueId: 420,
    url: `https://github.com/${repository}/issues/42`,
    submittedContentHash: hash(second.reports[0].body), attachmentCompleteness: { state: 'complete' },
  } });
  const delivered = f.store.report(canonicalId);

  f.store.annotateCapture(first.capture.id, notes([otherList]));
  assert.equal(f.store.claimCapture(first.capture.id)?.id, first.capture.id);
  const replacement = derived(f.store, first.capture, [above], [otherList.id]);
  assert.equal(replacement.reports[0].state, 'ready');
  assert.equal(replacement.reports[0].id, canonicalId);
  assert.notEqual(replacement.reports[0].fingerprint, delivered.fingerprint);
  f.store.finishCapture(first.capture.id, replacement.result, replacement.reports);

  assert.equal(f.store.captureStatus(first.capture.id).state, 'accepted');
  assert.equal(f.store.analysisHistory(first.capture.id).at(-1).state, 'accepted');
  assert.equal(f.store.reassessmentPending(first.capture.id), false);
  assert.deepEqual(f.store.finding(replacement.findings[0].id), replacement.findings[0]);
  assert.deepEqual(f.store.report(canonicalId), delivered);
  const reassessed = f.store.reports().filter(report => report.captureId === first.capture.id);
  assert.equal(reassessed.length, 1);
  assert.notEqual(reassessed[0].id, canonicalId);
  assert.equal(reassessed[0].fingerprint, replacement.reports[0].fingerprint);
  assert.equal(reassessed[0].state, 'ready');
  assert.equal(f.store.reports().length, 2);
  const repeated = f.store.saveReport(replacement.reports[0]);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.id, reassessed[0].id);
  f.reopen();
  assert.deepEqual(f.store.report(canonicalId), delivered);
  assert.deepEqual(f.store.capture(first.capture.id), first.capture);
  assert.deepEqual(f.store.capture(second.capture.id), second.capture);
});

test('returning from exhausted context v4 to the latest accepted v3 clears obsolete debt without another request', t => {
  const { store } = fixture(t);
  const original = accepted(store, 'capture_review_budget_return');
  let latest;
  for (const version of [1, 2, 3]) {
    store.annotateCapture(original.capture.id, notes(versionedLists(version)));
    assert.equal(store.claimCapture(original.capture.id)?.id, original.capture.id);
    latest = derived(store, original.capture);
    store.finishCapture(original.capture.id, latest.result, latest.reports);
  }
  const history = store.analysisHistory(original.capture.id);
  assert.equal(history.filter(attempt => attempt.kind === 'reassessment').length, 3);
  store.annotateCapture(original.capture.id, notes(versionedLists(4)));
  assert.equal(store.claimCapture(original.capture.id), null);
  assert.equal(store.captureStatus(original.capture.id).reassessment.reason, 'reassessment_budget_exhausted');
  assert.equal(store.reassessmentPending(original.capture.id), true);

  store.annotateCapture(original.capture.id, notes(versionedLists(3)));
  assert.equal(store.reassessmentPending(original.capture.id), false);
  assert.equal(store.captureStatus(original.capture.id).state, 'accepted');
  assert.equal(store.claimCapture(original.capture.id), null);
  assert.deepEqual(store.analysisHistory(original.capture.id), history);
  assert.deepEqual(store.findings(), latest.findings);
  const refreshedNote = notes(versionedLists(3), { troubleshooting: 'Metadata refreshed after returning to the accepted list context.' });
  store.annotateCapture(original.capture.id, refreshedNote);
  const refreshed = derived(store, original.capture);
  const currentReport = store.reports().find(report => report.findingId === refreshed.findings[0].id);
  store.updateFinding(refreshed.findings[0].id, refreshed.findings[0]);
  store.reviseReport(currentReport.id, refreshed.reports[0]);
  assert.ok(store.report(currentReport.id).body.includes(refreshedNote.context.troubleshooting));
  assert.equal(store.claimCapture(original.capture.id), null);
  assert.equal(store.analysisHistory(original.capture.id).length, 4);
});

test('an explicit retry after interruption does not reset the three distinct automatic reassessment contexts', t => {
  const f = fixture(t);
  const original = accepted(f.store, 'capture_review_retry_budget');
  f.store.annotateCapture(original.capture.id, notes(versionedLists(1)));
  assert.equal(f.store.claimCapture(original.capture.id)?.id, original.capture.id);
  f.reopen().recoverInterrupted();
  assert.equal(f.store.retryCapture(original.capture.id), true);
  assert.equal(f.store.claimCapture(original.capture.id)?.id, original.capture.id);
  f.store.finishCapture(original.capture.id, { state: 'failed', reason: 'http_error', findings: [], provenance: {} });
  for (const [version, state] of [[2, 'failed'], [3, 'abstained']]) {
    f.store.annotateCapture(original.capture.id, notes(versionedLists(version)));
    assert.equal(f.store.claimCapture(original.capture.id)?.id, original.capture.id);
    f.store.finishCapture(original.capture.id, { state, reason: state === 'failed' ? 'http_error' : 'inconclusive', findings: [], provenance: {} });
  }
  f.store.annotateCapture(original.capture.id, notes(versionedLists(4)));
  assert.equal(f.store.claimCapture(original.capture.id), null);
  assert.equal(f.store.captureStatus(original.capture.id).reassessment.reason, 'reassessment_budget_exhausted');
  const history = f.store.analysisHistory(original.capture.id);
  const attempts = history.filter(attempt => attempt.kind === 'reassessment');
  assert.deepEqual(attempts.map(attempt => attempt.state), ['interrupted', 'failed', 'failed', 'abstained']);
  assert.deepEqual(attempts.map(attempt => attempt.context.lists[0].version), ['1', '1', '2', '3']);
  assert.equal(new Set(attempts.map(attempt => attempt.contextRevision)).size, 3);
  assert.deepEqual(history[0].result, original.result);
  assert.deepEqual(f.store.findings(), original.findings);
  assert.deepEqual(f.store.capture(original.capture.id), original.capture);
  assert.equal(f.store.claimReport(), null);
});

test('schema-v1 accepted evidence survives a failed reassessment and restores its original active context', t => {
  const f = fixture(t);
  const original = accepted(f.store, 'capture_review_legacy', { lists: versionedLists(0) });
  f.store.close();
  const Database = sqlite.Database ?? sqlite.DatabaseSync;
  const legacy = new Database(join(f.directory, 'observatory.sqlite'));
  try {
    // Schema v1 had neither attempt history nor an active-attempt pointer.
    legacy.exec("DROP TABLE analysis_attempts; DELETE FROM records WHERE key LIKE 'analysis-active:%'; PRAGMA user_version=1;");
  } finally { legacy.close(); }
  f.reopen();
  f.store.annotateCapture(original.capture.id, notes(versionedLists(1)));
  assert.equal(f.store.claimCapture(original.capture.id)?.id, original.capture.id);
  f.store.finishCapture(original.capture.id, { state: 'failed', reason: 'http_error', findings: [], provenance: {} });
  const history = f.store.analysisHistory(original.capture.id);
  assert.deepEqual(history.map(attempt => attempt.kind), ['legacy', 'reassessment']);
  assert.deepEqual(history.map(attempt => attempt.state), ['accepted', 'failed']);
  assert.equal(history[0].startedAt, null);
  assert.equal(history[0].annotationRevision, null);
  assert.deepEqual(history[0].result, original.result);
  assert.deepEqual(history[0].context, original.findings[0].context);
  assert.equal(history[0].reports[0].body, original.reports[0].body);
  assert.deepEqual(f.store.capture(original.capture.id), original.capture);
  assert.deepEqual(f.store.findings(), original.findings);
  assert.equal(f.store.reassessmentPending(original.capture.id), true);
  assert.equal(f.store.claimReport(), null);
  f.reopen();
  f.store.annotateCapture(original.capture.id, notes(versionedLists(0)));
  assert.equal(f.store.captureStatus(original.capture.id).state, 'accepted');
  assert.equal(f.store.reassessmentPending(original.capture.id), false);
  assert.deepEqual(f.store.captureStatus(original.capture.id).result, original.result);
  assert.deepEqual(f.store.findings(), original.findings);
  assert.deepEqual(f.store.analysisHistory(original.capture.id), history);
  assert.equal(f.store.claimCapture(original.capture.id), null);
});
