import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import type { Browser, WxtBrowser } from 'wxt/browser';
import { startBackground, CAPTURE_COMMAND, DELIVERY_ALARM } from '../utils/background.ts';
import type { CapturePlatform, ObservedTab } from '../utils/capture.ts';
import type { UiReply } from '../utils/contracts.ts';
import { CaptureQueue } from '../utils/queue.ts';
import { SETTINGS_KEY } from '../utils/settings.ts';
import { pngBase64, sampleCapture } from './fixtures.ts';

class Event<Args extends unknown[]> {
  listeners = new Set<(...args: Args) => unknown>();
  addListener = (listener: (...args: Args) => unknown) => {
    this.listeners.add(listener);
  };
  removeListener = (listener: (...args: Args) => unknown) => {
    this.listeners.delete(listener);
  };
  async emit(...args: Args) {
    return Promise.all([...this.listeners].map((listener) => listener(...args)));
  }
}

function fixture(
  t: TestContext,
  queue = new CaptureQueue({ factory: new IDBFactory() }),
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const base = `chrome-extension://${id}`;
  const local: Record<string, unknown> = {};
  const trace: string[] = [];
  const command = new Event<[string, Browser.tabs.Tab?]>();
  const message = new Event<[unknown, Browser.runtime.MessageSender, (reply: UiReply) => void]>();
  const alarm = new Event<[Browser.alarms.Alarm]>();
  const startup = new Event<[]>();
  const installed = new Event<[]>();
  const createdAlarms: Array<{ name: string; info: unknown }> = [];
  const api = {
    runtime: {
      id,
      getURL: (path: string) => `${base}${path}`,
      onMessage: message,
      onStartup: startup,
      onInstalled: installed,
      sendMessage: async () => {
        trace.push('status-ui');
      },
    },
    commands: {
      onCommand: command,
      getAll: async () => [{ name: CAPTURE_COMMAND, shortcut: 'Ctrl+Shift+8' }],
    },
    alarms: {
      onAlarm: alarm,
      create: async (name: string, info: unknown) => {
        createdAlarms.push({ name, info });
      },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: structuredClone(local[key]) }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(local, structuredClone(values));
        },
        setAccessLevel: async () => {},
      },
    },
    action: {
      setBadgeText: async () => {
        trace.push('badge-ui');
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  } as unknown as WxtBrowser;
  const tab: ObservedTab = {
    id: 4,
    windowId: 8,
    active: true,
    status: 'complete',
    url: 'https://example.org/',
  };
  const platform: CapturePlatform = {
    subscribe() {
      trace.push('guards-armed');
      return () => {};
    },
    resolveTarget: async () => tab,
    getTab: async () => tab,
    getActiveTab: async () => tab,
    isWindowFocused: async () => true,
    observeDocument: async () => ({
      url: tab.url!,
      title: 'Page',
      token: 'document-token',
      documentId: 'document-native',
      revision: 0,
      ready: 'complete',
      visible: true,
    }),
    screenshot: async () => {
      trace.push('screenshot');
      return `data:image/png;base64,${pngBase64}`;
    },
    decodePng: async () => ({ dataBase64: pngBase64, width: 1, height: 1 }),
    browserInfo: async () => ({ name: 'Chrome', version: '158.0' }),
  };
  const background = startBackground(api, 'chrome', {
    queue,
    platform,
    fetchImpl:
      options.fetchImpl ??
      (async () => {
        throw new TypeError('Offline fixture');
      }),
    now: options.now,
  });
  t.after(async () => {
    background.dispose();
    await queue.close();
  });
  async function request(body: unknown, page = 'popup'): Promise<UiReply | undefined> {
    let resolve!: (reply: UiReply | undefined) => void;
    const reply = new Promise<UiReply | undefined>((done) => {
      resolve = done;
    });
    const accepted = await message.emit(
      body,
      { id, url: `${base}/${page}.html`, frameId: 0 },
      resolve,
    );
    if (!accepted.includes(true)) resolve(undefined);
    return reply;
  }
  return {
    api,
    background,
    queue,
    tab,
    platform,
    trace,
    command,
    alarm,
    startup,
    installed,
    message,
    request,
    local,
    createdAlarms,
  };
}

test('a named hotkey captures and commits before UI feedback; popup reports the actual assigned shortcut', async (t) => {
  const f = fixture(t);
  await f.background.ready;
  f.trace.length = 0;
  await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  const reply = await f.request({ type: 'status' });
  assert.equal(reply?.ok, true);
  assert.equal(reply?.status?.capture.state, 'saved');
  assert.equal(reply?.status?.queue.pending, 1);
  assert.equal(reply?.status?.connection, 'unconfigured');
  assert.equal(reply?.status?.shortcut, 'Ctrl+Shift+8');
  assert.equal(f.trace[0], 'guards-armed');
  assert.ok(f.trace.indexOf('screenshot') < f.trace.indexOf('badge-ui'));
  assert.ok(f.trace.indexOf('screenshot') < f.trace.indexOf('status-ui'));
  assert.ok(f.createdAlarms.some((item) => item.name === DELIVERY_ALARM));
  const saved = await f.queue.claimNext();
  assert.equal(JSON.parse(saved!.body).images[0].dataBase64, pngBase64);
  assert.equal(JSON.parse(saved!.body).tab.id, 4);
});

test('background capture does not wait for worker connectivity or queue-delivery initialization', async (t) => {
  const f = fixture(t);
  const shot = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  f.platform.screenshot = async () => {
    started.resolve();
    return shot.promise;
  };
  const first = f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  await started.promise;
  await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  assert.equal(f.trace.includes('badge-ui'), false);
  assert.equal(f.trace.includes('status-ui'), false);
  shot.resolve(`data:image/png;base64,${pngBase64}`);
  await first;
  assert.equal((await f.queue.summary()).pending, 1);
});

test('settings and alarm retry use the same durable queue, and status never returns the worker token', async (t) => {
  const f = fixture(t);
  await f.background.ready;
  const settings = { endpoint: 'http://127.0.0.1:4317', token: 'fixture-worker-token-only' };
  assert.equal(await f.request({ type: 'settings:get' }), undefined);
  const saved = await f.request({ type: 'settings:save', settings }, 'options');
  assert.equal(saved?.ok, true);
  assert.deepEqual(f.local[SETTINGS_KEY], settings);
  assert.deepEqual((await f.request({ type: 'settings:get' }, 'options'))?.settings, settings);
  await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  await f.alarm.emit({
    name: DELIVERY_ALARM,
    scheduledTime: Date.now(),
    persistAcrossSessions: true,
  });
  const status = await f.request({ type: 'status' });
  assert.equal(status?.status?.queue.pending, 1);
  assert.equal(status?.status?.connection, 'offline');
  assert.equal(JSON.stringify(status).includes(settings.token), false);
  assert.equal(await f.request({ type: 'capture' }), undefined);
  f.background.dispose();
  assert.equal(f.command.listeners.size, 0);
  assert.equal(f.message.listeners.size, 0);
});

test('a transient startup storage failure does not permanently disable status and settings recovery', async (t) => {
  class RecoveringQueue extends CaptureQueue {
    failOnce = true;
    override async summary() {
      if (this.failOnce) {
        this.failOnce = false;
        throw new Error('Temporary IndexedDB failure');
      }
      return super.summary();
    }
  }
  const f = fixture(t, new RecoveringQueue({ factory: new IDBFactory() }));
  await f.background.ready.catch(() => {});
  const reply = await f.request({ type: 'status' });
  assert.equal(reply?.ok, true);
  assert.equal(reply?.status?.queue.pending, 0);
  const saved = await f.request(
    { type: 'settings:save', settings: { endpoint: 'http://127.0.0.1:4317', token: '' } },
    'options',
  );
  assert.equal(saved?.ok, true);
});

for (const activity of [
  { worker: { runId: 'comparison-running' }, journals: [] },
  {
    worker: { runId: null },
    journals: [{ name: 'browser:fixture', snapshot: { stage: 'restore-pending' } }],
  },
]) {
  test(`a ${activity.worker.runId ? 'running comparison' : 'pending restoration'} rejects the gesture before any screenshot`, async (t) => {
    const f = fixture(t, undefined, { fetchImpl: async () => Response.json(activity) });
    await f.background.ready;
    f.local[SETTINGS_KEY] = {
      endpoint: 'http://127.0.0.1:4317',
      token: 'fixture-worker-token-only',
    };
    f.trace.length = 0;
    await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
    const reply = await f.request({ type: 'status' });
    assert.equal(f.trace.includes('screenshot'), false);
    assert.equal(reply?.status?.capture.state, 'error');
    assert.match(reply!.status!.capture.message, /comparison|restor/i);
    assert.equal((await f.queue.summary()).pending, 0);
  });
}

test('a comparison starting during capture discards its pixels instead of labeling them installed-state evidence', async (t) => {
  let running = false;
  const f = fixture(t, undefined, {
    fetchImpl: async () =>
      Response.json({ worker: { runId: running ? 'comparison-new' : null }, journals: [] }),
  });
  await f.background.ready;
  f.local[SETTINGS_KEY] = { endpoint: 'http://127.0.0.1:4317', token: 'fixture-worker-token-only' };
  f.platform.screenshot = async () => {
    running = true;
    return `data:image/png;base64,${pngBase64}`;
  };
  await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  const reply = await f.request({ type: 'status' });
  assert.equal(reply?.status?.capture.state, 'error');
  assert.equal((await f.queue.summary()).pending, 0);
});

test('a known comparison block survives a later offline state without taking a delayed screenshot', async (t) => {
  let online = true;
  let now = 1000;
  const f = fixture(t, undefined, {
    now: () => now,
    fetchImpl: async () => {
      if (!online) throw new TypeError('Worker offline after profile mutation');
      return Response.json({ worker: { runId: 'comparison-running' }, journals: [] });
    },
  });
  await f.background.ready;
  f.local[SETTINGS_KEY] = { endpoint: 'http://127.0.0.1:4317', token: 'fixture-worker-token-only' };
  await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  online = false;
  now += 1000;
  f.trace.length = 0;
  await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  assert.equal(f.trace.includes('screenshot'), false);
  assert.equal((await f.queue.summary()).pending, 0);
});

for (const action of ['retry', 'settings:save'] as const) {
  test(`${action} cannot be undone by an older in-flight delivery rejection`, async (t) => {
    let now = 1000;
    const queue = new CaptureQueue({ factory: new IDBFactory(), now: () => now });
    const started = Promise.withResolvers<void>();
    const oldResponse = Promise.withResolvers<Response>();
    const sent: Array<{ endpoint: string; body: string }> = [];
    const f = fixture(t, queue, {
      now: () => now,
      fetchImpl: async (url, init) => {
        if (init?.method !== 'POST')
          return Response.json({
            ok: true,
            version: '0.1.0',
            worker: { runId: null },
            journals: [],
            runs: [],
          });
        sent.push({ endpoint: String(url), body: String(init.body) });
        if (sent.length === 1) {
          started.resolve();
          return oldResponse.promise;
        }
        return Response.json(
          { id: sampleCapture().id, state: 'stored', duplicate: false },
          { status: 201 },
        );
      },
    });
    await f.background.ready;
    f.local[SETTINGS_KEY] = {
      endpoint: 'http://127.0.0.1:4317',
      token: 'fixture-worker-token-only',
    };
    await queue.enqueue(sampleCapture());
    const delivery = f.alarm.emit({
      name: DELIVERY_ALARM,
      scheduledTime: now,
      persistAcrossSessions: true,
    });
    await started.promise;
    now += 1000;
    const reset = f.request(
      action === 'retry'
        ? { type: 'retry' }
        : {
            type: 'settings:save',
            settings: { endpoint: 'http://127.0.0.1:4318', token: 'fixture-updated-worker-token' },
          },
      action === 'retry' ? 'popup' : 'options',
    );
    // A public status reply lets the reset handler reach its first storage operation.
    await f.request({ type: 'status' });
    oldResponse.resolve(new Response(null, { status: 409 }));
    await Promise.all([delivery, reset]);
    await f.alarm.emit({ name: DELIVERY_ALARM, scheduledTime: now, persistAcrossSessions: true });
    assert.equal((await queue.summary()).blocked, 0);
    assert.equal((await queue.summary()).pending, 0);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.body, sent[1]?.body);
    assert.equal(
      sent[1]?.endpoint,
      `http://127.0.0.1:${action === 'retry' ? 4317 : 4318}/api/captures`,
    );
  });
}

test('changing connection during capture rejects evidence from mixed worker observations', async (t) => {
  const shot = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  const checked: string[] = [];
  const f = fixture(t, undefined, {
    fetchImpl: async (url) => {
      checked.push(String(url));
      return Response.json({
        ok: true,
        version: '0.1.0',
        worker: { runId: null },
        journals: [],
        runs: [],
      });
    },
  });
  await f.background.ready;
  f.local[SETTINGS_KEY] = { endpoint: 'http://127.0.0.1:4317', token: 'fixture-worker-token-only' };
  f.platform.screenshot = async () => {
    started.resolve();
    return shot.promise;
  };
  const capture = f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  await started.promise;
  const saved = await f.request(
    {
      type: 'settings:save',
      settings: {
        endpoint: 'http://127.0.0.1:4318',
        token: 'fixture-updated-worker-token',
      },
    },
    'options',
  );
  assert.equal(saved?.ok, true);
  shot.resolve(`data:image/png;base64,${pngBase64}`);
  await capture;
  const result = await f.request({ type: 'status' });
  assert.equal(result?.status?.capture.state, 'error');
  assert.match(result!.status!.capture.message, /connection changed/i);
  assert.equal((await f.queue.summary()).pending, 0);
  assert.equal(checked.includes('http://127.0.0.1:4318/api/state'), false);
});

test('stalled error persistence neither holds the capture gate nor overwrites a newer saved capture', async (t) => {
  const recording = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const recorded = Promise.withResolvers<void>();
  class DelayedErrorQueue extends CaptureQueue {
    override async recordCaptureError(message: string, at?: string, signal?: AbortSignal) {
      recording.resolve();
      await resume.promise;
      try {
        await super.recordCaptureError(message, at, signal);
      } finally {
        recorded.resolve();
      }
    }
  }
  let now = 1000;
  const queue = new DelayedErrorQueue({ factory: new IDBFactory(), now: () => now });
  const f = fixture(t, queue, { now: () => now });
  await f.background.ready;
  const screenshot = f.platform.screenshot;
  f.platform.screenshot = async () => {
    throw new Error('Viewport unavailable');
  };
  const first = f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
  await recording.promise;
  try {
    now += 1000;
    f.platform.screenshot = screenshot;
    await f.command.emit(CAPTURE_COMMAND, f.tab as Browser.tabs.Tab);
    const reply = await f.request({ type: 'status' });
    assert.equal(reply?.status?.capture.state, 'saved');
    assert.equal(reply?.status?.queue.pending, 1);
  } finally {
    resume.resolve();
    await Promise.all([first, recorded.promise]);
  }
  assert.equal((await queue.lastCapture())?.state, 'saved');
});
