import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { documentResult, observeIsolatedDocument } from '../utils/document.ts';

test('serialized observation is closure-free and latches lifecycle changes in its isolated global', () => {
  const dom = new JSDOM('<title>Observation fixture</title>', {
    url: 'https://example.org/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  try {
    const run = () =>
      documentResult([
        { frameId: 0, result: dom.window.eval(`(${observeIsolatedDocument.toString()})()`) },
      ]);
    const before = run();
    const again = run();
    assert.equal(again.token, before.token);
    assert.equal(before.url, 'https://example.org/');
    assert.equal(before.title, 'Observation fixture');
    assert.equal(before.visible, true);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.dispatchEvent(new dom.window.Event('pageshow'));
    dom.window.dispatchEvent(new dom.window.Event('hashchange'));
    const after = run();
    assert.equal(after.token, before.token);
    assert.equal(after.revision, before.revision + 3);
    assert.equal(dom.window.document.documentElement.outerHTML.includes(before.token), false);
  } finally {
    dom.window.close();
  }
});

test('Firefox results without native document IDs remain usable, and per-result errors are failures', () => {
  const result = {
    url: 'https://example.org/',
    title: 'Page',
    token: 'isolated-token',
    revision: 0,
    ready: 'complete',
    visible: true,
  };
  assert.deepEqual(documentResult([{ frameId: 0, result }]), result);
  assert.equal(
    documentResult([{ frameId: 0, result, documentId: 'native-doc' }]).documentId,
    'native-doc',
  );
  for (const response of [
    [],
    [{ frameId: 1, result }],
    [{ frameId: 0, result, error: 'permission denied' }],
    [{ frameId: 0, result: { ...result, token: '' } }],
    [{ frameId: 0, result: { ...result, revision: -1 } }],
  ]) {
    assert.throws(() => documentResult(response), /document evidence/);
  }
});

test('HTTP document identity works without secure-context randomUUID and stays private to the document', () => {
  const dom = new JSDOM('<title>HTTP fixture</title>', {
    url: 'http://example.org/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  try {
    Object.defineProperty(dom.window.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    const run = () =>
      documentResult([
        { frameId: 0, result: dom.window.eval(`(${observeIsolatedDocument.toString()})()`) },
      ]);
    const original = run();
    assert.ok(original.token.length >= 32);
    assert.equal(run().token, original.token);
    assert.equal(dom.window.document.documentElement.outerHTML.includes(original.token), false);
    dom.window.eval('delete globalThis.__filterObservatoryDocumentV1');
    assert.notEqual(run().token, original.token);
  } finally {
    dom.window.close();
  }
});

test('without Navigation API, history length detects same-URL pushes and reports the replacement limitation', () => {
  const dom = new JSDOM('<title>History fixture</title>', {
    url: 'https://example.org/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  try {
    const run = () =>
      documentResult([
        { frameId: 0, result: dom.window.eval(`(${observeIsolatedDocument.toString()})()`) },
      ]);
    const before = run();
    dom.window.history.pushState({ view: 'next' }, '', 'https://example.org/');
    const afterPush = run();
    assert.equal(afterPush.url, before.url);
    assert.equal(afterPush.token, before.token);
    assert.equal(afterPush.historyLength, before.historyLength! + 1);
    dom.window.history.replaceState({ view: 'replacement' }, '', 'https://example.org/');
    const afterReplace = run();
    assert.equal(afterReplace.navigationTracked, false);
    assert.equal(afterReplace.historyLength, afterPush.historyLength);
    assert.equal(afterReplace.revision, afterPush.revision);
  } finally {
    dom.window.close();
  }
});
