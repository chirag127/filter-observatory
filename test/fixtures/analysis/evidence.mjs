import { PNG } from 'pngjs';

export function imageFixture(id = 'Screenshot_A', pixels = [
  255, 255, 255, 255, 220, 20, 30, 255,
  25, 40, 220, 255, 255, 255, 255, 255,
], options = {}) {
  const image = new PNG({ width: 2, height: 2 });
  image.data = Buffer.from(pixels);
  return {
    id, mimeType: 'image/png', width: 2, height: 2,
    dataBase64: PNG.sync.write(image, options).toString('base64'),
  };
}

export function captureFixture(overrides = {}) {
  return {
    schemaVersion: 1, id: 'capture_0001', source: 'companion',
    url: 'https://example.test/article', title: 'Controlled fixture',
    capturedAt: '2026-11-21T09:00:00.000Z',
    browser: { name: 'Chrome', version: '158.0.8127.37' },
    tab: { id: 7, windowId: 2, documentId: 'document-7' },
    images: [imageFixture()], text: '  Sponsored offer in the article.  ',
    context: {
      condition: 'installed', pageState: 'usable',
      lists: [{ id: 'adguard:2', name: 'AdGuard Base filter', enabled: true }],
    },
    limitations: ['No comparison was captured.'], ...overrides,
  };
}

export function issuePayload() {
  return {
    schemaVersion: 1, assessment: 'observed_issue',
    findings: [{
      category: 'missed-ads', observation: 'A sponsored offer is visible.',
      expectedBehavior: 'The selected ad-blocking policy should hide the offer.',
      reproduction: ['Open the captured article.'], evidenceIds: ['Screenshot_A', 'text'],
      confidence: 0.75, sensitivity: 'ordinary', suggestedListIds: ['adguard:2'],
    }],
    limitations: ['No comparison was captured.'],
  };
}

export const providerFixture = Object.freeze({
  baseUrl: 'https://provider.example.test/v1', model: 'fixture-vision/001',
  apiKey: 'synthetic-test-key', outputMode: 'json-schema', vision: true,
  timeoutMs: 2000, maxOutputTokens: 1024,
});

export function completion(payload = issuePayload(), mode = 'json-schema') {
  return {
    id: 'completion-fixture', object: 'chat.completion', model: 'fixture-vision/001',
    choices: [{
      index: 0, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop',
      message: mode === 'tool' ? {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_fixture', type: 'function', function: {
          name: 'return_findings', arguments: JSON.stringify(payload),
        } }],
      } : { role: 'assistant', content: JSON.stringify(payload) },
    }],
    usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
  };
}
