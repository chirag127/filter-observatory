import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { CaptureController } from '../utils/capture.ts';
import { CaptureQueue } from '../utils/queue.ts';
import type { CapturePlatform, ObservedTab, DocumentObservation } from '../utils/capture.ts';
import type { AttributionEvent } from '../utils/attribution.ts';
import type { CaptureEnvelope } from '../utils/contracts.ts';

function fixture() {
  let listener: ((event: AttributionEvent) => void) | undefined;
  let time = 1_700_000_000_000;
  const saved: CaptureEnvelope[] = [];
  const tab: ObservedTab = {
    id: 4,
    windowId: 8,
    active: true,
    status: 'complete',
    url: 'https://example.org/',
    title: 'Example',
  };
  const doc: DocumentObservation = {
    url: tab.url!,
    title: 'Example',
    token: 'document-token',
    revision: 0,
    documentId: 'native-document',
    visible: true,
    ready: 'complete',
  };
  const platform: CapturePlatform = {
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    resolveTarget: async (invoked) => invoked ?? { ...tab },
    getTab: async () => ({ ...tab }),
    getActiveTab: async () => ({ ...tab }),
    isWindowFocused: async () => true,
    observeDocument: async () => ({ ...doc }),
    screenshot: async () => 'png-from-window-8',
    decodePng: async () => ({ dataBase64: 'trusted-decoded-png', width: 1200, height: 800 }),
    browserInfo: async () => ({ name: 'Chrome', version: '158.0', instance: 'session-1' }),
  };
  const controller = new CaptureController(
    platform,
    {
      enqueue: async (capture) => {
        saved.push(capture);
      },
    },
    { now: () => time, newId: () => 'capture-12345' },
  );
  return {
    controller,
    platform,
    saved,
    tab,
    doc,
    emit: (event: AttributionEvent) => listener?.(event),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('persists the screenshot with invoked tab/document attribution before reporting success', async () => {
  const f = fixture();
  const result = await f.controller.capture(f.tab);
  assert.deepEqual(f.saved, [result]);
  assert.deepEqual(result.tab, { id: 4, windowId: 8, documentId: 'native-document' });
  assert.equal(result.url, 'https://example.org/');
  assert.equal(result.images[0]?.width, 1200);
  assert.equal(result.source, 'companion');
  assert.equal(result.context.pageState, 'unknown');
});

for (const [name, events] of [
  [
    'activation away/back',
    [
      { kind: 'activated', tabId: 5, windowId: 8 },
      { kind: 'activated', tabId: 4, windowId: 8 },
    ],
  ],
  [
    'focus away/back',
    [
      { kind: 'focused', windowId: -1 },
      { kind: 'focused', windowId: 8 },
    ],
  ],
  ['same-URL reload', [{ kind: 'updated', tabId: 4, navigated: true }]],
  ['tab replacement', [{ kind: 'replaced', tabId: 4 }]],
] as Array<[string, AttributionEvent[]]>) {
  test(`rejects ${name} during screenshot without persisting wrong-page evidence`, async () => {
    const f = fixture();
    f.platform.screenshot = async () => {
      events.forEach(f.emit);
      return 'wrong-pixels';
    };
    await assert.rejects(f.controller.capture(f.tab), /changed/i);
    assert.deepEqual(f.saved, []);
  });
}

test('document identity change without tab events is rejected', async () => {
  const f = fixture();
  f.platform.screenshot = async () => {
    f.doc.token = 'new-document';
    return 'new-pixels';
  };
  await assert.rejects(f.controller.capture(f.tab), /document changed/i);
  assert.equal(f.saved.length, 0);
});

test('document lifecycle revision detects BFCache or hash away/back despite identical URL and ID', async () => {
  const f = fixture();
  f.platform.screenshot = async () => {
    f.doc.revision += 2;
    return 'changed-pixels';
  };
  await assert.rejects(f.controller.capture(f.tab), /document changed/i);
  assert.equal(f.saved.length, 0);
});

test('busy hotkey is rejected immediately and never queued for later capture', async () => {
  const f = fixture();
  const deferred = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  f.platform.screenshot = async () => {
    started.resolve();
    return deferred.promise;
  };
  const first = f.controller.capture(f.tab);
  await started.promise;
  await assert.rejects(f.controller.capture(f.tab), /already in progress/i);
  deferred.resolve('original-pixels');
  await first;
  assert.equal(f.saved.length, 1);
});

test('an expired preparation never takes a stale screenshot', async () => {
  const f = fixture();
  f.platform.resolveTarget = async () => {
    f.advance(2500);
    return f.tab;
  };
  f.platform.screenshot = async () => {
    assert.fail('Stale screenshot must not start');
  };
  await assert.rejects(f.controller.capture(f.tab), /expired/i);
  assert.equal(f.saved.length, 0);
});

test('offline persistence failure is a capture failure, not a saved confirmation', async () => {
  const f = fixture();
  const controller = new CaptureController(f.platform, {
    enqueue: async () => {
      throw new Error('Storage quota exceeded');
    },
  });
  await assert.rejects(controller.capture(f.tab), /quota/i);
});

test('native document ID can be absent with explicit fallback limitation', async () => {
  const f = fixture();
  delete f.doc.documentId;
  const result = await f.controller.capture(f.tab);
  assert.equal(result.tab.documentId, undefined);
  assert.ok(result.limitations.some((text) => text.includes('Native document ID unavailable')));
});

test('rapid consecutive completed captures are rejected rather than delayed', async () => {
  const f = fixture();
  await f.controller.capture(f.tab);
  await assert.rejects(f.controller.capture(f.tab), /too close/i);
  f.advance(600);
  await f.controller.capture(f.tab);
  assert.equal(f.saved.length, 2);
});

test('profile revision changes reject a completed-between-reads comparison', async () => {
  const f = fixture();
  let revision = 0;
  const controller = new CaptureController(
    f.platform,
    {
      enqueue: async (capture) => {
        f.saved.push(capture);
      },
    },
    {
      checkEnvironment: async () => ({ revision: String(revision++), limitations: [] }),
    },
  );
  await assert.rejects(controller.capture(f.tab), /comparison state changed/);
  assert.equal(f.saved.length, 0);
});

test('tab changes during a slow worker preflight cannot select a later screenshot', async () => {
  const f = fixture();
  const controller = new CaptureController(
    f.platform,
    {
      enqueue: async (capture) => {
        f.saved.push(capture);
      },
    },
    {
      checkEnvironment: async () => {
        f.emit({ kind: 'activated', tabId: 5, windowId: 8 });
        f.emit({ kind: 'activated', tabId: 4, windowId: 8 });
        return { limitations: [] };
      },
    },
  );
  f.platform.screenshot = async () => {
    assert.fail('A preflight wait must never retarget capture');
  };
  await assert.rejects(controller.capture(f.tab), /changed/);
  assert.equal(f.saved.length, 0);
});

for (const stage of ['observation', 'screenshot'] as const) {
  test(`a stalled ${stage} expires, releases capture, and cannot persist a late result`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<DocumentObservation & string>();
    const original = stage === 'observation' ? f.platform.observeDocument : f.platform.screenshot;
    if (stage === 'observation')
      f.platform.observeDocument = async () => {
        entered.resolve();
        return stalled.promise;
      };
    else
      f.platform.screenshot = async () => {
        entered.resolve();
        return stalled.promise;
      };
    const first = f.controller.capture(f.tab);
    const rejected = assert.rejects(first, /timed out/i);
    await entered.promise;
    f.advance(8001);
    t.mock.timers.tick(8001);
    await rejected;
    if (stage === 'observation')
      f.platform.observeDocument = original as CapturePlatform['observeDocument'];
    else f.platform.screenshot = original as CapturePlatform['screenshot'];
    await f.controller.capture(f.tab);
    stalled.resolve(
      (stage === 'observation' ? { ...f.doc } : 'late-pixels') as DocumentObservation & string,
    );
    await Promise.resolve();
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0]?.images[0]?.dataBase64, 'trusted-decoded-png');
  });
}

test('same-URL history growth rejects capture even without navigation events', async () => {
  const f = fixture();
  f.doc.historyLength = 1;
  f.doc.navigationTracked = false;
  f.platform.screenshot = async () => {
    f.doc.historyLength = 2;
    return 'new-state-pixels';
  };
  await assert.rejects(f.controller.capture(f.tab), /document changed/);
  assert.equal(f.saved.length, 0);
});

test('a committed capture stays saved when the deadline fires before its completion handler', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const queue = new CaptureQueue({ factory: new IDBFactory() });
  const originalTransaction = IDBDatabase.prototype.transaction;
  let committed = false;
  t.mock.method(
    IDBDatabase.prototype,
    'transaction',
    function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const tx = originalTransaction.apply(this, args);
      if (args[1] === 'readwrite' && tx.objectStoreNames.contains('payloads')) {
        tx.addEventListener(
          'complete',
          () => {
            committed = true;
            f.advance(8001);
            t.mock.timers.tick(8001);
          },
          { once: true },
        );
      }
      return tx;
    },
  );
  const controller = new CaptureController(f.platform, queue, {
    newId: () => 'capture-commit-race',
  });
  try {
    const saved = await controller.capture(f.tab);
    assert.equal(committed, true);
    assert.equal((await queue.read(saved.id))?.id, saved.id);
    assert.equal((await queue.lastCapture())?.state, 'saved');
  } finally {
    await queue.close();
  }
});
