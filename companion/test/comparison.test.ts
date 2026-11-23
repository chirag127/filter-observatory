import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { comparisonObservation } from '../utils/comparison.ts';
import { CaptureQueue } from '../utils/queue.ts';
import { WorkerTransport } from '../utils/transport.ts';

const settings = { endpoint: 'http://127.0.0.1:4317', token: 'offline-test-worker-token' };

test('run activity, restoration journals, and browser leases independently indicate interference', () => {
  assert.deepEqual(comparisonObservation({ worker: { runId: 'run-1' } }), { state: 'busy' });
  assert.deepEqual(comparisonObservation({ journals: [{ name: 'browser:fixture' }] }), {
    state: 'busy',
  });
  assert.deepEqual(
    comparisonObservation({
      worker: { runId: null },
      journals: [],
      leases: [{ name: 'browser:fixture' }],
    }),
    { state: 'busy' },
  );
  assert.deepEqual(
    comparisonObservation({
      worker: { runId: null },
      journals: [],
      leases: [{ name: 'unrelated' }],
    }),
    { state: 'idle' },
  );
  for (const invalid of [null, [], {}, { worker: {} }, { worker: { runId: null } }]) {
    assert.deepEqual(comparisonObservation(invalid), { state: 'unknown' });
  }
});

test('a run completing between observations changes the revision even when both samples are idle', () => {
  const before = comparisonObservation({
    worker: { runId: null },
    journals: [],
    runs: [
      {
        id: 'run-1',
        updatedAt: '2026-11-21T01:00:00Z',
        state: 'pending',
        counts: { pending: 1, completed: 0 },
      },
    ],
  });
  const after = comparisonObservation({
    worker: { runId: null },
    journals: [],
    runs: [
      {
        id: 'run-1',
        updatedAt: '2026-11-21T01:00:01Z',
        state: 'finished',
        counts: { pending: 0, completed: 1 },
      },
    ],
  });
  assert.equal(before.state, 'idle');
  assert.equal(after.state, 'idle');
  assert.notDeepEqual(after, before);
});

test('known profile interference persists through background restart, offline state and a cleared token', async () => {
  const factory = new IDBFactory();
  const firstQueue = new CaptureQueue({ factory });
  const first = new WorkerTransport(firstQueue, async () => settings, {
    fetchImpl: async () => Response.json({ worker: { runId: 'run-1' }, journals: [] }),
  });
  await assert.rejects(first.captureEnvironment(), /comparison|restoration/);
  await firstQueue.close();

  const queue = new CaptureQueue({ factory });
  const offline = new WorkerTransport(queue, async () => settings, {
    fetchImpl: async () => {
      throw new TypeError('offline');
    },
  });
  await assert.rejects(offline.captureEnvironment(), /previously observed/);
  const unconfigured = new WorkerTransport(queue, async () => ({ ...settings, token: '' }), {
    fetchImpl: async () => {
      assert.fail('Unconfigured capture must not make a request');
    },
  });
  await assert.rejects(unconfigured.captureEnvironment(), /previously observed/);

  const recovered = new WorkerTransport(queue, async () => settings, {
    fetchImpl: async () => Response.json({ worker: { runId: null }, journals: [], runs: [] }),
  });
  await recovered.captureEnvironment();
  const unknown = await offline.captureEnvironment();
  assert.equal(unknown.revision, undefined);
  assert.ok(unknown.limitations.some((item) => item.includes('unknown')));
  await queue.close();
});

test('another worker cannot clear a retained comparison block after restart', async () => {
  const factory = new IDBFactory();
  const firstQueue = new CaptureQueue({ factory });
  const first = new WorkerTransport(firstQueue, async () => settings, {
    fetchImpl: async () => Response.json({ worker: { runId: 'run-1' }, journals: [] }),
  });
  await assert.rejects(first.captureEnvironment(), /comparison|restoration/);
  await firstQueue.close();

  const reopened = new CaptureQueue({ factory });
  const second = new WorkerTransport(
    reopened,
    async () => ({ ...settings, endpoint: 'http://127.0.0.1:4318' }),
    {
      fetchImpl: async () => Response.json({ worker: { runId: null }, journals: [], runs: [] }),
    },
  );
  await assert.rejects(second.captureEnvironment(), /previously observed|another worker/);
  const restored = new WorkerTransport(reopened, async () => settings, {
    fetchImpl: async () => Response.json({ worker: { runId: null }, journals: [], runs: [] }),
  });
  await restored.captureEnvironment();
  await second.captureEnvironment();
  await reopened.close();
});
