import { PNG } from 'pngjs';

export function imageFixture(id = 'viewport') {
  const png = new PNG({ width: 3, height: 2 });
  png.data.set([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255,
    255,
  ]);
  return {
    id,
    mimeType: 'image/png',
    width: 3,
    height: 2,
    dataBase64: PNG.sync.write(png).toString('base64'),
  };
}

export function captureFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'capture_fixture_01',
    source: 'companion',
    url: 'https://example.com/article',
    title: 'Example article',
    capturedAt: '2026-11-21T16:00:00.000Z',
    browser: { name: 'Chrome', version: '158.0.8127.37' },
    tab: { id: 4, windowId: 2, documentId: 'doc-fixture' },
    images: [imageFixture()],
    text: 'Example article',
    context: {},
    limitations: [],
    ...overrides,
  };
}
