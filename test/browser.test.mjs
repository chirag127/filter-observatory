import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { createSctlBrowser, recoverComparison, runComparison } from '../src/browser.mjs';

const BROWSER = '911191eba780cbd27b1799a72e6df6a4';
const ADGUARD = 'bgnkhhnnamicmpeenaelnjfhikgbkllg';
const UBOL = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const SCRIPT_CAT = 'abcdefghijklmnopabcdefghijklmnop';
const SPONSOR_BLOCK = 'ponmlkjihgfedcbaponmlkjihgfedcbaab';
const URL = 'https://example.com/article?quoted=%22%26%3B';
const clone = value => structuredClone(value);

function extensions(adguard = true, ubol = true) {
  return [
    { id: ADGUARD, name: 'AdGuard', version: '5.5.4.76', enabled: adguard },
    { id: UBOL, name: 'uBlock Origin Lite', version: '2026.1116.1650', enabled: ubol },
    { id: SCRIPT_CAT, name: 'ScriptCat', version: '1.0', enabled: true },
    { id: SPONSOR_BLOCK, name: 'SponsorBlock', version: '6.0', enabled: true },
  ];
}

const png = new PNG({ width: 2, height: 2 });
png.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
const PNG_BYTES = PNG.sync.write(png);

function evidence(url, condition, comparisonId, installed, pageState = 'usable') {
  return {
    schemaVersion: 1, id: `capture_${condition}`, source: 'audit', url,
    title: 'Example article', capturedAt: new Date().toISOString(),
    browser: { instance: BROWSER, name: 'Chrome', version: '158.0.0.0' },
    tab: { id: 100, windowId: 5 },
    images: [{ id: 'viewport', mimeType: 'image/png', width: 2, height: 2, dataBase64: PNG_BYTES.toString('base64') }],
    text: 'An example article with substantive content.',
    context: { condition, comparisonId, blockers: clone(installed), pageState },
    limitations: [],
  };
}

function memoryJournal(initial = null) {
  let current = clone(initial);
  return {
    writes: [], clears: 0,
    async read() { return clone(current); },
    async write(snapshot) { current = clone(snapshot); this.writes.push(clone(snapshot)); },
    async clear() { current = null; this.clears += 1; },
  };
}

function simulatedBrowser({ installed = extensions(), journal, onSet, onCapture, onInventory, onClose } = {}) {
  const state = clone(installed);
  const log = [];
  let inventoryCount = 0;
  const adapter = {
    async inventory() {
      inventoryCount += 1;
      await onInventory?.({ state, log, count: inventoryCount });
      return { browser: { instance: BROWSER, name: 'Chrome', version: '158.0.0.0' }, extensions: clone(state) };
    },
    async setEnabled(id, enabled) {
      assert.ok([ADGUARD, UBOL].includes(id), 'unrelated extensions must never be mutated');
      assert.ok(await journal.read(), 'a durable journal must exist at every mutation');
      log.push({ operation: 'set', id, enabled });
      const extension = state.find(item => item.id === id);
      assert.ok(extension, 'do not invent missing extensions');
      if (await onSet?.({ id, enabled, extension, state, log }) !== 'ignore') extension.enabled = enabled;
    },
    async capture(url, { condition, comparisonId, signal }) {
      signal?.throwIfAborted();
      const item = evidence(url, condition, comparisonId, state);
      log.push({ operation: 'capture', condition, states: clone(state) });
      await onCapture?.({ item, state, log, signal });
      return item;
    },
    async close() { log.push({ operation: 'close' }); await onClose?.(); },
  };
  return { adapter, state, log };
}

function enabledState(capture) {
  return [ADGUARD, UBOL].map(id => capture.context.blockers.find(item => item.id === id)?.enabled);
}

test('comparison captures installed and deterministic on/off/on conditions, then restores the exact original state', async () => {
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal });
  const original = clone(fixture.state);
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.deepEqual(result.captures.map(item => item.context.condition), ['installed', 'adguard-on', 'adguard-off', 'adguard-restored']);
  assert.deepEqual(result.captures.map(enabledState), [[true, true], [true, false], [false, false], [true, false]]);
  assert.equal(new Set(result.captures.map(item => item.context.comparisonId)).size, 1);
  assert.equal(result.state, 'completed');
  assert.equal(result.restoration.state, 'restored');
  assert.deepEqual(fixture.state, original);
  assert.equal(await journal.read(), null);
  assert.ok(journal.writes.length > 0);
  assert.deepEqual(journal.writes[0].original.map(item => [item.id, item.enabled]), [[ADGUARD, true], [UBOL, true]]);
});

for (const [adguard, ubol] of [[false, false], [false, true], [true, false]]) {
  test(`restoration preserves initially disabled states (AdGuard=${adguard}, uBOL=${ubol})`, async () => {
    const journal = memoryJournal();
    const fixture = simulatedBrowser({ journal, installed: extensions(adguard, ubol) });
    const original = clone(fixture.state);
    const result = await runComparison(fixture.adapter, URL, { journal });
    assert.equal(result.state, 'completed');
    assert.deepEqual(enabledState(result.captures[1]), [true, false]);
    assert.deepEqual(enabledState(result.captures[2]), [false, false]);
    assert.deepEqual(enabledState(result.captures[3]), [true, false]);
    assert.deepEqual(fixture.state, original);
    assert.equal(await journal.read(), null);
  });
}

test('isolateUbol=false leaves uBOL enabled and does not claim a fully isolated control', async () => {
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal });
  const result = await runComparison(fixture.adapter, URL, { journal, isolateUbol: false });
  assert.deepEqual(result.captures.map(enabledState), [[true, true], [true, true], [false, true], [true, true]]);
  assert.equal(fixture.log.some(item => item.operation === 'set' && item.id === UBOL), false);
  assert.ok(result.captures.every(item => item.context.prerequisites?.isolated !== true));
  assert.match(result.limitations.join(' '), /other|isolation|uBO/i);
});

test('partial mutation followed by a transport error is restored from the journal', async () => {
  const journal = memoryJournal();
  let once = true;
  const fixture = simulatedBrowser({ journal, onSet({ id, enabled, extension }) {
    if (id === UBOL && !enabled && once) {
      once = false;
      extension.enabled = false;
      throw new Error('lost response after applying disable');
    }
  } });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'failed');
  assert.equal(result.restoration.state, 'restored');
  assert.deepEqual(fixture.state, extensions());
  assert.equal(await journal.read(), null);
  assert.deepEqual(result.captures.map(item => item.context.condition), ['installed']);
});

test('capture failure during the off control still restores both blockers', async () => {
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal, onCapture({ item }) {
    if (item.context.condition === 'adguard-off') throw new Error('screenshot failed');
  } });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'failed');
  assert.equal(result.restoration.state, 'restored');
  assert.deepEqual(fixture.state, extensions());
  assert.equal(await journal.read(), null);
  assert.equal(result.captures.length, 2);
});

test('cancellation after a mutation waits for restoration and cannot cancel the restore', async () => {
  const journal = memoryJournal();
  const controller = new AbortController();
  const fixture = simulatedBrowser({ journal, onSet({ id, enabled }) {
    if (id === ADGUARD && !enabled) controller.abort();
  } });
  const result = await runComparison(fixture.adapter, URL, { journal, signal: controller.signal });
  assert.equal(result.state, 'failed');
  assert.equal(result.restoration.state, 'restored');
  assert.deepEqual(fixture.state, extensions());
  assert.equal(await journal.read(), null);
  assert.match(result.limitations.join(' '), /cancel|abort/i);
});

test('cancellation during control inventory prevents a new blocker mutation', async () => {
  const journal = memoryJournal();
  const controller = new AbortController();
  const fixture = simulatedBrowser({ journal, async onInventory() {
    if ((await journal.read())?.phase === 'adguard-on') controller.abort();
  } });
  const result = await runComparison(fixture.adapter, URL, { journal, signal: controller.signal });
  assert.equal(result.state, 'failed');
  assert.equal(fixture.log.some(item => item.operation === 'set'), false);
  assert.deepEqual(result.captures.map(item => item.context.condition), ['installed']);
  assert.equal(result.restoration.state, 'restored');
  assert.deepEqual(fixture.state, extensions());
  assert.equal(await journal.read(), null);
  assert.match(result.limitations.join(' '), /cancel|abort/i);
});

test('an already-cancelled comparison does not mutate or create a journal', async () => {
  const journal = memoryJournal();
  const controller = new AbortController();
  controller.abort();
  const fixture = simulatedBrowser({ journal });
  const result = await runComparison(fixture.adapter, URL, { journal, signal: controller.signal });
  assert.equal(result.state, 'failed');
  assert.equal(journal.writes.length, 0);
  assert.equal(fixture.log.some(item => item.operation === 'set'), false);
});

test('mutation acknowledgements are insufficient when inventory readback disagrees', async () => {
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal, onSet({ id, enabled }) {
    if (id === UBOL && !enabled) return 'ignore';
  } });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.captures.map(item => item.context.condition), ['installed']);
  assert.equal(result.restoration.state, 'restored');
  assert.deepEqual(fixture.state, extensions());
});

test('a failed restoration retains debt, refuses overwrite, and a fresh adapter can recover it', async () => {
  const journal = memoryJournal();
  let restoreBlocked = false;
  const fixture = simulatedBrowser({ journal, onCapture({ item }) {
    if (item.context.condition === 'adguard-off') {
      restoreBlocked = true;
      throw new Error('capture lost');
    }
  }, onSet({ id, enabled }) {
    if (restoreBlocked && id === ADGUARD && enabled) return 'ignore';
  } });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'failed');
  assert.equal(result.restoration.state, 'failed');
  assert.equal(fixture.state.find(item => item.id === ADGUARD).enabled, false);
  assert.equal(fixture.state.find(item => item.id === UBOL).enabled, true);
  const debt = await journal.read();
  assert.ok(debt);
  const writes = journal.writes.length;
  const blocked = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(blocked.state, 'failed');
  assert.equal(blocked.captures.length, 0);
  assert.equal(journal.writes.length, writes);
  assert.deepEqual(await journal.read(), debt);
  const fresh = simulatedBrowser({ journal, installed: fixture.state });
  const restoration = await recoverComparison(fresh.adapter, journal);
  assert.equal(restoration.state, 'restored');
  assert.deepEqual(fresh.state, extensions());
  assert.equal(await journal.read(), null);
  assert.equal(fresh.log.some(item => item.operation === 'capture'), false);
});

test('restoration continues with the other blocker after one restore command fails', async () => {
  const journal = memoryJournal();
  let restoring = false;
  const fixture = simulatedBrowser({ journal, onCapture({ item }) {
    if (item.context.condition === 'adguard-off') { restoring = true; throw new Error('capture failed'); }
  }, onSet({ id, enabled }) {
    if (restoring && id === ADGUARD && enabled) throw new Error('AdGuard restore unavailable');
  } });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.restoration.state, 'failed');
  assert.equal(fixture.state.find(item => item.id === UBOL).enabled, true);
  assert.ok(await journal.read());
});

test('a durable journal write failure cannot be followed by mutation', async () => {
  const journal = memoryJournal();
  journal.write = async () => { throw new Error('disk full'); };
  const fixture = simulatedBrowser({ journal });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'failed');
  assert.equal(fixture.log.some(item => item.operation === 'set'), false);
  assert.deepEqual(fixture.state, extensions());
});

test('failed final inventory readback retains the journal even after restore commands succeeded', async () => {
  const journal = memoryJournal();
  let denyInventory = false;
  const fixture = simulatedBrowser({ journal, onCapture({ item }) {
    if (item.context.condition === 'adguard-off') { denyInventory = true; throw new Error('capture failed'); }
  }, onInventory() { if (denyInventory) throw new Error('inventory unavailable'); } });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'failed');
  assert.equal(result.restoration.state, 'failed');
  assert.ok(await journal.read());
});

for (const pageState of ['challenge', 'login-required', 'unknown']) {
  test(`${pageState} acquisition is inconclusive, never a completed clean comparison`, async () => {
    const journal = memoryJournal();
    const fixture = simulatedBrowser({ journal, onCapture({ item }) { item.context.pageState = pageState; } });
    const result = await runComparison(fixture.adapter, URL, { journal });
    assert.equal(result.state, 'inconclusive');
    assert.equal(result.restoration.state, 'restored');
    assert.deepEqual(fixture.state, extensions());
  });
}

test('a changed final URL or extension version makes the comparison inconclusive', async () => {
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal, onCapture({ item, state }) {
    if (item.context.condition === 'adguard-off') {
      item.url = 'https://example.com/new-session';
      state.find(extension => extension.id === ADGUARD).version = '5.5.5.0';
      item.context.blockers = clone(state);
    }
  } });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'inconclusive');
  assert.equal(result.restoration.state, 'restored');
  assert.equal(await journal.read(), null);
});

test('missing AdGuard is unsupported for comparison and never causes unrelated mutations', async () => {
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal, installed: extensions().filter(item => item.id !== ADGUARD) });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'inconclusive');
  assert.equal(fixture.log.some(item => item.operation === 'set'), false);
  assert.equal(await journal.read(), null);
});

test('recovery refuses malformed or foreign-browser snapshots without changing the journal', async () => {
  for (const debt of [{}, { schemaVersion: 1, browser: { instance: 'another-browser' }, original: [{ id: SCRIPT_CAT, enabled: false }] }]) {
    const journal = memoryJournal(debt);
    const fixture = simulatedBrowser({ journal });
    const result = await recoverComparison(fixture.adapter, journal);
    assert.equal(result.state, 'failed');
    assert.deepEqual(await journal.read(), debt);
    assert.equal(fixture.log.some(item => item.operation === 'set'), false);
  }
});

test('recovery with no pending journal is an idempotent no-op', async () => {
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal });
  assert.equal((await recoverComparison(fixture.adapter, journal)).state, 'not-needed');
  assert.equal(fixture.log.length, 0);
});

function evalEnvelope(tabId, value, overrides = {}) {
  return { contentTrust: 'untrusted-page-content', navigated: false, tabId,
    title: value.title, url: value.url, value, ...overrides };
}

function sctlFixture({ intercept, metadata = {}, installed = extensions() } = {}) {
  const state = clone(installed);
  const tabs = new Map([[7, { tabId: 7, windowId: 5, url: 'https://unrelated.example/', title: 'User tab', active: true }]]);
  const commands = [];
  const files = [];
  let nextTab = 100;
  const execute = async (file, args, options) => {
    assert.match(file, /sctl(?:\.exe)?$/i);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(args.every(value => typeof value === 'string'));
    assert.equal(args[args.indexOf('--browser') + 1], BROWSER);
    assert.equal(args.includes('--activate'), false);
    assert.equal(args.includes('--all'), false);
    commands.push(clone(args));
    const command = `${args[0]} ${args[1]}`;
    const tabId = Number(args[args.indexOf('--tab') + 1]);
    const overridden = await intercept?.({ command, args, options, state, tabs, tabId, files });
    if (overridden !== undefined) return { stdout: typeof overridden === 'string' ? overridden : JSON.stringify(overridden), stderr: '' };
    let result;
    switch (command) {
      case 'extensions list': result = { contentTrust: 'untrusted-page-content', items: clone(state) }; break;
      case 'extensions enable':
      case 'extensions disable': {
        const id = args[2];
        assert.ok([ADGUARD, UBOL].includes(id));
        const enabled = args[1] === 'enable';
        if (!enabled) assert.ok(args.includes('--yes'));
        state.find(item => item.id === id).enabled = enabled;
        result = { id, enabled };
        break;
      }
      case 'tabs open': {
        assert.ok(args.includes('--background'));
        const id = nextTab++;
        tabs.set(id, { tabId: id, windowId: 5, url: args[2], title: '', active: false });
        result = { tabId: id };
        break;
      }
      case 'tabs list': result = { contentTrust: 'untrusted-page-content', tabs: [...tabs.values()] }; break;
      case 'page goto':
        assert.equal(args[args.indexOf('--wait') + 1], 'load');
        assert.ok(tabs.has(tabId));
        tabs.get(tabId).url = args[2];
        tabs.get(tabId).title = 'Example article';
        result = 'Navigation complete';
        break;
      case 'page eval': {
        assert.ok(tabs.has(tabId));
        const value = {
          url: tabs.get(tabId).url, title: tabs.get(tabId).title,
          timeOrigin: 123456, readyState: 'complete', contentType: 'text/html',
          userAgent: 'Mozilla/5.0 Chrome/158.0.0.0 Safari/537.36',
          status: 200, text: 'An example article with substantive readable content.',
          ...metadata,
        };
        // sctl 0.4.0 emits a display prefix by default and an envelope in JSON mode.
        result = args[args.indexOf('-o') + 1] === 'json'
          ? evalEnvelope(tabId, value) : `tab ${tabId}: ${JSON.stringify(value)}`;
        break;
      }
      case 'page snapshot': result = '- RootWebArea "Example article"\n  - heading "Example article"\n  - paragraph "Substantive content"'; break;
      case 'page screenshot': {
        assert.ok(tabs.has(tabId));
        assert.equal(args[args.indexOf('--format') + 1], 'png');
        const path = args[args.indexOf('--file') + 1];
        assert.ok(path);
        files.push(path);
        await writeFile(path, PNG_BYTES);
        result = `Saved ${path}`;
        break;
      }
      case 'page detach': assert.ok(tabs.has(tabId)); result = { tabIds: [tabId] }; break;
      case 'tabs close': {
        const id = Number(args[2]);
        assert.notEqual(id, 7, 'the existing user tab must never be closed');
        tabs.delete(id);
        result = { tabIds: [id] };
        break;
      }
      default: throw new Error(`Unapproved command in fixture: ${command}`);
    }
    return { stdout: typeof result === 'string' ? result : JSON.stringify(result), stderr: '' };
  };
  return { execute, state, tabs, commands, files };
}

test('sctl capture consumes JSON eval envelopes, preserves PNG bytes, and closes only its pinned background tab', async () => {
  const fixture = sctlFixture();
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  const capture = await adapter.capture(URL, { condition: 'installed', comparisonId: 'comparison_fixture', textLimit: 80 });
  assert.equal(capture.schemaVersion, 1);
  assert.equal(capture.source, 'audit');
  assert.equal(capture.url, URL);
  assert.equal(capture.title, 'Example article');
  assert.deepEqual(capture.tab, { id: 100, windowId: 5 });
  assert.equal(capture.browser.instance, BROWSER);
  assert.equal(capture.browser.name, 'Chrome');
  assert.equal(capture.browser.version, '158.0.0.0');
  assert.equal(capture.context.pageState, 'usable');
  assert.deepEqual(capture.context.blockers, extensions());
  assert.equal(capture.images[0].dataBase64, PNG_BYTES.toString('base64'));
  assert.equal(capture.images[0].width, 2);
  assert.equal(capture.images[0].height, 2);
  assert.ok(capture.text.length <= 80);
  assert.ok(fixture.commands.some(args => args[0] === 'page' && args[1] === 'goto' && args[2] === URL));
  for (const args of fixture.commands.filter(args => args[0] === 'page')) assert.equal(args[args.indexOf('--tab') + 1], '100');
  assert.deepEqual([...fixture.tabs.keys()], [7]);
  for (const path of fixture.files) await assert.rejects(stat(path), { code: 'ENOENT' });
  await adapter.close();
});

for (const [name, overrides] of [
  ['another tab', { tabId: 7 }],
  ['navigation during evaluation', { navigated: true }],
  ['a different envelope URL', { url: 'https://another.example/' }],
  ['missing evaluated value', { value: undefined }],
]) {
  test(`sctl eval rejects ${name} and cleans up the owned tab`, async () => {
    const fixture = sctlFixture({ intercept({ command, tabId, tabs }) {
      if (command !== 'page eval') return;
      return evalEnvelope(tabId, {
        url: tabs.get(tabId).url, title: 'Example article', timeOrigin: 123456,
        readyState: 'complete', contentType: 'text/html', status: 200,
        userAgent: 'Chrome/158.0.0.0', text: 'Substantive content',
      }, overrides);
    } });
    const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
    await assert.rejects(adapter.capture(URL, { condition: 'installed' }), /tab|navigation|metadata|value|URL/i);
    assert.deepEqual([...fixture.tabs.keys()], [7]);
    assert.equal(fixture.commands.some(args => args[0] === 'page' && args[1] === 'screenshot'), false);
  });
}

test('sctl adapter also accepts the native callback-style execFile injection', async () => {
  const fixture = sctlFixture();
  const execFileImpl = (file, args, options, callback) => {
    fixture.execute(file, args, options).then(({ stdout, stderr }) => callback(null, stdout, stderr), callback);
  };
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl });
  assert.deepEqual((await adapter.inventory()).extensions, extensions());
});

test('sctl adapter forbids unrelated extension changes before executing any command', async () => {
  const fixture = sctlFixture();
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.setEnabled(SCRIPT_CAT, false));
  await assert.rejects(adapter.setEnabled(SPONSOR_BLOCK, false));
  assert.equal(fixture.commands.length, 0);
});

test('sctl adapter rejects implicit browsers and unsafe URLs before any command', async () => {
  assert.throws(() => createSctlBrowser({}));
  const fixture = sctlFixture();
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  for (const url of ['file:///C:/private', 'javascript:alert(1)', 'https://user:secret@example.com/', 'https://example.com/\n']) {
    await assert.rejects(adapter.capture(url, { condition: 'installed' }));
  }
  assert.equal(fixture.commands.length, 0);
});

test('sctl mutation responses are verified by a separate extension inventory', async () => {
  const fixture = sctlFixture({ intercept({ command }) {
    if (command === 'extensions disable') return { id: ADGUARD, enabled: false };
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.setEnabled(ADGUARD, false), /readback|state|enabled/i);
  assert.equal(fixture.state[0].enabled, true);
});

test('snapshot bridge errors cannot turn into empty successful captures', async () => {
  const fixture = sctlFixture({ intercept({ command }) {
    if (command === 'page snapshot') return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'snapshot inaccessible' };
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.capture(URL, { condition: 'installed' }), /snapshot|PAYLOAD_TOO_LARGE/i);
  assert.deepEqual([...fixture.tabs.keys()], [7]);
  assert.ok(fixture.commands.some(args => args[0] === 'page' && args[1] === 'detach'));
});

test('challenge pages remain challenge captures and do not trigger interactive recovery', async () => {
  const fixture = sctlFixture({ metadata: { text: 'Verify you are human before continuing', title: 'Just a moment...' } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  const capture = await adapter.capture(URL, { condition: 'installed' });
  assert.equal(capture.context.pageState, 'challenge');
  assert.equal(fixture.commands.some(args => ['click', 'activate'].includes(args[1])), false);
});

test('HTTP error documents and unavailable navigation status cannot be usable', async () => {
  for (const status of [403, 404, 429, 500, 0]) {
    const fixture = sctlFixture({ metadata: { status } });
    const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
    const capture = await adapter.capture(URL, { condition: 'installed' });
    assert.notEqual(capture.context.pageState, 'usable');
  }
});

test('PAGE_HIDDEN failure cleans up without activating the user browser', async () => {
  const fixture = sctlFixture({ intercept({ command }) {
    if (command === 'page screenshot') throw Object.assign(new Error('PAGE_HIDDEN'), { code: 'PAGE_HIDDEN' });
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.capture(URL, { condition: 'installed' }));
  assert.deepEqual([...fixture.tabs.keys()], [7]);
  assert.ok(fixture.commands.every(args => !args.includes('--activate')));
});

test('same-URL navigation during the screenshot is rejected by document time-origin readback', async () => {
  let reads = 0;
  const fixture = sctlFixture({ intercept({ command, tabs, tabId }) {
    if (command === 'page eval' && ++reads === 2) return evalEnvelope(tabId, {
      url: tabs.get(tabId).url, title: 'Example article', timeOrigin: 999999,
      readyState: 'complete', contentType: 'text/html', status: 200,
      userAgent: 'Chrome/158.0.0.0', text: 'Replaced document',
    });
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.capture(URL, { condition: 'installed' }), /document|navigation|changed/i);
  assert.deepEqual([...fixture.tabs.keys()], [7]);
});

test('corrupt screenshot bytes are rejected and the temporary file is removed', async () => {
  const fixture = sctlFixture({ async intercept({ command, args, files }) {
    if (command === 'page screenshot') {
      const path = args[args.indexOf('--file') + 1];
      files.push(path);
      await writeFile(path, 'not a PNG');
      return 'Saved';
    }
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.capture(URL, { condition: 'installed' }), /PNG|image/i);
  for (const path of fixture.files) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual([...fixture.tabs.keys()], [7]);
});

test('cancelling an in-flight capture still detaches and closes with an uncancelled cleanup', async () => {
  const controller = new AbortController();
  const fixture = sctlFixture({ intercept({ command, options }) {
    if (command === 'page snapshot') { controller.abort(); throw controller.signal.reason; }
    if (command === 'page detach' || command === 'tabs close') assert.equal(options.signal, undefined);
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.capture(URL, { condition: 'installed', signal: controller.signal }));
  assert.deepEqual([...fixture.tabs.keys()], [7]);
});

test('a close failure stays visible and adapter.close retries only the owned tab', async () => {
  let fail = true;
  const fixture = sctlFixture({ intercept({ command }) {
    if (command === 'tabs close' && fail) { fail = false; throw new Error('close unavailable'); }
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.capture(URL, { condition: 'installed' }), /cleanup|close/i);
  assert.ok(fixture.tabs.has(100));
  await adapter.close();
  assert.deepEqual([...fixture.tabs.keys()], [7]);
});

test('journal serialized before the off mutation can restore an interrupted run after a fresh process', async t => {
  await mkdir(join(tmpdir(), 'opencode'), { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'opencode', 'filter-observatory-browser-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const journal = memoryJournal();
  const fixture = simulatedBrowser({ journal });
  await runComparison(fixture.adapter, URL, { journal });
  const snapshot = journal.writes.find(item => item.phase === 'adguard-off');
  assert.ok(snapshot, 'the off intent must be durable before disabling AdGuard');
  await writeFile(path, JSON.stringify(snapshot));
  const diskJournal = {
    async read() { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async write(value) { await writeFile(path, JSON.stringify(value)); },
    async clear() { await rm(path); },
  };
  const restarted = simulatedBrowser({ journal: diskJournal, installed: extensions(false, false) });
  const result = await recoverComparison(restarted.adapter, diskJournal);
  assert.equal(result.state, 'restored');
  assert.deepEqual(restarted.state, extensions());
  assert.equal(await diskJournal.read(), null);
  assert.equal(restarted.log.some(item => item.operation === 'capture'), false);
});

test('an acknowledged but unpersisted off intent cannot be followed by disabling AdGuard', async () => {
  const journal = memoryJournal();
  const persist = journal.write.bind(journal);
  journal.write = async snapshot => { if (snapshot.phase !== 'adguard-off') await persist(snapshot); };
  const fixture = simulatedBrowser({ journal });
  const result = await runComparison(fixture.adapter, URL, { journal });
  assert.equal(result.state, 'failed');
  assert.equal(fixture.log.some(item => item.operation === 'set' && item.id === ADGUARD && !item.enabled), false);
  assert.equal(result.restoration.state, 'restored');
  assert.deepEqual(fixture.state, extensions());
  assert.equal(await journal.read(), null);
});

test('a tab-open response naming an existing user tab cannot authorize navigating or closing it', async () => {
  const fixture = sctlFixture({ intercept({ command, args, tabs }) {
    if (command === 'tabs open') {
      tabs.set(100, { tabId: 100, windowId: 5, url: args[2], title: '', active: false });
      return { tabId: 7 };
    }
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  await assert.rejects(adapter.capture(URL, { condition: 'installed' }), /identity|owned|open/i);
  assert.equal(fixture.tabs.get(7).url, 'https://unrelated.example/');
  assert.equal(fixture.commands.some(args => args[0] === 'page' && args[args.indexOf('--tab') + 1] === '7'), false);
  assert.deepEqual([...fixture.tabs.keys()], [7]);
});

test('a lost close response is reconciled by tab inventory without closing unrelated tabs', async () => {
  const fixture = sctlFixture({ intercept({ command, args, tabs }) {
    if (command === 'tabs close') {
      tabs.delete(Number(args[2]));
      throw new Error('close applied but response lost');
    }
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  const capture = await adapter.capture(URL, { condition: 'installed' });
  assert.equal(capture.tab.id, 100);
  assert.deepEqual([...fixture.tabs.keys()], [7]);
  const closeCount = fixture.commands.filter(args => args[0] === 'tabs' && args[1] === 'close').length;
  await adapter.close();
  assert.equal(fixture.commands.filter(args => args[0] === 'tabs' && args[1] === 'close').length, closeCount);
});

test('a same-document challenge appearing during capture cannot retain an earlier usable classification', async () => {
  let reads = 0;
  const fixture = sctlFixture({ intercept({ command, tabs, tabId }) {
    if (command === 'page eval' && ++reads === 2) return evalEnvelope(tabId, {
      url: tabs.get(tabId).url, title: 'Just a moment...', timeOrigin: 123456,
      readyState: 'complete', contentType: 'text/html', status: 200,
      userAgent: 'Mozilla/5.0 Chrome/158.0.0.0 Safari/537.36',
      text: 'Verify you are human before continuing',
    });
  } });
  const adapter = createSctlBrowser({ browser: BROWSER, execFileImpl: fixture.execute });
  const capture = await adapter.capture(URL, { condition: 'installed' });
  assert.equal(capture.context.pageState, 'challenge');
  assert.deepEqual([...fixture.tabs.keys()], [7]);
});

test('different adapters and journals cannot run profile-wide comparisons concurrently', async () => {
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const journal = memoryJournal();
  const first = simulatedBrowser({ journal, async onCapture({ item }) {
    if (item.context.condition === 'installed') { enter(); await paused; }
  } });
  const pending = runComparison(first.adapter, URL, { journal });
  try {
    await entered;
    const otherJournal = memoryJournal();
    const second = simulatedBrowser({ journal: otherJournal });
    const result = await runComparison(second.adapter, URL, { journal: otherJournal });
    assert.equal(result.state, 'failed');
    assert.match(result.limitations.join(' '), /browser_busy/);
    assert.equal(otherJournal.writes.length, 0);
    assert.equal(second.log.length, 0);
  } finally { release(); }
  assert.equal((await pending).state, 'completed');
  assert.deepEqual(first.state, extensions());
});

test('recovery refuses a structurally valid journal for a different browser identity', async () => {
  const journal = memoryJournal();
  const original = simulatedBrowser({ journal });
  await runComparison(original.adapter, URL, { journal });
  const debt = clone(journal.writes[0]);
  debt.browser.instance = '0'.repeat(32);
  const foreignJournal = memoryJournal(debt);
  const fixture = simulatedBrowser({ journal: foreignJournal, installed: extensions(false, false) });
  const result = await recoverComparison(fixture.adapter, foreignJournal);
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'browser_identity_mismatch');
  assert.equal(fixture.log.length, 0);
  assert.deepEqual(await foreignJournal.read(), debt);
});
