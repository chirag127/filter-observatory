import type { DocumentObservation } from './capture.ts';

// This function is serialized by scripting.executeScript; all runtime dependencies stay inside it.
export function observeIsolatedDocument(): Omit<DocumentObservation, 'documentId'> {
  type Marker = { document: Document; token: string; revision: number; navigationTracked: boolean };
  const isolated = globalThis as typeof globalThis & { __filterObservatoryDocumentV1?: Marker };
  let marker = isolated.__filterObservatoryDocumentV1;
  if (!marker || marker.document !== document) {
    // getRandomValues is available on HTTP pages, unlike the secure-context-only randomUUID.
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    marker = { document, token, revision: 0, navigationTracked: typeof navigation?.addEventListener === 'function' };
    isolated.__filterObservatoryDocumentV1 = marker;
    const changed = () => { marker!.revision += 1; };
    for (const event of ['pagehide', 'pageshow', 'popstate', 'hashchange']) {
      window.addEventListener(event, changed, { capture: true });
    }
    document.addEventListener('visibilitychange', changed, { capture: true });
    // Navigation API events also cover same-document history updates where supported.
    navigation?.addEventListener('navigate', changed);
    navigation?.addEventListener('currententrychange', changed);
  }
  return { url: location.href, title: document.title, token: marker.token, revision: marker.revision,
    ready: document.readyState, visible: document.visibilityState === 'visible',
    historyLength: history.length, navigationTracked: marker.navigationTracked };
}

export function documentResult(results: unknown): DocumentObservation {
  if (!Array.isArray(results)) throw new Error('This page did not return document evidence.');
  const main = results.find((item: unknown) => item && typeof item === 'object' &&
    (item as Record<string, unknown>).frameId === 0) as Record<string, unknown> | undefined;
  const result = main?.result as Record<string, unknown> | undefined;
  if (!main || main.error !== undefined || !result || typeof result !== 'object' ||
      typeof result.url !== 'string' || typeof result.title !== 'string' ||
      typeof result.token !== 'string' || !result.token || result.token.length > 160 ||
      !Number.isSafeInteger(result.revision) || Number(result.revision) < 0 ||
      typeof result.ready !== 'string' || typeof result.visible !== 'boolean' ||
      result.url.length > 8192 ||
      (result.historyLength !== undefined && (!Number.isSafeInteger(result.historyLength) || Number(result.historyLength) < 1)) ||
      (result.navigationTracked !== undefined && typeof result.navigationTracked !== 'boolean')) {
    throw new Error('This page did not return valid document evidence. Capture a normal website and try again.');
  }
  if (main.documentId !== undefined && (typeof main.documentId !== 'string' ||
      !main.documentId || main.documentId.length > 160)) {
    throw new Error('This page returned an invalid document identity.');
  }
  return { url: result.url, title: result.title.slice(0, 2000), token: result.token,
    revision: Number(result.revision), ready: result.ready, visible: result.visible,
    ...(typeof result.historyLength === 'number' ? { historyLength: result.historyLength } : {}),
    ...(typeof result.navigationTracked === 'boolean' ? { navigationTracked: result.navigationTracked } : {}),
    ...(typeof main.documentId === 'string' ? { documentId: main.documentId } : {}) };
}
