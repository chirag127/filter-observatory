import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { CaptureQueue } from '../utils/queue.ts';
import { sampleCapture } from './fixtures.ts';

test('capture bytes and ID survive connection closure and a fresh queue instance', async () => {
  const factory = new IDBFactory();
  const capture = sampleCapture();
  const first = new CaptureQueue({ factory });
  await first.enqueue(capture);
  capture.title = 'Mutated caller data';
  await first.close();
  const reopened = new CaptureQueue({ factory });
  const stored = await reopened.claimNext();
  assert.equal(stored?.id, 'capture-durable-123');
  assert.equal(JSON.parse(stored!.body).title, 'Example');
  assert.equal((await reopened.summary()).pending, 1);
  await reopened.close();
});

test('a simulated crash after claim retains identical payload and persisted retry backoff', async () => {
  const factory = new IDBFactory();
  let now = 1000;
  const queue = new CaptureQueue({ factory, now: () => now });
  await queue.enqueue(sampleCapture());
  const firstAttempt = await queue.claimNext();
  await queue.close();
  const restarted = new CaptureQueue({ factory, now: () => now });
  assert.equal(await restarted.claimNext(), undefined);
  now = 2000;
  const retry = await restarted.claimNext();
  assert.equal(retry?.body, firstAttempt?.body);
  assert.equal(retry?.id, firstAttempt?.id);
  assert.equal(retry?.attempts, 2);
  await restarted.close();
});

test('only an exact acknowledged capture is removed and its receipt is durable', async () => {
  const factory = new IDBFactory();
  const queue = new CaptureQueue({ factory });
  const capture = sampleCapture();
  await queue.enqueue(capture);
  for (const bad of [{ id: 'other-id', state: 'stored', duplicate: false }, { id: capture.id, state: 'done', duplicate: false },
    { id: capture.id, state: ['stored'], duplicate: false }, { id: capture.id, state: 'stored' }]) {
    await assert.rejects(queue.acknowledge(capture.id, bad), /acknowledgement/);
    assert.equal((await queue.read(capture.id))?.body, JSON.stringify(capture));
  }
  await queue.acknowledge(capture.id, { id: capture.id, state: 'stored', duplicate: true });
  await queue.close();
  const restarted = new CaptureQueue({ factory });
  assert.equal(await restarted.read(capture.id), undefined);
  assert.equal((await restarted.summary()).pending, 0);
  assert.equal((await restarted.lastDelivery())?.id, capture.id);
  await restarted.close();
});

test('same-ID changes and queue capacity errors preserve last-known-good evidence', async () => {
  const queue = new CaptureQueue({ factory: new IDBFactory(), maxEntries: 1 });
  const capture = sampleCapture();
  await queue.enqueue(capture);
  await queue.enqueue(capture);
  await assert.rejects(queue.enqueue({ ...capture, title: 'Different evidence' }), /conflict/i);
  await assert.rejects(queue.enqueue(sampleCapture('capture-other-123')), /full/i);
  assert.equal((await queue.read(capture.id))?.body, JSON.stringify(capture));
  assert.equal((await queue.summary()).pending, 1);
  await queue.close();
});

test('rejected captures stay durable without blocking other captures', async () => {
  let now = 1000;
  const queue = new CaptureQueue({ factory: new IDBFactory(), now: () => now });
  const rejected = sampleCapture('capture-a-rejected');
  await queue.enqueue(rejected);
  await queue.enqueue(sampleCapture('capture-b-valid'));
  await queue.fail(rejected.id, 'Worker reports an ID conflict.', { blocked: true });
  assert.equal((await queue.claimNext())?.id, 'capture-b-valid');
  assert.equal((await queue.summary()).blocked, 1);
  assert.ok(await queue.read(rejected.id));
  await queue.retryAll();
  now += 1000;
  assert.equal((await queue.claimNext())?.id, rejected.id);
  await queue.close();
});

test('server rate-limit pause persists across queue reopen and cannot be bypassed by manual retry', async () => {
  const factory = new IDBFactory();
  const queue = new CaptureQueue({ factory, now: () => 1000 });
  await queue.enqueue(sampleCapture());
  await queue.pauseUntil(61_000);
  await queue.close();
  const reopened = new CaptureQueue({ factory, now: () => 2000 });
  await reopened.retryAll();
  assert.equal(await reopened.claimNext(), undefined);
  assert.equal((await reopened.summary()).nextRetryAt, new Date(61_000).toISOString());
  assert.ok(await reopened.claimNext(61_000));
  await reopened.close();
});

test('concurrent queue instances cannot claim an item in the same retry interval', async () => {
  const factory = new IDBFactory();
  const one = new CaptureQueue({ factory, now: () => 1000 });
  const two = new CaptureQueue({ factory, now: () => 1000 });
  await one.enqueue(sampleCapture());
  const attempts = await Promise.all([one.claimNext(), two.claimNext()]);
  assert.equal(attempts.filter(Boolean).length, 1);
  await Promise.all([one.close(), two.close()]);
});

test('saved capture status is committed alongside the evidence and survives restart', async () => {
  const factory = new IDBFactory();
  const queue = new CaptureQueue({ factory });
  await queue.enqueue(sampleCapture());
  await queue.close();
  const reopened = new CaptureQueue({ factory });
  assert.equal((await reopened.lastCapture())?.state, 'saved');
  assert.equal((await reopened.lastCapture())?.at, sampleCapture().capturedAt);
  await reopened.recordCaptureError('Capture target changed.', '2026-11-21T01:00:00.000Z');
  assert.equal((await reopened.lastCapture())?.state, 'error');
  assert.equal((await reopened.summary()).pending, 1);
  await reopened.close();
});

test('cancelling after a successful payload write aborts the whole capture transaction', async (t) => {
  const factory = new IDBFactory();
  const queue = new CaptureQueue({ factory });
  const abort = new AbortController();
  const originalAdd = IDBObjectStore.prototype.add;
  let payloadWritten = false;
  t.mock.method(IDBObjectStore.prototype, 'add', function (this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['add']>) {
    const request = originalAdd.apply(this, args);
    if (this.name === 'payloads') request.addEventListener('success', () => {
      payloadWritten = true;
      abort.abort(new Error('Capture cancelled before commit'));
    }, { once: true });
    return request;
  });
  await assert.rejects(queue.enqueue(sampleCapture(), abort.signal), /cancelled before commit/);
  assert.equal(payloadWritten, true, 'The rollback must happen after request success, before transaction completion');
  await queue.close();
  const reopened = new CaptureQueue({ factory });
  assert.equal(await reopened.read(sampleCapture().id), undefined);
  assert.equal((await reopened.summary()).pending, 0);
  assert.equal(await reopened.lastCapture(), undefined);
  await reopened.close();
});
