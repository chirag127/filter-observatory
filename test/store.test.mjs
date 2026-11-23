import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'filter-observatory-store-'));
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

test('captures and PNG bytes survive a close/reopen with idempotent insertion', (t) => {
  const f = fixture(t);
  const capture = captureFixture();
  assert.deepEqual(f.store.ingest(capture), { id: capture.id, state: 'queued', duplicate: false });
  assert.equal(f.store.ingest(capture).duplicate, true);
  const reopened = f.reopen();
  assert.deepEqual(reopened.capture(capture.id), capture);
  assert.equal(
    reopened
      .image(capture.id, 'viewport')
      .bytes.equals(Buffer.from(capture.images[0].dataBase64, 'base64')),
    true,
  );
  assert.equal(reopened.summary().captures.length, 1);
  assert.equal(JSON.stringify(reopened.summary()).includes('dataBase64'), false);
  assert.throws(() => reopened.ingest({ ...capture, title: 'different' }), {
    code: 'capture_conflict',
  });
  assert.equal(reopened.capture(capture.id).title, 'Example article');
});

test('exclusive capture claims prevent two workers from analyzing one item', (t) => {
  const { store } = fixture(t);
  store.ingest(captureFixture());
  const claimed = store.claimCapture();
  assert.equal(claimed.id, 'capture_fixture_01');
  assert.equal(store.claimCapture(), null);
  store.finishCapture(claimed.id, {
    state: 'accepted',
    findings: [],
    provenance: { model: 'fixture' },
  });
  assert.equal(store.captureStatus(claimed.id).state, 'accepted');
});

test('interrupted analysis stays visible and uncertain publication is never made ready automatically', (t) => {
  const f = fixture(t);
  f.store.ingest(captureFixture());
  f.store.claimCapture();
  f.store.saveReport({
    id: 'report01',
    fingerprint: 'fp01',
    state: 'ready',
    title: 'Example',
    body: 'Evidence',
    reasons: [],
  });
  assert.equal(f.store.claimReport().id, 'report01');
  f.reopen().recoverInterrupted();
  assert.equal(f.store.captureStatus('capture_fixture_01').state, 'interrupted');
  assert.equal(f.store.report('report01').state, 'uncertain');
  assert.equal(f.store.claimReport(), null);
});

test('outbox fingerprint deduplication preserves a submitted receipt', (t) => {
  const { store } = fixture(t);
  const report = {
    id: 'report01',
    fingerprint: 'same-finding',
    state: 'ready',
    reasons: [],
    body: 'First',
    title: 'Example',
  };
  store.saveReport(report);
  store.claimReport();
  store.finishReport(report.id, {
    state: 'created',
    receipt: { url: 'https://github.com/example/project/issues/1', number: 1 },
  });
  const repeated = store.saveReport({ ...report, id: 'report02', body: 'Second' });
  assert.equal(repeated.id, report.id);
  assert.equal(repeated.duplicate, true);
  assert.equal(store.report(report.id).receipt.number, 1);
  assert.equal(store.claimReport(), null);
});

test('browser journal and cross-process lease survive reopen and require the owning token', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.acquireLease('browser', 'worker-a'), true);
  assert.equal(f.store.acquireLease('browser', 'worker-b'), false);
  assert.equal(f.store.releaseLease('browser', 'worker-b'), false);
  const journal = f.store.journal('chrome-fixture');
  await journal.write({ phase: 'isolate', original: [{ id: 'adguard', enabled: true }] });
  f.reopen();
  assert.equal((await f.store.journal('chrome-fixture').read()).original[0].enabled, true);
  assert.equal(f.store.acquireLease('browser', 'worker-b'), false);
  assert.equal(f.store.releaseLease('browser', 'worker-a'), true);
  assert.equal(f.store.acquireLease('browser', 'worker-b'), true);
});

test('resumable runs retain successes and account for remaining entries', (t) => {
  const f = fixture(t);
  const corpus = {
    id: 'corpus-fixture',
    schemaVersion: 1,
    source: 'fixture',
    snapshot: 'fixed',
    errors: [],
    entries: [
      { id: 'one', rank: 1, domain: 'example.com', url: 'https://example.com/' },
      { id: 'two', rank: 2, domain: 'example.org', url: 'https://example.org/' },
    ],
  };
  const run = f.store.createRun(corpus, { compare: false });
  assert.equal(f.store.claimEntry(run.id).id, 'one');
  f.store.finishEntry(run.id, 'one', { state: 'completed', captureIds: ['capture_one'] });
  f.reopen();
  assert.equal(f.store.claimEntry(run.id).id, 'two');
  f.store.finishEntry(run.id, 'two', { state: 'failed', reason: 'navigation_failed' });
  assert.equal(f.store.claimEntry(run.id), null);
  assert.deepEqual(f.store.run(run.id).counts, {
    pending: 0,
    running: 0,
    completed: 1,
    failed: 1,
    interrupted: 0,
    cancelled: 0,
    inconclusive: 0,
  });
});

test('deferred report regeneration updates drafts but preserves uncertain and delivered remote identities', (t) => {
  const { store } = fixture(t);
  const prepared = {
    id: 'report-one',
    captureId: 'capture_fixture_01',
    fingerprint: 'first',
    state: 'deferred',
    reasons: ['metadata_missing'],
    body: 'draft',
  };
  store.saveReport(prepared);
  store.reviseReport(prepared.id, {
    ...prepared,
    fingerprint: 'second',
    body: 'complete',
    state: 'ready',
    reasons: [],
  });
  assert.equal(store.report(prepared.id).body, 'complete');
  store.claimReport();
  store.finishReport(prepared.id, { state: 'uncertain', reason: 'response_lost' });
  store.reviseReport(prepared.id, { ...prepared, state: 'ready' });
  assert.equal(store.report(prepared.id).state, 'uncertain');
  assert.equal(store.report(prepared.id).fingerprint, 'second');
  store.finishReport(prepared.id, { state: 'created', receipt: { number: 42 } });
  store.reviseReport(prepared.id, { ...prepared, state: 'ready' });
  assert.equal(store.report(prepared.id).receipt.number, 42);
});

test('context annotations remain separate from captured evidence and invalidate unsent report readiness', (t) => {
  const f = fixture(t);
  const capture = captureFixture();
  f.store.ingest(capture);
  f.store.saveReport({
    id: 'report-one',
    captureId: capture.id,
    fingerprint: 'one',
    state: 'ready',
    body: 'draft',
    reasons: [],
  });
  const note = {
    source: 'Operator settings export',
    observedAt: '2026-11-21T16:01:00.000Z',
    context: { os: { name: 'Windows', version: '11' } },
    images: [],
  };
  const receipt = f.store.annotateCapture(capture.id, note);
  assert.match(receipt.revision, /^[a-f0-9]{64}$/);
  assert.equal(f.store.claimReport(), null);
  f.reopen();
  assert.deepEqual(f.store.capture(capture.id), capture);
  assert.equal(f.store.annotations(capture.id).context.os.version, '11');
  assert.deepEqual(
    f.store.getRecord(`annotations-history:${capture.id}:${receipt.revision}`),
    note,
  );
});

test('eligible duplicate evidence upgrades the canonical unsent draft and retains its stable identity', (t) => {
  const f = fixture(t);
  const earlier = {
    id: 'earlier-report',
    fingerprint: 'same-observation',
    captureId: 'earlier-capture',
    findingId: 'earlier-finding',
    state: 'deferred',
    reasons: ['privacy-check-missing'],
    title: 'Observed advertisement',
    body: 'Incomplete evidence',
  };
  f.store.saveReport(earlier);
  const later = {
    ...earlier,
    id: 'later-report',
    captureId: 'later-capture',
    findingId: 'later-finding',
    state: 'ready',
    reasons: [],
    body: 'Complete later evidence',
  };
  const receipt = f.store.saveReport(later);
  assert.equal(receipt.id, 'earlier-report');
  f.reopen();
  assert.equal(f.store.reports().length, 1);
  assert.equal(f.store.report('earlier-report').state, 'ready');
  assert.equal(f.store.report('earlier-report').findingId, 'later-finding');
  assert.equal(f.store.report('earlier-report').captureId, 'later-capture');
  assert.equal(f.store.report('earlier-report').body, 'Complete later evidence');
  f.store.saveReport({ ...earlier, id: 'third-report' });
  assert.equal(f.store.report('earlier-report').findingId, 'later-finding');
});

test('a regenerated duplicate promotes eligible evidence without overwriting an uncertain submission', (t) => {
  const { store } = fixture(t);
  const earlier = {
    id: 'earlier-report',
    fingerprint: 'same-observation',
    findingId: 'earlier-finding',
    state: 'deferred',
    reasons: ['privacy-check-missing'],
    body: 'Incomplete',
  };
  const later = {
    id: 'later-report',
    fingerprint: 'unattributed',
    findingId: 'later-finding',
    state: 'deferred',
    reasons: ['attribution-unknown'],
    body: 'Later evidence',
  };
  store.saveReport(earlier);
  store.saveReport(later);
  store.reviseReport(later.id, {
    ...later,
    fingerprint: earlier.fingerprint,
    state: 'ready',
    reasons: [],
  });
  assert.equal(store.report(earlier.id).state, 'ready');
  assert.equal(store.report(earlier.id).findingId, 'later-finding');
  assert.equal(store.report(later.id).state, 'duplicate');
  store.claimReport();
  store.finishReport(earlier.id, { state: 'uncertain', attempt: { contentHash: 'original-hash' } });
  store.saveReport({
    ...earlier,
    id: 'new-report',
    findingId: 'new-finding',
    state: 'ready',
    reasons: [],
    body: 'New content',
  });
  assert.equal(store.report(earlier.id).state, 'uncertain');
  assert.equal(store.report(earlier.id).findingId, 'later-finding');
  assert.equal(store.report(earlier.id).attempt.contentHash, 'original-hash');
});

test('record scan retains every matching publication debt across bounded pages and reopen', (t) => {
  const f = fixture(t);
  for (const [key, value] of [
    ['image-publication:c', { state: 'uncertain', attempt: 3 }],
    ['annotations-history:one', { source: 'other namespace' }],
    ['image-publication:a', { state: 'sending', attempt: 1 }],
    ['image-publication:b', { state: 'uploaded', attempt: 2 }],
    ['image-publication-extra:a', { state: 'unrelated' }],
  ])
    f.store.setRecord(key, value);

  const first = f.store.listRecords('image-publication:', { limit: 2 });
  assert.deepEqual(first, {
    records: [
      { key: 'image-publication:a', value: { state: 'sending', attempt: 1 } },
      { key: 'image-publication:b', value: { state: 'uploaded', attempt: 2 } },
    ],
    nextCursor: 'image-publication:b',
    complete: false,
  });
  const second = f
    .reopen()
    .listRecords('image-publication:', { after: first.nextCursor, limit: 2 });
  assert.deepEqual(second, {
    records: [{ key: 'image-publication:c', value: { state: 'uncertain', attempt: 3 } }],
    nextCursor: null,
    complete: true,
  });
  assert.deepEqual(
    f.store.listRecords('image-publication:', { after: 'image-publication:c', limit: 2 }),
    {
      records: [],
      nextCursor: null,
      complete: true,
    },
  );
  const exactPage = f.store.listRecords('image-publication:', { limit: 3 });
  assert.equal(exactPage.records.length, 3);
  assert.equal(exactPage.complete, true);
  assert.equal(exactPage.nextCursor, null);
});

test('record scan treats prefix characters literally and rejects invalid page boundaries', (t) => {
  const { store } = fixture(t);
  store.setRecord('note_%:a', { retained: true });
  store.setRecord('noteXother:a', { retained: false });
  store.setRecord('NOTE_%:a', { retained: false });
  assert.deepEqual(store.listRecords('note_%:'), {
    records: [{ key: 'note_%:a', value: { retained: true } }],
    nextCursor: null,
    complete: true,
  });
  for (const limit of [0, -1, 1.5, 1001, '2']) {
    assert.throws(() => store.listRecords('note_%:', { limit }), { code: 'invalid_record_page' });
  }
  assert.throws(() => store.listRecords(''), { code: 'invalid_record_page' });
  assert.throws(() => store.listRecords('note_%:', { after: 'other:a' }), {
    code: 'invalid_record_page',
  });
  assert.throws(() => store.listRecords('note_%:', { after: null }), {
    code: 'invalid_record_page',
  });
});
