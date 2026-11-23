import assert from 'node:assert/strict';
import test from 'node:test';
import { permittedUiRequest } from '../utils/messages.ts';

const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const popup = `chrome-extension://${id}/popup.html`;
const options = `chrome-extension://${id}/options.html`;
const allowed = (message: unknown, url = popup, senderId = id, frameId = 0) =>
  permittedUiRequest(message, { id: senderId, url, frameId }, id, popup, options);

test('only owned extension pages can read status or request delivery', () => {
  assert.equal(allowed({ type: 'status' }), true);
  assert.equal(allowed({ type: 'retry' }, options), true);
  assert.equal(allowed({ type: 'check' }), true);
  for (const url of [
    'https://example.org',
    `${popup}?injected=1`,
    `chrome-extension://${id}/other.html`,
  ]) {
    assert.equal(allowed({ type: 'status' }, url), false);
  }
  assert.equal(allowed({ type: 'status' }, popup, 'another-extension'), false);
  assert.equal(allowed({ type: 'status' }, popup, id, 1), false);
});

test('worker token access is limited to options; no capture or arbitrary fetch messages exist', () => {
  assert.equal(allowed({ type: 'settings:get' }, options), true);
  assert.equal(allowed({ type: 'settings:save', settings: {} }, options), true);
  assert.equal(allowed({ type: 'settings:get' }), false);
  assert.equal(allowed({ type: 'settings:save', settings: {} }), false);
  for (const message of [
    null,
    [],
    { type: 'capture' },
    { type: 'fetch', url: 'https://example.org' },
    { type: 'retry', id: 'arbitrary-id' },
    { type: ['status'] },
  ]) {
    assert.equal(allowed(message), false);
  }
});
