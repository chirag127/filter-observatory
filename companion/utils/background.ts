import type { Browser, WxtBrowser } from 'wxt/browser';
import type { CapturePlatform } from './capture.ts';
import type { CompanionStatus, ConnectionSettings, UiReply, UiRequest } from './contracts.ts';
import { CaptureController } from './capture.ts';
import { createBrowserPlatform, observedTab } from './browser-platform.ts';
import { permittedUiRequest } from './messages.ts';
import { CaptureQueue } from './queue.ts';
import { readSettings, saveSettings } from './settings.ts';
import { WorkerTransport } from './transport.ts';
import type { ConnectionResult } from './transport.ts';

export const CAPTURE_COMMAND = 'capture-evidence';
export const DELIVERY_ALARM = 'capture-delivery-v1';

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 512)
    : 'The companion could not complete this operation. Try again.';
}

export function startBackground(
  api: WxtBrowser,
  targetBrowser: 'chrome' | 'firefox',
  options: {
    queue?: CaptureQueue;
    platform?: CapturePlatform;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const queue = options.queue ?? new CaptureQueue({ now });
  const transport = new WorkerTransport(queue, () => readSettings(api.storage.local), {
    fetchImpl: options.fetchImpl,
    now,
  });
  const controller = new CaptureController(
    options.platform ?? createBrowserPlatform(api, targetBrowser),
    queue,
    { now },
  );
  const popupUrl = api.runtime.getURL('/popup.html');
  const optionsUrl = api.runtime.getURL('/options.html');
  let connection: ConnectionResult = {
    connection: 'checking',
    connectionMessage: 'Reading the local worker connection.',
  };
  let capture: CompanionStatus['capture'] | undefined;
  let capturing = false;
  let disposed = false;
  let settingsRevision = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let delivery: Promise<void> | undefined;
  let resetting = 0;
  let resetTail: Promise<void> = Promise.resolve();
  let errorRecording: AbortController | undefined;

  function recordCaptureFailure(message: string, at: string): void {
    const abort = new AbortController();
    errorRecording = abort;
    const timer = setTimeout(
      () => abort.abort(new Error('Capture error recording timed out.')),
      2000,
    );
    void queue
      .recordCaptureError(message, at, abort.signal)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        if (errorRecording === abort) errorRecording = undefined;
      });
  }

  async function snapshot(): Promise<CompanionStatus> {
    const [settings, summary, lastCapture, lastDelivery, commands] = await Promise.all([
      readSettings(api.storage.local),
      queue.summary(),
      queue.lastCapture(),
      queue.lastDelivery(),
      api.commands.getAll(),
    ]);
    return {
      ...connection,
      endpoint: settings.endpoint,
      configured: Boolean(settings.token),
      ...(!settings.token
        ? {
            connection: 'unconfigured' as const,
            connectionMessage: 'Add your local worker token in connection settings.',
          }
        : {}),
      queue: summary,
      shortcut: commands.find((item) => item.name === CAPTURE_COMMAND)?.shortcut ?? '',
      browser: targetBrowser,
      capture: capture ??
        lastCapture ?? {
          state: 'idle',
          message: 'No capture recorded. Use the assigned shortcut on a website.',
        },
      ...(lastDelivery ? { lastDelivery } : {}),
    };
  }

  async function publish(): Promise<void> {
    if (disposed || capturing) return;
    const state = await snapshot();
    if (disposed || capturing) return;
    const action = api.action ?? api.browserAction;
    const waiting = state.queue.pending + state.queue.blocked;
    const problem =
      state.capture.state === 'error' ||
      state.queue.blocked > 0 ||
      ['error', 'unauthorized'].includes(state.connection);
    if (action) {
      await Promise.all([
        action.setBadgeText({ text: problem ? '!' : waiting ? String(waiting) : '' }),
        action.setBadgeBackgroundColor({ color: problem ? '#962d35' : '#174d7d' }),
        action.setTitle({
          title: problem
            ? 'Filter Observatory: open for error details'
            : `Filter Observatory: ${waiting} capture${waiting === 1 ? '' : 's'} awaiting delivery`,
        }),
      ]);
    }
    await api.runtime.sendMessage({ type: 'status:changed' }).catch(() => {});
  }

  async function failure(error: unknown): Promise<void> {
    connection = { connection: 'error', connectionMessage: messageOf(error) };
    await publish().catch(() => {});
  }

  async function scheduleRetry(): Promise<void> {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (disposed) return;
    const [summary, settings] = await Promise.all([
      queue.summary(),
      readSettings(api.storage.local),
    ]);
    if (disposed || resetting || summary.retryPaused || !summary.pending || !settings.token) return;
    const delay = Math.max(
      1000,
      summary.nextRetryAt ? Date.parse(summary.nextRetryAt) - now() : 1000,
    );
    // Short wakeups improve draining; the persisted one-minute alarm recovers from suspension.
    if (delay < 25_000)
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void deliver().catch(failure);
      }, delay);
  }

  function deliver(): Promise<void> {
    if (disposed || resetting) return Promise.resolve();
    if (delivery) return delivery;
    const revision = settingsRevision;
    const operation = (async () => {
      await ready;
      const result = await transport.drain();
      if (result && revision === settingsRevision) connection = result;
      await publish();
      await scheduleRetry();
    })();
    delivery = operation;
    void operation
      .finally(() => {
        if (delivery === operation) delivery = undefined;
      })
      .catch(() => {});
    return operation;
  }

  function resetPending(save?: () => Promise<void>): Promise<void> {
    resetting += 1;
    const operation = resetTail.then(async () => {
      // Let the old dispatch commit its outcome before making captures eligible again.
      await delivery?.catch(() => {});
      if (save) await save();
      await queue.retryAll();
    });
    resetTail = operation.catch(() => {});
    return operation.finally(() => {
      resetting -= 1;
      if (!resetting) void deliver().catch(failure);
    });
  }

  async function checkConnection(): Promise<void> {
    const revision = settingsRevision;
    connection = { connection: 'checking', connectionMessage: 'Checking the local worker.' };
    const result = await transport.check();
    if (revision === settingsRevision) connection = result;
  }

  async function command(name: string, tab?: Browser.tabs.Tab): Promise<void> {
    if (name !== CAPTURE_COMMAND || disposed) return;
    if (capturing) {
      capture = {
        state: 'capturing',
        message: 'A capture is in progress. Additional gestures are not queued.',
      };
      return;
    }
    errorRecording?.abort(new Error('A newer capture superseded this error.'));
    errorRecording = undefined;
    capturing = true;
    capture = { state: 'capturing', message: 'Capturing the invoked page.' };
    const revision = settingsRevision;
    let connectionSettings: Promise<ConnectionSettings> | undefined;
    const unchangedConnection = () => {
      if (revision !== settingsRevision)
        throw new Error(
          'Worker connection changed during capture. Capture again with the saved connection.',
        );
    };
    try {
      // Start immediately: the controller arms attribution guards before its first await.
      const saved = await controller.capture(tab ? observedTab(tab) : undefined, async (signal) => {
        unchangedConnection();
        connectionSettings ??= readSettings(api.storage.local);
        const pinned = await connectionSettings;
        unchangedConnection();
        const environment = await transport.captureEnvironment(signal, pinned);
        unchangedConnection();
        return environment;
      });
      capture = {
        state: 'saved',
        message: 'Viewport saved to the local delivery queue.',
        at: saved.capturedAt,
      };
    } catch (error) {
      capture = { state: 'error', message: messageOf(error), at: new Date(now()).toISOString() };
      recordCaptureFailure(capture.message, capture.at!);
    } finally {
      capturing = false;
    }
    await publish().catch(failure);
    void deliver().catch(failure);
  }

  async function request(message: UiRequest): Promise<UiReply> {
    await ready;
    if (message.type === 'settings:get')
      return {
        ok: true,
        settings: await readSettings(api.storage.local),
        status: await snapshot(),
      };
    if (message.type === 'settings:save') {
      await resetPending(async () => {
        settingsRevision += 1;
        try {
          await saveSettings(api.storage.local, message.settings);
        } finally {
          settingsRevision += 1;
        }
        connection = {
          connection: 'error',
          connectionMessage: 'Connection saved locally. Use Check connection to verify the worker.',
        };
      });
      await publish();
      void deliver().catch(failure);
    } else if (message.type === 'check') {
      await checkConnection();
      await publish();
    } else if (message.type === 'retry') {
      await resetPending();
      await deliver();
    }
    return { ok: true, status: await snapshot() };
  }

  const onMessage = (
    message: unknown,
    sender: Browser.runtime.MessageSender,
    sendResponse: (reply: UiReply) => void,
  ) => {
    if (!permittedUiRequest(message, sender, api.runtime.id, popupUrl, optionsUrl)) return false;
    void request(message).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: messageOf(error) }),
    );
    return true;
  };
  const onAlarm = (alarm: Browser.alarms.Alarm) => {
    if (alarm.name === DELIVERY_ALARM) return deliver().catch(failure);
  };
  const onStartup = () => {
    void ready.then(() => deliver()).catch(failure);
  };
  const onInstalled = () => {
    void ready.then(() => deliver()).catch(failure);
  };
  api.commands.onCommand.addListener(command);
  api.runtime.onMessage.addListener(onMessage);
  api.alarms.onAlarm.addListener(onAlarm);
  api.runtime.onStartup.addListener(onStartup);
  api.runtime.onInstalled.addListener(onInstalled);

  const ready = (async () => {
    if (targetBrowser === 'chrome' && api.storage.local.setAccessLevel) {
      await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
    await api.alarms.create(DELIVERY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    await checkConnection();
    await publish();
  })().catch(failure);
  void ready.then(() => deliver()).catch(failure);

  return {
    ready,
    dispose() {
      disposed = true;
      errorRecording?.abort(new Error('Companion background stopped.'));
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      api.commands.onCommand.removeListener(command);
      api.runtime.onMessage.removeListener(onMessage);
      api.alarms.onAlarm.removeListener(onAlarm);
      api.runtime.onStartup.removeListener(onStartup);
      api.runtime.onInstalled.removeListener(onInstalled);
    },
  };
}
