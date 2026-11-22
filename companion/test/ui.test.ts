import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { mountOptions, mountPopup } from '../components/app.ts';
import type { RequestClient } from '../components/app.ts';
import type { CompanionStatus, UiReply, UiRequest } from '../utils/contracts.ts';

const endpoint = 'http://127.0.0.1:4317';
const fixtureToken = 'fixture-worker-token-for-offline-tests-only';

function snapshot(changes: Partial<CompanionStatus> = {}): CompanionStatus {
  return {
    connection: 'unconfigured',
    connectionMessage: 'Set a worker token in connection settings.',
    endpoint,
    configured: false,
    queue: { pending: 0, blocked: 0, bytes: 0 },
    shortcut: 'Ctrl+Shift+7',
    browser: 'chrome',
    capture: { state: 'idle', message: 'No capture recorded.' },
    ...changes,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function node<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const result = root.querySelector<T>(selector);
  assert.ok(result, `Expected ${selector}`);
  return result;
}

function field(root: HTMLElement, name: string): HTMLElement {
  return node(root, `[data-field="${name}"]`);
}

function action(root: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(root.querySelectorAll('button')).find((item) => item.textContent === label);
  assert.ok(result, `Expected button ${label}`);
  return result;
}

function setup(
  t: TestContext,
  mode: 'popup' | 'options',
  request: RequestClient,
  openOptions: () => Promise<void> = async () => {},
) {
  const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="app"></div></body></html>', {
    url: 'https://companion.test/',
  });
  const root = node<HTMLElement>(dom.window.document, '#app');
  const ui = mode === 'popup' ? mountPopup(root, request, openOptions) : mountOptions(root, request);
  t.after(() => { ui.destroy(); dom.window.close(); });
  return { dom, root, ui };
}

function edit(dom: JSDOM, root: HTMLElement, name: 'endpoint' | 'token', value: string) {
  const input = node<HTMLInputElement>(root, `input[name="${name}"]`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return input;
}

function submit(dom: JSDOM, root: HTMLElement) {
  const event = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  node<HTMLFormElement>(root, 'form').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'A settings save must not navigate or put credentials in a URL');
}

function settingsReply(status = snapshot()): UiReply {
  return { ok: true, settings: { endpoint, token: fixtureToken }, status };
}

test('UI entrypoint modules import without DOM or extension runtime globals', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const [popup, options] = await Promise.all([
    import('../entrypoints/popup/main.ts'),
    import('../entrypoints/options/main.ts'),
  ]);
  assert.equal(typeof popup.main, 'function');
  assert.equal(typeof options.main, 'function');
});

test('loading does not present fabricated queue counts, a shortcut, or a connected worker', async (t) => {
  const response = deferred<UiReply>();
  const { root, ui } = setup(t, 'popup', () => response.promise);
  assert.equal(node(root, '.status-stack').getAttribute('aria-busy'), 'true');
  assert.equal(field(root, 'pending').textContent, '—');
  assert.equal(field(root, 'blocked').textContent, '—');
  assert.equal(field(root, 'connection').textContent, 'Status unavailable');
  assert.equal(field(root, 'shortcut').textContent, 'Reading shortcut…');
  assert.match(node(root, '[role="status"]').textContent!, /Reading companion status/);
  for (const button of root.querySelectorAll('button')) assert.equal(button.disabled, true);

  response.resolve({ ok: true, status: snapshot() });
  await ui.ready;
  assert.equal(node(root, '.status-stack').getAttribute('aria-busy'), 'false');
  assert.equal(field(root, 'shortcut').textContent, 'Ctrl+Shift+7');
  assert.match(field(root, 'shortcut-guide').textContent!, /Close this popup/);
});

test('an empty, unconfigured Firefox popup explains the unassigned command without initiating capture', async (t) => {
  const requests: UiRequest[] = [];
  const { root, ui } = setup(t, 'popup', async (request) => {
    requests.push(request);
    return { ok: true, status: snapshot({ browser: 'firefox', shortcut: '' }) };
  });
  await ui.ready;
  assert.equal(field(root, 'connection').textContent, 'Not configured');
  assert.equal(field(root, 'shortcut').textContent, 'No shortcut assigned');
  assert.match(field(root, 'shortcut-guide').textContent!, /Firefox.*Manage extension shortcuts/);
  assert.doesNotMatch(field(root, 'shortcut-guide').textContent!, /Ctrl\+Q/);
  assert.equal(field(root, 'pending').textContent, '0');
  assert.equal(field(root, 'blocked').textContent, '0');
  assert.match(field(root, 'queue-empty').textContent!, /No captures waiting/);
  assert.equal(field(root, 'capture-state').textContent, 'Idle');
  assert.equal(field(root, 'last-delivery').textContent, 'No worker receipt recorded.');
  assert.equal(action(root, 'Retry pending').disabled, true);
  assert.equal(action(root, 'Check connection').disabled, false);
  assert.equal(root.querySelector('input'), null);
  assert.equal(Array.from(root.querySelectorAll('button')).some((item) => /capture/i.test(item.textContent!)), false);
  assert.deepEqual(requests, [{ type: 'status' }]);
});

test('offline delivery retains pending and blocked evidence separately from a saved capture and old receipt', async (t) => {
  const at = '2026-11-21T12:30:00.000Z';
  const { root, ui } = setup(t, 'popup', async () => ({
    ok: true,
    status: snapshot({
      configured: true,
      connection: 'offline',
      connectionMessage: 'The local worker did not respond. Start the worker, then check again.',
      capture: { state: 'saved', message: 'Viewport saved to the local queue.', at },
      queue: {
        pending: 3, blocked: 1, bytes: 3072, oldestAt: at,
        nextRetryAt: '2026-11-21T12:31:00.000Z', lastError: 'The worker rejected one capture (409).',
      },
      lastDelivery: { id: 'older-worker-receipt', at: '2026-11-20T12:30:00.000Z' },
    }),
  }));
  await ui.ready;
  assert.equal(field(root, 'connection').textContent, 'Offline');
  assert.equal(field(root, 'capture-state').textContent, 'Saved locally');
  assert.equal(field(root, 'pending').textContent, '3');
  assert.equal(field(root, 'blocked').textContent, '1');
  assert.equal(field(root, 'bytes').textContent, '3.0 KiB');
  assert.equal(field(root, 'queue-error').hidden, false);
  assert.match(field(root, 'queue-error').textContent!, /409/);
  assert.equal(field(root, 'blocked-help').hidden, false);
  assert.equal(node<HTMLTimeElement>(field(root, 'next-retry'), 'time').dateTime, '2026-11-21T12:31:00.000Z');
  assert.equal(field(root, 'delivery-id').textContent, 'older-worker-receipt');
  assert.match(root.textContent!, /Worker delivery does not confirm analysis or a report/);
  assert.equal(action(root, 'Retry pending').disabled, false);
});

test('capture failure is visible independently of an online worker and does not label its time as captured', async (t) => {
  const { root, ui } = setup(t, 'popup', async () => ({
    ok: true,
    status: snapshot({
      connection: 'online', configured: true, connectionMessage: 'Worker responded.',
      capture: { state: 'error', message: 'The tab navigated during capture.', at: '2026-11-21T12:30:00Z' },
    }),
  }));
  await ui.ready;
  assert.equal(field(root, 'connection').textContent, 'Online');
  assert.equal(field(root, 'capture-state').textContent, 'Capture failed');
  assert.match(field(root, 'capture-message').textContent!, /tab navigated/);
  assert.match(field(root, 'capture-at').textContent!, /^Failed: /);
  assert.doesNotMatch(field(root, 'capture-at').textContent!, /Captured:/);
  assert.equal(field(root, 'last-delivery').textContent, 'No worker receipt recorded.');
});

test('checking and retrying render returned outcomes without claiming that delivery or authentication succeeded', async (t) => {
  const requests: UiRequest[] = [];
  const check = deferred<UiReply>();
  const initial = snapshot({ configured: true, queue: { pending: 2, blocked: 0, bytes: 100 } });
  const { root, ui } = setup(t, 'popup', async (request) => {
    requests.push(request);
    if (request.type === 'check') return check.promise;
    if (request.type === 'retry') return {
      ok: true,
      status: snapshot({
        connection: 'error', configured: true, connectionMessage: 'Worker intake rejected delivery.',
        queue: { pending: 1, blocked: 1, bytes: 100, lastError: 'Capture ID conflict.' },
      }),
    };
    return { ok: true, status: initial };
  });
  await ui.ready;
  action(root, 'Check connection').click();
  action(root, 'Check connection').click();
  assert.equal(action(root, 'Retry pending').disabled, true);
  assert.match(node(root, '[role="status"]').textContent!, /Checking the local worker/);
  check.resolve({ ok: true, status: { ...initial, connection: 'unauthorized', connectionMessage: 'Worker token was rejected (401).' } });
  await ui.whenIdle();
  assert.equal(field(root, 'connection').textContent, 'Token not accepted');
  assert.match(field(root, 'connection-message').textContent!, /401/);
  assert.equal(field(root, 'pending').textContent, '2');

  action(root, 'Retry pending').click();
  await ui.whenIdle();
  assert.equal(field(root, 'connection').textContent, 'Connection error');
  assert.equal(field(root, 'blocked').textContent, '1');
  assert.equal(field(root, 'queue-error').textContent, 'Capture ID conflict.');
  assert.deepEqual(requests, [{ type: 'status' }, { type: 'check' }, { type: 'retry' }]);
});

test('failed refresh preserves the last snapshot as stale and supports explicit recovery', async (t) => {
  let response: UiReply | Error = { ok: true, status: snapshot({ queue: { pending: 4, blocked: 0, bytes: 400 } }) };
  const { root, ui } = setup(t, 'popup', async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  await ui.ready;
  response = new Error('The extension background stopped.');
  action(root, 'Refresh status').click();
  await ui.whenIdle();
  assert.equal(field(root, 'pending').textContent, '4');
  assert.equal(node<HTMLElement>(root, '.stale-notice').hidden, false);
  assert.equal(node<HTMLElement>(root, '.operation-error').hidden, false);
  assert.match(node(root, '.operation-error').textContent!, /background stopped/);
  assert.equal(action(root, 'Refresh status').disabled, false);

  response = { ok: true, status: snapshot({ queue: { pending: 2, blocked: 0, bytes: 200 } }) };
  action(root, 'Refresh status').click();
  await ui.whenIdle();
  assert.equal(field(root, 'pending').textContent, '2');
  assert.equal(node<HTMLElement>(root, '.stale-notice').hidden, true);
  assert.equal(node<HTMLElement>(root, '.operation-error').hidden, true);
});

test('missing or failed initial status remains unavailable rather than becoming an empty queue', async (t) => {
  for (const reply of [{ ok: true }, { ok: false, error: 'Status storage could not be opened.' }] satisfies UiReply[]) {
    await t.test(reply.ok ? 'missing status' : 'background error', async (subtest) => {
      const { root, ui } = setup(subtest, 'popup', async () => reply);
      await ui.ready;
      assert.equal(field(root, 'pending').textContent, '—');
      assert.equal(field(root, 'connection').textContent, 'Status unavailable');
      assert.equal(node<HTMLElement>(root, '.operation-error').hidden, false);
      assert.match(node(root, '.operation-error').textContent!, reply.ok ? /No companion status/ : /could not be opened/);
      assert.equal(action(root, 'Retry pending').disabled, true);
    });
  }
});

test('backend strings are displayed as text, including HTML-like errors, URLs, shortcut and receipt IDs', async (t) => {
  const unsafe = '<img src=x onerror="globalThis.compromised=true"><script>bad()</script>';
  let fail = false;
  const { root, ui } = setup(t, 'popup', async () => fail ? { ok: false, error: unsafe } : {
    ok: true,
    status: snapshot({
      endpoint: unsafe, shortcut: unsafe, connection: 'offline', connectionMessage: unsafe,
      capture: { state: 'error', message: unsafe },
      queue: { pending: 1, blocked: 1, bytes: 10, lastError: unsafe },
      lastDelivery: { id: unsafe, at: 'invalid date' },
    }),
  });
  await ui.ready;
  for (const name of ['endpoint', 'shortcut', 'connection-message', 'capture-message', 'queue-error', 'delivery-id']) {
    assert.equal(field(root, name).textContent, unsafe);
  }
  assert.equal(field(root, 'endpoint').querySelector('a'), null);
  assert.match(field(root, 'last-delivery').textContent!, /Time unavailable/);
  fail = true;
  await ui.refresh();
  assert.equal(node(root, '.operation-error').textContent, unsafe);
  assert.equal(root.querySelector('img, script, iframe, svg'), null);
});

test('options navigation reports failure and stops handling clicks after unmount', async (t) => {
  let attempts = 0;
  const { dom, root, ui } = setup(t, 'popup', async () => ({ ok: true, status: snapshot() }), async () => {
    attempts += 1;
    throw new Error('Options page could not open.');
  });
  await ui.ready;
  const link = node<HTMLAnchorElement>(root, '.settings-link');
  assert.equal(link.getAttribute('href'), '/options.html');
  link.click();
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.match(node(root, '.operation-error').textContent!, /could not open/);
  ui.destroy();
  link.addEventListener('click', (event) => event.preventDefault());
  link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  assert.equal(attempts, 1);
});

test('options read only their local connection and keep the token exclusively in a labelled password input', async (t) => {
  const response = deferred<UiReply>();
  const requests: UiRequest[] = [];
  const { root, ui } = setup(t, 'options', (request) => {
    requests.push(request);
    return response.promise;
  });
  const address = node<HTMLInputElement>(root, '#endpoint');
  const token = node<HTMLInputElement>(root, '#token');
  assert.equal(address.value, endpoint);
  assert.equal(address.disabled, true);
  assert.equal(token.disabled, true);
  response.resolve(settingsReply());
  await ui.ready;
  assert.equal(address.disabled, false);
  assert.equal(token.type, 'password');
  assert.equal(token.autocomplete, 'off');
  assert.equal(token.value, fixtureToken);
  assert.equal(token.getAttribute('value'), null);
  assert.equal(token.labels?.[0]?.textContent, 'Worker token');
  assert.equal(root.textContent!.includes(fixtureToken), false);
  assert.equal(root.innerHTML.includes(fixtureToken), false);
  assert.match(node(root, '#token-hint').textContent!, /local storage, never synced/);
  assert.deepEqual(requests, [{ type: 'settings:get' }]);
});

test('saving connection sends edited values, accepts no echoed token and does not equate saved settings with online', async (t) => {
  const saved = deferred<UiReply>();
  const requests: UiRequest[] = [];
  const { dom, root, ui } = setup(t, 'options', async (request) => {
    requests.push(structuredClone(request));
    return request.type === 'settings:save' ? saved.promise : settingsReply();
  });
  await ui.ready;
  edit(dom, root, 'endpoint', ' http://localhost:54321/ ');
  edit(dom, root, 'token', 'edited-local-worker-token-fixture');
  assert.equal(action(root, 'Check connection').disabled, true);
  submit(dom, root);
  assert.equal(action(root, 'Save connection').disabled, true);
  assert.equal(node<HTMLInputElement>(root, '#token').disabled, true);
  saved.resolve({
    ok: true,
    status: snapshot({ endpoint: 'http://localhost:54321', connection: 'offline', configured: true, connectionMessage: 'Start the local worker.' }),
  });
  await ui.whenIdle();
  assert.deepEqual(requests, [
    { type: 'settings:get' },
    { type: 'settings:save', settings: { endpoint: 'http://localhost:54321', token: 'edited-local-worker-token-fixture' } },
  ]);
  assert.match(node(root, '[role="status"]').textContent!, /settings saved locally/);
  assert.equal(field(root, 'connection').textContent, 'Offline');
  assert.equal(action(root, 'Check connection').disabled, false);
  assert.equal(node<HTMLInputElement>(root, '#endpoint').value, 'http://localhost:54321');
  assert.equal(node<HTMLInputElement>(root, '#token').type, 'password');
  assert.equal(root.innerHTML.includes('edited-local-worker-token-fixture'), false);
});

test('non-loopback, ambiguous or non-origin endpoints focus an accessible field error without saving', async (t) => {
  const requests: UiRequest[] = [];
  const { dom, root, ui } = setup(t, 'options', async (request) => {
    requests.push(request);
    return settingsReply();
  });
  await ui.ready;
  const invalid = [
    '', 'https://127.0.0.1:4317', 'http://example.com:4317', 'http://127.0.0.1.example.com:4317',
    'http://user:secret@localhost:4317', 'http://localhost:4317/api', 'http://localhost:4317/./',
    'http://localhost:4317?token=x', 'http://localhost:4317#fragment', 'http://127.1:4317',
    'http://2130706433:4317', 'http://[::1]:4317', 'http://localhost:0', 'http://localhost:65536',
    'http://localhost:1', 'http://localhost:1023', 'http://localhost:04317',
    'http://localhost:', 'http://localhost:4e3', 'http://%6cocalhost:4317', 'http://localhost:4317\\path',
  ];
  for (const value of invalid) {
    const input = edit(dom, root, 'endpoint', value);
    submit(dom, root);
    await ui.whenIdle();
    assert.equal(input.getAttribute('aria-invalid'), 'true', value);
    assert.equal(dom.window.document.activeElement, input, value);
    assert.equal(node<HTMLElement>(root, '#endpoint-error').hidden, false, value);
    assert.match(input.getAttribute('aria-describedby')!, /endpoint-error/);
  }
  assert.deepEqual(requests, [{ type: 'settings:get' }]);
  edit(dom, root, 'endpoint', endpoint);
  assert.equal(node(root, '#endpoint').hasAttribute('aria-invalid'), false);
  assert.equal(node<HTMLElement>(root, '#endpoint-error').hidden, true);
});

test('valid loopback origins and port boundaries can be saved with an empty token to disconnect', async (t) => {
  const saved: UiRequest[] = [];
  const { dom, root, ui } = setup(t, 'options', async (request) => {
    if (request.type === 'settings:get') return settingsReply();
    saved.push(request);
    return { ok: true, status: snapshot() };
  });
  await ui.ready;
  edit(dom, root, 'token', '');
  for (const value of ['http://127.0.0.1', 'http://localhost/', 'http://localhost:1024', 'http://127.0.0.1:65535']) {
    edit(dom, root, 'endpoint', value);
    submit(dom, root);
    await ui.whenIdle();
    assert.equal(node<HTMLElement>(root, '#endpoint-error').hidden, true);
    assert.match(node(root, '[role="status"]').textContent!, /settings saved locally/);
    assert.deepEqual(saved.at(-1), { type: 'settings:save', settings: { endpoint: value.replace(/\/$/, ''), token: '' } });
  }
  assert.equal(field(root, 'connection').textContent, 'Not configured');
  assert.equal(node<HTMLInputElement>(root, '#token').value, '');
});

test('a rejected settings save preserves edits and renders the background error safely', async (t) => {
  const { dom, root, ui } = setup(t, 'options', async (request) => request.type === 'settings:get'
    ? settingsReply()
    : { ok: false, error: 'Token validation failed: <b>invalid format</b>.' });
  await ui.ready;
  edit(dom, root, 'endpoint', 'http://localhost:4321');
  edit(dom, root, 'token', 'invalid-token-fixture');
  submit(dom, root);
  await ui.whenIdle();
  assert.equal(node<HTMLInputElement>(root, '#endpoint').value, 'http://localhost:4321');
  assert.equal(node<HTMLInputElement>(root, '#token').value, 'invalid-token-fixture');
  assert.equal(node(root, '.operation-error').textContent, 'Token validation failed: <b>invalid format</b>.');
  assert.equal(root.querySelector('b'), null);
  assert.equal(action(root, 'Save connection').disabled, false);
  assert.equal(action(root, 'Check connection').disabled, true);
  assert.doesNotMatch(node(root, '[role="status"]').textContent!, /saved/);
});

test('settings load failure can be recovered without enabling a form backed by unknown values', async (t) => {
  let available = false;
  const { root, ui } = setup(t, 'options', async (request) => {
    if (request.type === 'status') return { ok: true, status: snapshot() };
    return available ? settingsReply() : { ok: false, error: 'Local settings could not be read.' };
  });
  await ui.ready;
  assert.equal(node<HTMLInputElement>(root, '#endpoint').disabled, true);
  assert.equal(action(root, 'Save connection').disabled, true);
  assert.equal(action(root, 'Reload settings').hidden, false);
  await ui.refresh();
  assert.equal(node<HTMLInputElement>(root, '#endpoint').disabled, true);
  available = true;
  action(root, 'Reload settings').click();
  await ui.whenIdle();
  assert.equal(action(root, 'Reload settings').hidden, true);
  assert.equal(action(root, 'Save connection').disabled, false);
  assert.equal(node<HTMLInputElement>(root, '#token').value, fixtureToken);
});

test('settings-only replies refresh status, and a saved connection remains acknowledged when that refresh fails', async (t) => {
  const requests: UiRequest[] = [];
  let saved = false;
  const { dom, root, ui } = setup(t, 'options', async (request) => {
    requests.push(request);
    if (request.type === 'settings:get') return { ok: true, settings: { endpoint, token: fixtureToken } };
    if (request.type === 'settings:save') { saved = true; return { ok: true }; }
    if (saved) throw new Error('Status refresh unavailable.');
    return { ok: true, status: snapshot() };
  });
  await ui.ready;
  assert.equal(field(root, 'pending').textContent, '0');
  edit(dom, root, 'endpoint', 'http://localhost:4317');
  submit(dom, root);
  await ui.whenIdle();
  assert.match(node(root, '[role="status"]').textContent!, /saved locally; status could not be refreshed/);
  assert.match(node(root, '.operation-error').textContent!, /Status refresh unavailable/);
  assert.equal(node<HTMLElement>(root, '.stale-notice').hidden, false);
  assert.deepEqual(requests.map((request) => request.type), ['settings:get', 'status', 'settings:save', 'status']);
});

test('status notifications during an action are coalesced into one fresh snapshot', async (t) => {
  const checked = deferred<UiReply>();
  const requests: UiRequest[] = [];
  let afterCheck = false;
  const { root, ui } = setup(t, 'popup', async (request) => {
    requests.push(request);
    if (request.type === 'check') return checked.promise;
    return { ok: true, status: snapshot({ queue: { pending: afterCheck ? 5 : 0, blocked: 0, bytes: 500 } }) };
  });
  await ui.ready;
  action(root, 'Check connection').click();
  const refreshes = [ui.refresh(), ui.refresh(), ui.refresh()];
  afterCheck = true;
  checked.resolve({ ok: true, status: snapshot({ queue: { pending: 3, blocked: 0, bytes: 300 } }) });
  await Promise.all(refreshes);
  await ui.whenIdle();
  assert.deepEqual(requests.map((request) => request.type), ['status', 'check', 'status']);
  assert.equal(field(root, 'pending').textContent, '5');
  assert.equal(action(root, 'Refresh status').disabled, false);
});

test('status refreshes preserve unsaved connection edits and unmount clears the in-memory token', async (t) => {
  const { dom, root, ui } = setup(t, 'options', async (request) => request.type === 'settings:get'
    ? settingsReply()
    : { ok: true, status: snapshot({ endpoint: 'http://localhost:9876' }) });
  await ui.ready;
  edit(dom, root, 'endpoint', 'http://127.0.0.1:8765');
  edit(dom, root, 'token', 'unsaved-token-fixture');
  await ui.refresh();
  assert.equal(node<HTMLInputElement>(root, '#endpoint').value, 'http://127.0.0.1:8765');
  assert.equal(node<HTMLInputElement>(root, '#token').value, 'unsaved-token-fixture');
  assert.equal(field(root, 'endpoint').textContent, 'http://localhost:9876');
  assert.equal(action(root, 'Check connection').disabled, true);
  ui.destroy();
  assert.equal(node<HTMLInputElement>(root, '#token').value, '');
});

test('background status refreshes keep settings inputs enabled and preserve keyboard focus', async (t) => {
  const response = deferred<UiReply>();
  const { dom, root, ui } = setup(t, 'options', async (request) => request.type === 'settings:get'
    ? settingsReply() : response.promise);
  await ui.ready;
  const address = edit(dom, root, 'endpoint', 'http://localhost:4321');
  address.focus();
  const refreshed = ui.refresh();
  assert.equal(address.disabled, false);
  assert.equal(node<HTMLInputElement>(root, '#token').disabled, false);
  assert.equal(dom.window.document.activeElement, address);
  assert.equal(node(root, 'form').getAttribute('aria-busy'), 'false');
  edit(dom, root, 'endpoint', 'http://localhost:4322');
  response.resolve({ ok: true, status: snapshot() });
  await refreshed;
  assert.equal(address.value, 'http://localhost:4322');
  assert.equal(dom.window.document.activeElement, address);
  assert.equal(action(root, 'Check connection').disabled, true);
});

test('an in-flight response cannot mutate a destroyed UI or retain its worker token', async (t) => {
  const response = deferred<UiReply>();
  const requests: UiRequest[] = [];
  const { root, ui } = setup(t, 'options', (request) => { requests.push(request); return response.promise; });
  ui.destroy();
  const before = root.innerHTML;
  response.resolve(settingsReply());
  await ui.ready;
  await ui.refresh();
  assert.equal(root.innerHTML, before);
  assert.equal(node<HTMLInputElement>(root, '#token').value, '');
  assert.deepEqual(requests, [{ type: 'settings:get' }]);
});

test('each rendered page has semantic landmarks and exactly one canonical contact footer', async (t) => {
  const destinations = [
    'mailto:chirag@oriz.in', 'https://github.com/chirag127', 'https://www.linkedin.com/in/chirag127/',
    'https://x.com/singhal127', 'https://www.youtube.com/@ChiragSinghal127',
    'https://www.instagram.com/chiragsinghal127/', 'https://www.reddit.com/user/Far_Macaron_9910/',
    'https://buymeacoffee.com/chirag127',
  ];
  for (const mode of ['popup', 'options'] as const) {
    await t.test(mode, async (subtest) => {
      const { root, ui } = setup(subtest, mode, async (request) => request.type === 'settings:get'
        ? settingsReply() : { ok: true, status: snapshot() });
      await ui.ready;
      assert.equal(root.querySelectorAll('main').length, 1);
      assert.equal(root.querySelectorAll('h1').length, 1);
      assert.equal(root.querySelectorAll('footer').length, 1);
      const footer = node(root, 'footer.hire-me');
      assert.equal(node(footer, 'h3').textContent, 'Hire me');
      assert.match(footer.textContent!, /Chirag Singhal — building free, open APIs and tools/);
      assert.deepEqual(Array.from(footer.querySelectorAll('a'), (link) => link.getAttribute('href')), destinations);
      for (const section of root.querySelectorAll('section[aria-labelledby]')) {
        assert.ok(root.ownerDocument.getElementById(section.getAttribute('aria-labelledby')!));
      }
    });
  }
});

test('an unsupported retry deadline renders a retained-evidence pause without inventing a retry time', async (t) => {
  const { root, ui } = setup(t, 'popup', async () => ({
    ok: true,
    status: snapshot({ queue: { pending: 1, blocked: 0, bytes: 100, retryPaused: true } }),
  }));
  await ui.ready;
  assert.equal(field(root, 'pending').textContent, '1');
  assert.equal(field(root, 'next-retry').hidden, false);
  assert.match(field(root, 'next-retry').textContent!, /Automatic delivery is paused/);
  assert.equal(field(root, 'next-retry').querySelector('time'), null);
});
