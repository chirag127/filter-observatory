import { AttributionGuard } from './attribution.ts';
import type { AttributionEvent, CaptureTarget } from './attribution.ts';
import type { CaptureEnvelope } from './contracts.ts';
import type { CaptureEnvironment } from './comparison.ts';

export interface ObservedTab extends CaptureTarget {
  active: boolean;
  url?: string;
  title?: string;
  pendingUrl?: string;
  status?: string;
  discarded?: boolean;
}

export interface DocumentObservation {
  url: string;
  title: string;
  token: string;
  revision: number;
  documentId?: string;
  ready: string;
  visible: boolean;
  historyLength?: number;
  navigationTracked?: boolean;
}

export interface CapturePlatform {
  subscribe(listener: (event: AttributionEvent) => void): () => void;
  resolveTarget(invoked?: ObservedTab): Promise<ObservedTab>;
  getTab(id: number): Promise<ObservedTab>;
  getActiveTab(windowId: number): Promise<ObservedTab>;
  isWindowFocused(windowId: number): Promise<boolean>;
  observeDocument(
    target: CaptureTarget,
    expected?: DocumentObservation,
  ): Promise<DocumentObservation>;
  screenshot(windowId: number): Promise<string>;
  decodePng(dataUrl: string): Promise<{ dataBase64: string; width: number; height: number }>;
  browserInfo(): Promise<CaptureEnvelope['browser']>;
}

export interface CaptureSink {
  enqueue(capture: CaptureEnvelope, signal?: AbortSignal): Promise<void>;
}

function httpUrl(value: string | undefined): string {
  if (!value || value.length > 8192) throw new Error('Capture requires an HTTP or HTTPS page.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Capture requires an HTTP or HTTPS page without URL credentials.');
  }
  return url.href;
}

function assertTab(tab: ObservedTab, target: CaptureTarget, url: string): void {
  if (
    tab.id !== target.id ||
    tab.windowId !== target.windowId ||
    !tab.active ||
    tab.discarded ||
    tab.status === 'loading' ||
    tab.pendingUrl ||
    httpUrl(tab.url) !== url
  ) {
    throw new Error('Capture target changed or is loading. Wait for the page and capture again.');
  }
}

export class CaptureController {
  private busy = false;
  private lastScreenshotAt = -Infinity;
  private readonly platform: CapturePlatform;
  private readonly sink: CaptureSink;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly checkEnvironment: (signal?: AbortSignal) => Promise<CaptureEnvironment>;

  constructor(
    platform: CapturePlatform,
    sink: CaptureSink,
    options: {
      now?: () => number;
      newId?: () => string;
      checkEnvironment?: (signal?: AbortSignal) => Promise<CaptureEnvironment>;
    } = {},
  ) {
    this.platform = platform;
    this.sink = sink;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.checkEnvironment =
      options.checkEnvironment ??
      (async () => ({
        limitations: ['Concurrent worker comparison state was not verified.'],
      }));
  }

  async capture(
    invoked?: ObservedTab,
    checkEnvironment = this.checkEnvironment,
  ): Promise<CaptureEnvelope> {
    if (this.busy)
      throw new Error('A capture is already in progress. Capture again when it finishes.');
    if (this.now() - this.lastScreenshotAt < 600) {
      throw new Error('Captures are too close together. Wait a moment and capture again.');
    }
    this.busy = true;
    const started = this.now();
    const guard = new AttributionGuard();
    const abort = new AbortController();
    const timeoutError = new Error('Capture timed out. Keep the page active and capture again.');
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort(timeoutError);
        reject(timeoutError);
      }, 8000);
    });
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      abort.signal.throwIfAborted();
      const value = await Promise.race([operation(), expired]);
      abort.signal.throwIfAborted();
      return value;
    };
    let stop = () => {};
    try {
      stop = this.platform.subscribe((event) => guard.observe(event));
      if (invoked) guard.setTarget(invoked);
      const target = await step(() => this.platform.resolveTarget(invoked));
      guard.setTarget(target);
      const url = httpUrl(target.url);
      const verifyActive = async () => {
        guard.assertUnchanged();
        const [tab, active, focused] = await step(() =>
          Promise.all([
            this.platform.getTab(target.id),
            this.platform.getActiveTab(target.windowId),
            this.platform.isWindowFocused(target.windowId),
          ]),
        );
        guard.assertUnchanged();
        assertTab(tab, target, url);
        assertTab(active, target, url);
        if (!focused) throw new Error('Capture window changed. Focus the page and capture again.');
      };

      assertTab(target, target, url);
      const environmentBefore = await step(() => checkEnvironment(abort.signal));
      guard.assertUnchanged();
      await verifyActive();
      const before = await step(() => this.platform.observeDocument(target));
      guard.assertUnchanged();
      if (before.url !== url || !before.visible || before.ready !== 'complete') {
        throw new Error('Page changed or is loading. Wait for the page and capture again.');
      }
      await verifyActive();
      if (this.now() - started > 2000) {
        throw new Error('Capture preparation expired. Capture again to take a fresh viewport.');
      }
      this.lastScreenshotAt = this.now();
      const capturedAt = new Date(this.lastScreenshotAt).toISOString();
      const dataUrl = await step(() => this.platform.screenshot(target.windowId));
      guard.assertUnchanged();
      const after = await step(() => this.platform.observeDocument(target, before));
      guard.assertUnchanged();
      if (
        after.url !== before.url ||
        after.token !== before.token ||
        after.revision !== before.revision ||
        after.documentId !== before.documentId ||
        after.historyLength !== before.historyLength ||
        !after.visible ||
        after.ready !== 'complete'
      ) {
        throw new Error('Page document changed during capture. Capture again.');
      }
      await verifyActive();
      const environmentAfter = await step(() => checkEnvironment(abort.signal));
      guard.assertUnchanged();
      if (
        environmentBefore.revision !== undefined &&
        environmentAfter.revision !== undefined &&
        environmentBefore.revision !== environmentAfter.revision
      ) {
        throw new Error(
          'Worker comparison state changed during capture. Wait for restoration and capture again.',
        );
      }
      // Attribution is checked over the screenshot interval, not later network/queue waits.
      stop();
      const [image, browser] = await step(() =>
        Promise.all([this.platform.decodePng(dataUrl), this.platform.browserInfo()]),
      );
      const id = this.newId();
      const capture: CaptureEnvelope = {
        schemaVersion: 1,
        id,
        source: 'companion',
        url,
        title: before.title.slice(0, 1024),
        capturedAt,
        browser,
        tab: {
          id: target.id,
          windowId: target.windowId,
          ...(before.documentId ? { documentId: before.documentId } : {}),
        },
        images: [{ id: `${id}-viewport`, mimeType: 'image/png', ...image }],
        text: '',
        context: { pageState: 'unknown', sensitivity: 'unknown' },
        limitations: [
          'Visible viewport only; iframe DOM and offscreen content are not collected.',
          'Browser capture and document observations are not an atomic transaction; dynamic pixels can change.',
          'Installed blocker configuration, list revisions, page state and sensitivity have not been measured.',
          'Browser version is reported by the user agent and may have reduced precision.',
          ...new Set([...environmentBefore.limitations, ...environmentAfter.limitations]),
          ...(!before.documentId
            ? ['Native document ID unavailable; isolated-document token and event guards used.']
            : []),
          ...(before.navigationTracked !== true
            ? [
                'Navigation API unavailable; some same-URL history changes may not be detected. Tab, lifecycle and history-length changes are guarded.',
              ]
            : []),
        ],
      };
      // Cancellation requests an abort; the storage commit/abort outcome remains authoritative.
      abort.signal.throwIfAborted();
      await this.sink.enqueue(capture, abort.signal);
      return capture;
    } finally {
      clearTimeout(timer!);
      stop();
      this.busy = false;
    }
  }
}
