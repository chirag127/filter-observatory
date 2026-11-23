import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../public/app.mjs', import.meta.url), 'utf8');

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function capture(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'capture_ui_01',
    source: 'companion',
    url: 'https://example.com/article',
    title: 'Observation fixture',
    capturedAt: '2026-11-21T16:00:00.000Z',
    createdAt: '2026-11-21T16:00:01.000Z',
    browser: { name: 'Chrome', version: 'fixture' },
    tab: { id: 1, windowId: 1 },
    images: [],
    text: '',
    context: {},
    limitations: [],
    state: 'queued',
    analysis: null,
    annotations: null,
    ...overrides,
  };
}
export function run(overrides = {}) {
  return {
    id: 'run_ui_01',
    state: 'running',
    updatedAt: '2026-11-21T16:00:01.000Z',
    corpus: {
      source: 'Fixture corpus',
      snapshot: 'fixed-fixture',
      entries: [{ id: 'entry_1', rank: 1, domain: 'example.com', url: 'https://example.com/' }],
      errors: [],
    },
    counts: { running: 1, pending: 0, completed: 0 },
    options: { compare: true },
    ...overrides,
  };
}
export function state(overrides = {}) {
  const value = {
    captures: [],
    runs: [],
    catalog: [],
    reports: [],
    findings: [],
    journals: [],
    leases: [],
    events: [],
    operations: [],
    catalogImports: [],
    configuration: {
      providerEnabled: false,
      providerModel: 'fixture-model',
      publicationEnabled: false,
      browser: 'fixture-browser',
      allowChanges: false,
    },
    worker: { processing: false, runId: null, stopped: false, lastError: null },
    ...overrides,
  };
  value.totals ??= {
    captures: value.captures.length,
    reports: value.reports.length,
    catalog: value.catalog.length,
    findings: value.findings.length,
  };
  value.capturePage ??= { limit: 200, total: value.totals.captures, nextCursor: null };
  return value;
}

export function fixture(t) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:4317',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const requests = [],
    revoked = [],
    created = [],
    timers = new Map();
  let timerId = 0;
  // Keep jsdom's browser controllers: unlike Node's, these lack static abort helpers.
  window.AbortSignal.any = undefined;
  window.AbortSignal.timeout = undefined;
  // Control only transport and elapsed app timers. Late replies deliberately ignore abort,
  // so generation isolation is checked even when cancellation loses the response race.
  window.fetch = (path, init = {}) => {
    const result = deferred();
    const request = {
      path,
      init,
      done: false,
      json(value, status = 200) {
        this.done = true;
        result.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => JSON.parse(JSON.stringify(value)),
        });
      },
      image() {
        this.done = true;
        result.resolve({
          ok: true,
          status: 200,
          blob: async () => new window.Blob(['fixture-image'], { type: 'image/png' }),
        });
      },
      fail(error = new Error('Fixture network unavailable')) {
        this.done = true;
        result.reject(error);
      },
    };
    requests.push(request);
    return result.promise;
  };
  window.setTimeout = (callback, ms) => {
    const id = ++timerId;
    timers.set(id, { callback, ms });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.URL.createObjectURL = () => {
    const url = `blob:ui-${created.length + 1}`;
    created.push(url);
    return url;
  };
  window.URL.revokeObjectURL = (url) => revoked.push(url);
  new Script(`'use strict';\n${app}`, { filename: 'public/app.mjs' }).runInContext(
    dom.getInternalVMContext(),
  );
  t.after(() => window.close());
  const $ = (id) => window.document.getElementById(id);
  return {
    window,
    document: window.document,
    $,
    requests,
    timers,
    created,
    revoked,
    pending(path) {
      return requests.filter(
        (request) =>
          !request.done &&
          (typeof path === 'string' ? request.path === path : path.test(request.path)),
      );
    },
    request(path) {
      const matches = this.pending(path);
      assert.equal(
        matches.length,
        1,
        `Expected one pending ${path}, got ${matches.map((item) => item.path)}`,
      );
      return matches[0];
    },
    submit(id) {
      $(id).requestSubmit();
    },
    edit(input, value) {
      input.value = value;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    open(details) {
      details.open = true;
      details.dispatchEvent(new window.Event('toggle'));
    },
    view(name) {
      window.document.querySelector(`[data-view="${name}"]`).click();
    },
    tick(ms = 5000) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Expected an app timer at ${ms} ms`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

export async function connect(h, value = state(), token = 'ui-fixture-token') {
  const start = h.requests.length;
  h.$('worker-token').value = token;
  h.submit('connect-form');
  const requests = h.requests.slice(start);
  assert.equal(requests.length, 1, 'Connecting issues its own authenticated state request');
  assert.equal(requests[0].path, '/api/state');
  requests[0].json(value);
  await settle();
  assert.equal(h.$('connection-panel').hidden, true);
}

export function findDetail(parent, text) {
  const found = [...parent.querySelectorAll('details')].find((node) =>
    node.querySelector('summary')?.textContent.includes(text),
  );
  assert.ok(found, `Expected details containing ${text}`);
  return found;
}
