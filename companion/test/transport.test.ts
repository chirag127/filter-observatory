import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { CaptureQueue } from '../utils/queue.ts';
import { WorkerTransport, retryAfter } from '../utils/transport.ts';
import { sampleCapture } from './fixtures.ts';

const settings = { endpoint: 'http://127.0.0.1:4317', token: 'offline-worker-token-fixture' };
const acknowledgement = (id: string, duplicate = false) => Response.json({ id, state: 'queued', duplicate }, { status: duplicate ? 200 : 201 });

test('lost acknowledgement retries identical persisted bytes and ID after background restart', async () => {
  const factory = new IDBFactory();
  let now = 1000;
  const queue = new CaptureQueue({ factory, now: () => now });
  const original = sampleCapture();
  await queue.enqueue(original);
  const acceptedBodies: string[] = [];
  const first = new WorkerTransport(queue, async () => settings, { now: () => now,
    fetchImpl: async (url, init) => {
      assert.equal(url, `${settings.endpoint}/api/captures`);
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${settings.token}`);
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.referrerPolicy, 'no-referrer');
      acceptedBodies.push(String(init?.body));
      throw new TypeError('Connection lost after the worker committed the capture');
    } });
  assert.equal((await first.drain())?.connection, 'offline');
  await queue.close();
  now += 1000;
  const reopened = new CaptureQueue({ factory, now: () => now });
  const second = new WorkerTransport(reopened, async () => settings, { now: () => now,
    fetchImpl: async (_url, init) => {
      acceptedBodies.push(String(init?.body));
      return acknowledgement(original.id, true);
    } });
  assert.equal((await second.drain())?.connection, 'online');
  assert.deepEqual(acceptedBodies, [JSON.stringify(original), JSON.stringify(original)]);
  assert.equal((await reopened.summary()).pending, 0);
  assert.equal((await reopened.lastDelivery())?.id, original.id);
  await reopened.close();
});

for (const [status, body] of [
  [200, { id: 'wrong-capture-id', state: 'stored', duplicate: false }],
  [201, { id: sampleCapture().id, state: ['stored'], duplicate: false }],
  [201, { id: sampleCapture().id, state: 'stored' }],
  [202, { id: sampleCapture().id, state: 'stored', duplicate: false }],
] as const) {
  test(`HTTP ${status} without an exact durable acknowledgement retains the capture (${JSON.stringify(body.state)})`, async () => {
    const queue = new CaptureQueue({ factory: new IDBFactory() });
    await queue.enqueue(sampleCapture());
    const transport = new WorkerTransport(queue, async () => settings, { fetchImpl: async () => Response.json(body, { status }) });
    assert.equal((await transport.drain())?.connection, 'error');
    assert.equal((await queue.read(sampleCapture().id))?.body, JSON.stringify(sampleCapture()));
    assert.equal(await queue.lastDelivery(), undefined);
    await queue.close();
  });
}

for (const status of [401, 403, 409, 413, 422, 503]) {
  test(`HTTP ${status} records the actual failure without deleting evidence or reflecting response secrets`, async () => {
    const queue = new CaptureQueue({ factory: new IDBFactory() });
    await queue.enqueue(sampleCapture());
    const transport = new WorkerTransport(queue, async () => settings, {
      fetchImpl: async () => new Response('fixture-private-token-reflection', { status }),
    });
    const result = await transport.drain();
    assert.equal(result?.connection, status === 401 || status === 403 ? 'unauthorized' : 'error');
    assert.doesNotMatch(result!.connectionMessage, /fixture-private/);
    const retained = await queue.read(sampleCapture().id);
    assert.equal(retained?.body, JSON.stringify(sampleCapture()));
    assert.equal(retained?.blocked, [409, 413, 422].includes(status));
    await queue.close();
  });
}

test('worker Retry-After pauses every queued capture across reopen and manual retry', async () => {
  const factory = new IDBFactory();
  let now = 1000;
  const queue = new CaptureQueue({ factory, now: () => now });
  await queue.enqueue(sampleCapture());
  await queue.enqueue(sampleCapture('second-capture-123'));
  const transport = new WorkerTransport(queue, async () => settings, { now: () => now,
    fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }) });
  assert.equal((await transport.drain())?.connection, 'error');
  await queue.close();
  now = 120_000;
  const reopened = new CaptureQueue({ factory, now: () => now });
  await reopened.retryAll();
  assert.equal(await reopened.claimNext(), undefined);
  assert.equal((await reopened.summary()).nextRetryAt, new Date(121_000).toISOString());
  await reopened.close();
});

test('concurrent drain triggers share one dispatch and a missing token does not claim evidence', async () => {
  const queue = new CaptureQueue({ factory: new IDBFactory() });
  await queue.enqueue(sampleCapture());
  let configured = false;
  let calls = 0;
  const transport = new WorkerTransport(queue, async () => ({ ...settings, token: configured ? settings.token : '' }), {
    fetchImpl: async () => { calls += 1; return acknowledgement(sampleCapture().id); },
  });
  assert.equal((await transport.drain())?.connection, 'unconfigured');
  assert.equal((await queue.read(sampleCapture().id))?.attempts, 0);
  configured = true;
  await Promise.all([transport.drain(), transport.drain(), transport.drain()]);
  assert.equal(calls, 1);
  assert.equal((await queue.summary()).pending, 0);
  await queue.close();
});

test('oversized or malformed successful response cannot remove the durable payload', async () => {
  for (const body of ['invalid json', `{"padding":"${'x'.repeat(17000)}"}`]) {
    const queue = new CaptureQueue({ factory: new IDBFactory() });
    await queue.enqueue(sampleCapture());
    const transport = new WorkerTransport(queue, async () => settings, { fetchImpl: async () => new Response(body, { status: 201 }) });
    assert.equal((await transport.drain())?.connection, 'error');
    assert.equal((await queue.summary()).pending, 1);
    await queue.close();
  }
});

test('health status distinguishes unavailable worker, invalid response, rejected token, and actual health', async () => {
  const queue = new CaptureQueue({ factory: new IDBFactory() });
  for (const [response, expected] of [
    [Response.json({}), 'error'], [Response.json({ ok: false, version: '0.1.0' }), 'error'],
    [new Response('unauthorized', { status: 401 }), 'unauthorized'],
    [Response.json({ ok: true, version: '0.1.0' }), 'online'],
  ] as const) {
    const transport = new WorkerTransport(queue, async () => settings, { fetchImpl: async (url, init) => {
      assert.equal(url, `${settings.endpoint}/api/health`);
      assert.equal(init?.method, 'GET');
      return response;
    } });
    assert.equal((await transport.check()).connection, expected);
  }
  const offline = new WorkerTransport(queue, async () => settings, { fetchImpl: async () => { throw new TypeError('offline'); } });
  assert.equal((await offline.check()).connection, 'offline');
  await queue.close();
});

test('worker endpoint is validated before any authenticated request', async () => {
  const queue = new CaptureQueue({ factory: new IDBFactory() });
  const transport = new WorkerTransport(queue, async () => ({ ...settings, endpoint: 'https://remote.example' }), {
    fetchImpl: async () => { assert.fail('Token must not be sent to a non-loopback endpoint'); },
  });
  await assert.rejects(transport.check(), /http/);
  await queue.close();
});

test('Retry-After supports seconds, dates, and conservative recovery from invalid headers', () => {
  assert.equal(retryAfter('120', 1000), 121_000);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:02:00 GMT', 1000), 120_000);
  assert.equal(retryAfter(null, 1000), 61_000);
  assert.ok(retryAfter('0', 1000) > 1000);
});

test('Retry-After never shortens a valid deadline longer than a day', async () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  const deadline = now + 172_800_000;
  assert.equal(retryAfter('172800', now), deadline);
  assert.equal(retryAfter(new Date(deadline).toUTCString(), now), deadline);
  const factory = new IDBFactory();
  const queue = new CaptureQueue({ factory, now: () => now });
  await queue.enqueue(sampleCapture());
  const transport = new WorkerTransport(queue, async () => settings, { now: () => now,
    fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': '172800' } }),
  });
  await transport.drain();
  await queue.close();
  const restarted = new CaptureQueue({ factory, now: () => now + 86_400_000 });
  await restarted.retryAll();
  assert.equal(await restarted.claimNext(), undefined);
  assert.equal((await restarted.summary()).nextRetryAt, new Date(deadline).toISOString());
  assert.ok(await restarted.claimNext(deadline));
  await restarted.close();
});

test('an unrepresentable Retry-After retains evidence without an early automatic retry', async () => {
  const queue = new CaptureQueue({ factory: new IDBFactory(), now: () => 1000 });
  await queue.enqueue(sampleCapture());
  const transport = new WorkerTransport(queue, async () => settings, { now: () => 1000,
    fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': '9'.repeat(50) } }),
  });
  await transport.drain();
  await queue.retryAll();
  assert.equal(await queue.claimNext(8_000_000_000_000_000), undefined);
  const summary = await queue.summary();
  assert.equal(summary.pending, 1);
  assert.equal(summary.retryPaused, true);
  assert.equal(summary.nextRetryAt, undefined);
  await queue.close();
});

test('HTTP 503 Retry-After survives reopen and manual retry without an early dispatch', async () => {
  const factory = new IDBFactory();
  const queue = new CaptureQueue({ factory, now: () => 1000 });
  await queue.enqueue(sampleCapture());
  const transport = new WorkerTransport(queue, async () => settings, { now: () => 1000,
    fetchImpl: async () => new Response(null, { status: 503, headers: { 'Retry-After': '120' } }),
  });
  const result = await transport.drain();
  assert.equal(result?.connection, 'error');
  await queue.close();
  const reopened = new CaptureQueue({ factory, now: () => 2000 });
  try {
    await reopened.retryAll();
    assert.equal(await reopened.claimNext(), undefined);
    assert.equal((await reopened.summary()).nextRetryAt, new Date(121_000).toISOString());
    assert.ok(await reopened.claimNext(121_000));
  } finally { await reopened.close(); }
});
