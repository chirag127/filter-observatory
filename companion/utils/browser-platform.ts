import type { Browser, WxtBrowser } from 'wxt/browser';
import type { CapturePlatform, ObservedTab } from './capture.ts';
import { documentResult, observeIsolatedDocument } from './document.ts';
import { decodeScreenshot } from './png.ts';

export function observedTab(tab: Browser.tabs.Tab | undefined): ObservedTab {
  if (
    !tab ||
    !Number.isInteger(tab.id) ||
    Number(tab.id) < 0 ||
    !Number.isInteger(tab.windowId) ||
    tab.windowId < 0
  ) {
    throw new Error('The capture tab is no longer available. Focus a website and capture again.');
  }
  return {
    id: tab.id!,
    windowId: tab.windowId,
    active: tab.active,
    url: tab.url,
    title: tab.title,
    pendingUrl: tab.pendingUrl,
    status: tab.status,
    discarded: tab.discarded,
  };
}

export function createBrowserPlatform(
  api: WxtBrowser,
  targetBrowser: 'chrome' | 'firefox',
): CapturePlatform {
  return {
    subscribe(listener) {
      const activated = (info: Browser.tabs.OnActivatedInfo) =>
        listener({ kind: 'activated', ...info });
      const focused = (windowId: number) => listener({ kind: 'focused', windowId });
      const updated = (tabId: number, info: Browser.tabs.OnUpdatedInfo) =>
        listener({
          kind: 'updated',
          tabId,
          navigated: info.url !== undefined || info.status === 'loading' || info.discarded === true,
        });
      const removed = (tabId: number) => listener({ kind: 'removed', tabId });
      const detached = (tabId: number) => listener({ kind: 'detached', tabId });
      const replaced = (addedTabId: number, removedTabId: number) => {
        listener({ kind: 'replaced', tabId: removedTabId });
        listener({ kind: 'replaced', tabId: addedTabId });
      };
      const windowRemoved = (windowId: number) => listener({ kind: 'window-removed', windowId });
      const bindings: Array<() => void> = [];
      const bind = <Args extends unknown[]>(
        event: {
          addListener(fn: (...args: Args) => void): void;
          removeListener(fn: (...args: Args) => void): void;
        },
        fn: (...args: Args) => void,
      ) => {
        event.addListener(fn);
        bindings.push(() => event.removeListener(fn));
      };
      try {
        bind(api.tabs.onActivated, activated);
        bind(api.windows.onFocusChanged, focused);
        bind(api.tabs.onUpdated, updated);
        bind(api.tabs.onRemoved, removed);
        bind(api.tabs.onDetached, detached);
        bind(api.tabs.onAttached, detached);
        bind(api.tabs.onReplaced, replaced);
        bind(api.windows.onRemoved, windowRemoved);
      } catch (error) {
        for (const unbind of bindings) unbind();
        throw error;
      }
      let stopped = false;
      return () => {
        if (!stopped) {
          stopped = true;
          for (const unbind of bindings) unbind();
        }
      };
    },
    async resolveTarget(invoked) {
      if (invoked) return invoked;
      return observedTab((await api.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
    },
    async getTab(id) {
      return observedTab(await api.tabs.get(id));
    },
    async getActiveTab(windowId) {
      return observedTab((await api.tabs.query({ active: true, windowId }))[0]);
    },
    async isWindowFocused(windowId) {
      const window = await api.windows.get(windowId);
      return window.focused && window.state !== 'minimized';
    },
    async observeDocument(target, expected) {
      let results: unknown;
      try {
        results = await api.scripting.executeScript({
          target:
            expected?.documentId && targetBrowser === 'chrome'
              ? { tabId: target.id, documentIds: [expected.documentId] }
              : { tabId: target.id, frameIds: [0] },
          world: 'ISOLATED',
          func: observeIsolatedDocument,
        });
      } catch {
        throw new Error(
          'This page cannot be inspected or its document changed. Use a normal website and capture again.',
        );
      }
      return documentResult(results);
    },
    async screenshot(windowId) {
      try {
        return await api.tabs.captureVisibleTab(windowId, { format: 'png' });
      } catch {
        throw new Error(
          'The browser could not capture this viewport. Keep the website active and try again.',
        );
      }
    },
    decodePng: decodeScreenshot,
    async browserInfo() {
      const ua = navigator.userAgent;
      const edge = /Edg\/([\d.]+)/.exec(ua);
      const firefox = /Firefox\/([\d.]+)/.exec(ua);
      const chrome = /(?:Chrome|Chromium)\/([\d.]+)/.exec(ua);
      return {
        name: edge
          ? 'Edge'
          : firefox
            ? 'Firefox'
            : targetBrowser === 'chrome'
              ? 'Chrome'
              : 'Firefox',
        version: edge?.[1] ?? firefox?.[1] ?? chrome?.[1] ?? 'unknown',
      };
    },
  };
}
