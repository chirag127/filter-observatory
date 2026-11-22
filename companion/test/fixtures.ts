import type { CaptureEnvelope } from '../utils/contracts.ts';

export const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function sampleCapture(id = 'capture-durable-123'): CaptureEnvelope {
  return { schemaVersion: 1, id, source: 'companion', url: 'https://example.org/', title: 'Example',
    capturedAt: '2026-11-21T00:00:00.000Z', browser: { name: 'Chrome', version: '158.0' },
    tab: { id: 4, windowId: 8, documentId: 'document-123' },
    images: [{ id: `${id}-viewport`, mimeType: 'image/png', dataBase64: pngBase64, width: 1, height: 1 }],
    text: '', context: { pageState: 'unknown', sensitivity: 'unknown' }, limitations: ['Test fixture'] };
}
