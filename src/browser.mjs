import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_LIMITS, stableJson, validateCapture } from './capture.mjs';

const ADGUARD = 'bgnkhhnnamicmpeenaelnjfhikgbkllg';
const UBOL = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const MUTABLE = [ADGUARD, UBOL];
const CONDITIONS = ['installed', 'adguard-on', 'adguard-off', 'adguard-restored'];
const INSTANCE = /^[a-f0-9]{32}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,96}$/;
const activeAdapters = new WeakSet();
const activeJournals = new WeakSet();
const activeBrowsers = new Set();
const comparisonLimits = [
  'Whole-extension controls only; per-list settings, site protection and loaded ruleset revisions are unknown.',
  'AdGuard-off is not completely unfiltered; other extensions, userscripts, DNS and network filtering may remain.',
  'Conditions use fresh owned background tabs in a shared signed-in profile; cache and dynamic content can carry across loads.',
];

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function reason(error) {
  if (error?.name === 'AbortError') return 'cancelled';
  return typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : 'operation_failed';
}
function checkAbort(signal) {
  if (signal?.aborted) throw problem('cancelled', 'Comparison or capture cancelled');
}
function webUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw problem('invalid_url', 'URL must be HTTP(S) without whitespace or credentials');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw problem('invalid_url', 'Invalid page URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw problem('invalid_url', 'URL must be HTTP(S) without credentials');
  }
  return parsed.href;
}
function extensionRecords(items) {
  if (!Array.isArray(items) || items.length > 200) throw problem('invalid_inventory', 'Extension inventory is unavailable or unsupported');
  const seen = new Set();
  return items.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || seen.has(item.id)
      || typeof item.name !== 'string' || item.name.length > 300 || typeof item.version !== 'string'
      || item.version.length > 160 || typeof item.enabled !== 'boolean') {
      throw problem('invalid_inventory', 'Extension inventory lacks unique IDs or explicit enabled-state readback');
    }
    seen.add(item.id);
    return { id: item.id, name: item.name, version: item.version, enabled: item.enabled };
  });
}
function inventoryRecord(value) {
  if (!INSTANCE.test(value?.browser?.instance ?? '')) throw problem('browser_identity_unknown', 'A full pinned browser instance ID is required');
  return { browser: { ...value.browser }, extensions: extensionRecords(value.extensions) };
}
function enabledMatches(actual, expected) {
  return expected.every(item => actual.find(candidate => candidate.id === item.id)?.enabled === item.enabled);
}
function sameInventory(a, b) {
  const ordered = items => [...items].sort((x, y) => x.id.localeCompare(y.id));
  return stableJson(ordered(a)) === stableJson(ordered(b));
}

function invoke(implementation, file, args, options) {
  return new Promise((resolve, reject) => {
    const callback = (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr });
    try {
      const pending = implementation(file, args, options, callback);
      if (pending?.then) pending.then(resolve, reject);
    } catch (error) { reject(error); }
  });
}
function parseOutput(stdout, operation, json) {
  if (typeof stdout !== 'string' && !Buffer.isBuffer(stdout)) throw problem('invalid_bridge_response', `${operation}: missing stdout`);
  const text = stdout.toString().replace(/^\uFEFF/, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* The documented page commands also return plain text. */ }
  if (parsed && typeof parsed === 'object' && (parsed.ok === false || parsed.error)) {
    const code = reason(parsed.error ?? parsed);
    throw problem(code, `${operation} failed (${code})`);
  }
  if (/^Error\s*:/i.test(text)) throw problem('bridge_error', `${operation}: bridge reported an error`);
  if (json && parsed === undefined) throw problem('invalid_bridge_response', `${operation}: expected JSON`);
  return json ? parsed : text;
}

function metadataExpression(textLimit) {
  return `(() => ({ url: location.href, title: document.title, timeOrigin: performance.timeOrigin,
    readyState: document.readyState, contentType: document.contentType, userAgent: navigator.userAgent,
    status: performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0,
    text: (document.body?.innerText ?? '').slice(0, ${textLimit}) }))()`;
}
function metadataRecord(result, tabId) {
  if (result?.tabId !== tabId) throw problem('tab_identity_mismatch', 'Page eval response belongs to a different tab');
  if (result.navigated !== false) throw problem('navigation_changed', 'Page navigation during evaluation could not be excluded');
  const value = result.value;
  if (!value || typeof value !== 'object' || typeof value.title !== 'string' || typeof value.text !== 'string'
    || typeof value.userAgent !== 'string' || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0
    || typeof value.readyState !== 'string' || typeof value.contentType !== 'string') {
    throw problem('invalid_page_metadata', 'Page eval did not return the requested document metadata');
  }
  const url = webUrl(value.url);
  if (webUrl(result.url) !== url) throw problem('navigation_changed', 'Page eval envelope and evaluated URL disagree');
  return { ...value, url };
}
function browserFromUserAgent(userAgent, instance) {
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  const chrome = /Chrome\/([\d.]+)/.exec(userAgent);
  const firefox = /Firefox\/([\d.]+)/.exec(userAgent);
  return { instance, name: edge ? 'Edge' : chrome ? 'Chrome' : firefox ? 'Firefox' : 'unknown',
    version: (edge ?? chrome ?? firefox)?.[1] ?? 'unknown' };
}
function pageState(metadata, snapshot) {
  const content = `${metadata.title}\n${metadata.text}\n${snapshot}`;
  if (/verify (?:that )?you are human|checking (?:your )?browser|just a moment|security verification|captcha|unusual traffic/i.test(content)) return 'challenge';
  if (/\b(?:sign|log) in (?:to (?:continue|view|access)|required)|authentication required|please (?:sign|log) in/i.test(content)) return 'login-required';
  if (metadata.readyState !== 'complete' || !['text/html', 'application/xhtml+xml'].includes(metadata.contentType)
    || !Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status >= 400
    || !metadata.text.trim() || !snapshot.trim()) return 'unknown';
  return 'usable';
}

export function createSctlBrowser({ browser, execFileImpl = execFile } = {}) {
  // Names and prefixes can be reassigned; durable restoration must target the full pairing identity.
  if (typeof browser !== 'string' || !INSTANCE.test(browser)) throw problem('invalid_browser', 'Use the full 32-character sctl browser instance ID');
  if (typeof execFileImpl !== 'function') throw new TypeError('execFileImpl must be a function');
  const ownedTabs = new Set();
  const ownedDirectories = new Set();
  const captures = new Set();
  let browserMetadata = { instance: browser, name: 'unknown', version: 'unknown' };

  async function command(args, { signal, json = false } = {}) {
    checkAbort(signal);
    const argv = [...args, '--browser', browser];
    if (json) argv.push('-o', 'json');
    if (args[0] === 'page') argv.push('--timeout', '30s');
    let output;
    try {
      output = await invoke(execFileImpl, process.platform === 'win32' ? 'sctl.exe' : 'sctl', argv, {
        shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024,
        timeout: 45_000, ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw problem(signal?.aborted ? 'cancelled' : reason(error), `${args[0]} ${args[1]} failed (${signal?.aborted ? 'cancelled' : reason(error)})`);
    }
    return parseOutput(output?.stdout, `${args[0]} ${args[1]}`, json);
  }
  async function inventory() {
    const result = await command(['extensions', 'list'], { json: true });
    return { browser: { ...browserMetadata }, extensions: extensionRecords(result?.items) };
  }
  async function tabList() {
    const result = await command(['tabs', 'list'], { json: true });
    if (!Array.isArray(result?.tabs)) throw problem('invalid_tab_inventory', 'Unsupported tabs list response');
    return result.tabs;
  }
  async function tabReadback(tabId) {
    const matches = (await tabList()).filter(item => item.tabId === tabId);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].windowId) || matches[0].windowId < 0) {
      throw problem('tab_identity_unknown', 'Owned tab identity is unavailable');
    }
    return { ...matches[0], url: webUrl(matches[0].url) };
  }
  async function cleanupTab(tabId) {
    if (!ownedTabs.has(tabId)) return;
    const errors = [];
    try { await command(['page', 'detach', '--tab', String(tabId)]); } catch (error) { errors.push(error); }
    try { await command(['tabs', 'close', String(tabId)]); } catch (error) { errors.push(error); }
    try {
      if ((await tabList()).some(item => item.tabId === tabId)) throw problem('tab_close_mismatch', 'Owned tab remains open after close');
      ownedTabs.delete(tabId);
      // Tab removal also releases its debugger; a lost acknowledgement is reconciled by this readback.
      return;
    } catch (error) { errors.push(error); }
    throw problem('cleanup_failed', `Owned tab cleanup failed (${errors.map(reason).join(', ')})`);
  }
  async function removeDirectory(directory) {
    await rm(directory, { recursive: true, force: true });
    ownedDirectories.delete(directory);
  }
  async function capturePage(url, { condition = 'installed', comparisonId, signal, textLimit = 20_000 } = {}) {
    url = webUrl(url);
    if (!CONDITIONS.includes(condition) || (comparisonId !== undefined && !IDENTIFIER.test(comparisonId))) throw problem('invalid_capture_context', 'Invalid condition or comparison ID');
    if (!Number.isInteger(textLimit) || textLimit < 1 || textLimit > 100_000) throw problem('invalid_text_limit', 'textLimit must be an integer from 1 to 100000');
    checkAbort(signal);
    const initial = await inventory();
    let tabId;
    let directory;
    let result;
    let failure;
    const marker = `about:blank#filter-observatory-${randomUUID()}`;
    const existingTabs = new Set((await tabList()).map(item => item.tabId));
    try {
      checkAbort(signal);
      // Do not abort creation between applying it and receiving the only tab ID. Reconcile a lost response once by the unique marker.
      try {
        const opened = await command(['tabs', 'open', marker, '--background'], { json: true });
        if (!Number.isSafeInteger(opened?.tabId) || opened.tabId < 0 || existingTabs.has(opened.tabId)) {
          throw problem('invalid_open_response', 'tabs open did not identify a new owned tab');
        }
        const matches = (await tabList()).filter(item => item.tabId === opened.tabId && item.url === marker && item.active === false);
        if (matches.length !== 1) throw problem('tab_identity_unknown', 'Opened background tab identity could not be verified');
        tabId = opened.tabId;
        ownedTabs.add(tabId);
      } catch (error) {
        const matches = (await tabList()).filter(item => item.url === marker && item.active === false
          && Number.isSafeInteger(item.tabId) && item.tabId >= 0 && !existingTabs.has(item.tabId));
        for (const tab of matches) ownedTabs.add(tab.tabId);
        for (const tab of matches) await cleanupTab(tab.tabId);
        throw error;
      }
      checkAbort(signal);
      await command(['page', 'goto', url, '--wait', 'load', '--tab', String(tabId)], { signal });
      const tabBefore = await tabReadback(tabId);
      const expression = metadataExpression(textLimit);
      const before = metadataRecord(await command(['page', 'eval', expression, '--tab', String(tabId)], { signal, json: true }), tabId);
      if (before.url !== tabBefore.url) throw problem('navigation_changed', 'Page and owned tab URL disagree');
      const snapshot = await command(['page', 'snapshot', '--tab', String(tabId)], { signal });
      if (snapshot && !/^\s*-\s+[A-Za-z]/.test(snapshot)) throw problem('invalid_snapshot', 'Unsupported accessibility snapshot response');
      const root = join(tmpdir(), 'opencode');
      await mkdir(root, { recursive: true });
      directory = await mkdtemp(join(root, 'filter-observatory-capture-'));
      ownedDirectories.add(directory);
      const imagePath = join(directory, 'viewport.png');
      await command(['page', 'screenshot', '--format', 'png', '--file', imagePath, '--tab', String(tabId)], { signal });
      const after = metadataRecord(await command(['page', 'eval', expression, '--tab', String(tabId)], { signal, json: true }), tabId);
      const tabAfter = await tabReadback(tabId);
      if (before.timeOrigin !== after.timeOrigin || before.url !== after.url || tabAfter.url !== after.url || tabBefore.windowId !== tabAfter.windowId) {
        throw problem('navigation_changed', 'Document or tab attribution changed during capture');
      }
      checkAbort(signal);
      const size = (await stat(imagePath)).size;
      if (size < 33 || size > CAPTURE_LIMITS.imageBytes) throw problem('invalid_image', 'PNG image size is invalid');
      const bytes = await readFile(imagePath);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw problem('invalid_image', 'Screenshot is not a PNG image');
      const final = await inventory();
      browserMetadata = browserFromUserAgent(before.userAgent, browser);
      const limitations = [
        'Viewport capture in an owned background tab; no scrolling, clicks or activation were performed.',
        'Browser name/version are page-observed user-agent values and may be reduced or overridden.',
        'Document continuity uses URL, window and page time-origin readback; dynamic content and changes away and back are not excluded.',
        'Page state uses bounded text and HTTP response-status heuristics; unknown status is not a clean pass.',
        'Enabled extension state does not verify AdGuard site protection, filter selections or loaded ruleset revisions.',
        'Other extensions and userscripts remain installed; screenshots may contain signed-in information and are not redacted.',
      ];
      const observedStates = [pageState(before, snapshot), pageState(after, snapshot)];
      let observedState = ['challenge', 'login-required', 'unknown', 'usable'].find(state => observedStates.includes(state));
      if (observedStates[0] !== observedStates[1]) limitations.push(`Page state changed during capture: ${observedStates[0]} to ${observedStates[1]}.`);
      if (!sameInventory(initial.extensions, final.extensions) || before.userAgent !== after.userAgent) {
        if (observedState === 'usable') observedState = 'unknown';
        limitations.push('Browser or extension readback changed during capture.');
      }
      if (before.text.length + snapshot.length > textLimit) limitations.push(`DOM/accessibility text was bounded to ${textLimit} characters.`);
      if (observedState !== 'usable') limitations.push(`Acquisition page state: ${observedState}.`);
      result = validateCapture({
        schemaVersion: 1, id: randomUUID(), source: 'audit', url: tabBefore.url, title: before.title.slice(0, 2000),
        capturedAt: new Date().toISOString(), browser: { ...browserMetadata }, tab: { id: tabId, windowId: tabBefore.windowId },
        images: [{ id: 'viewport', mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), dataBase64: bytes.toString('base64') }],
        text: `${before.text}\n${snapshot}`.slice(0, textLimit),
        context: { condition, ...(comparisonId ? { comparisonId } : {}), blockers: initial.extensions, pageState: observedState, sensitivity: 'unknown' },
        limitations,
      });
    } catch (error) { failure = error; }
    const cleanupErrors = [];
    if (directory) { try { await removeDirectory(directory); } catch (error) { cleanupErrors.push(error); } }
    if (tabId !== undefined) { try { await cleanupTab(tabId); } catch (error) { cleanupErrors.push(error); } }
    if (cleanupErrors.length) throw problem('cleanup_failed', `Capture cleanup failed (${[failure, ...cleanupErrors].filter(Boolean).map(reason).join(', ')})`);
    if (failure) throw failure;
    return result;
  }
  return {
    inventory,
    capture(url, options) {
      const pending = capturePage(url, options);
      captures.add(pending);
      pending.then(() => captures.delete(pending), () => captures.delete(pending));
      return pending;
    },
    async setEnabled(extensionId, enabled) {
      if (!MUTABLE.includes(extensionId) || typeof enabled !== 'boolean') throw problem('unsupported_control', 'Only whole-extension AdGuard and uBOL enabled states are supported');
      const before = await inventory();
      const current = before.extensions.find(item => item.id === extensionId);
      if (!current) throw problem('extension_missing', 'The requested extension is not installed');
      if (current.enabled !== enabled) await command(['extensions', enabled ? 'enable' : 'disable', extensionId, ...(!enabled ? ['--yes'] : [])]);
      const after = await inventory();
      if (after.extensions.find(item => item.id === extensionId)?.enabled !== enabled) throw problem('enabled_readback_mismatch', 'Extension enabled-state readback disagrees with the requested state');
      return after;
    },
    async close() {
      await Promise.allSettled([...captures]);
      const errors = [];
      for (const tabId of [...ownedTabs]) { try { await cleanupTab(tabId); } catch (error) { errors.push(error); } }
      for (const directory of [...ownedDirectories]) { try { await removeDirectory(directory); } catch (error) { errors.push(error); } }
      if (errors.length) throw problem('cleanup_failed', `Owned resource cleanup failed (${errors.map(reason).join(', ')})`);
    },
  };
}

function checkJournal(journal) {
  if (!journal || !['read', 'write', 'clear'].every(key => typeof journal[key] === 'function')) throw problem('invalid_journal', 'A durable read/write/clear journal is required');
}
function checkSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.kind !== 'filter-observatory-comparison'
    || !INSTANCE.test(snapshot.browser?.instance ?? '') || !IDENTIFIER.test(snapshot.comparisonId ?? '')
    || !CONDITIONS.includes(snapshot.phase) || typeof snapshot.isolateUbol !== 'boolean'
    || !Array.isArray(snapshot.original) || !snapshot.original.length || snapshot.original.length > 2) {
    throw problem('invalid_journal', 'Pending comparison journal is malformed or unsupported');
  }
  const original = extensionRecords(snapshot.original);
  if (!original.some(item => item.id === ADGUARD) || original.some(item => !MUTABLE.includes(item.id))) {
    throw problem('invalid_journal', 'Pending journal contains unsupported extension controls');
  }
  return original;
}
function sameDebt(a, b) {
  return a?.comparisonId === b.comparisonId && a?.browser?.instance === b.browser.instance
    && stableJson(a?.original) === stableJson(b.original);
}
function acquire(adapter, journal) {
  checkJournal(journal);
  if (!adapter || !['inventory', 'capture', 'setEnabled', 'close'].every(key => typeof adapter[key] === 'function')) throw problem('invalid_adapter', 'Invalid browser adapter');
  if (activeAdapters.has(adapter) || activeJournals.has(journal)) throw problem('browser_busy', 'A comparison or recovery is already active');
  activeAdapters.add(adapter);
  activeJournals.add(journal);
}
function lockBrowser(instance) {
  if (activeBrowsers.has(instance)) throw problem('browser_busy', 'A comparison or recovery already owns this browser');
  activeBrowsers.add(instance);
}

async function restoreOriginal(adapter, journal, snapshot, knownIdentity) {
  const limitations = [];
  try {
    const original = checkSnapshot(snapshot);
    if (!sameDebt(await journal.read(), snapshot)) throw problem('journal_changed', 'The pending restoration journal changed');
    let before;
    try { before = inventoryRecord(await adapter.inventory()); }
    catch (error) {
      if (knownIdentity !== snapshot.browser.instance) throw error;
      limitations.push(`Pre-restoration inventory unavailable (${reason(error)}); attempting the recorded originals.`);
    }
    if (before && before.browser.instance !== snapshot.browser.instance) throw problem('browser_identity_mismatch', 'Recovery targets a different browser');
    for (const expected of original) {
      const observed = before?.extensions.find(item => item.id === expected.id);
      if (before && !observed) { limitations.push(`Original extension ${expected.id} is missing.`); continue; }
      if (observed?.enabled === expected.enabled) continue;
      try { await adapter.setEnabled(expected.id, expected.enabled); }
      catch (error) { limitations.push(`Restoration command for ${expected.id} failed (${reason(error)}).`); }
    }
    const after = inventoryRecord(await adapter.inventory());
    if (after.browser.instance !== snapshot.browser.instance || !enabledMatches(after.extensions, original)) {
      throw problem('restoration_mismatch', 'Original extension states could not be verified by inventory readback');
    }
    if (!sameDebt(await journal.read(), snapshot)) throw problem('journal_changed', 'Restoration journal changed before clear');
    await journal.clear();
    if (await journal.read() != null) throw problem('journal_clear_failed', 'Restoration journal remains pending');
    return { state: 'restored', browser: snapshot.browser.instance, extensions: original.map(item => ({ id: item.id, enabled: item.enabled })), limitations };
  } catch (error) {
    return { state: 'failed', reason: reason(error), limitations: [...limitations, `Restoration unverified (${reason(error)}); retain the journal for recovery.`] };
  }
}

export async function runComparison(adapter, url, { journal, signal, isolateUbol = true } = {}) {
  const result = { state: 'failed', captures: [], restoration: { state: 'not-needed' }, limitations: [...comparisonLimits] };
  let acquired = false;
  let lockedBrowser;
  let snapshot;
  let journalOwned = false;
  let inconclusive = false;
  let canCleanup = false;
  try {
    url = webUrl(url);
    checkAbort(signal);
    if (typeof isolateUbol !== 'boolean') throw problem('invalid_isolation', 'isolateUbol must be a boolean');
    acquire(adapter, journal);
    acquired = true;
    if (await journal.read() != null) throw problem('recovery_required', 'A pending comparison journal requires recovery before another run');
    const initial = inventoryRecord(await adapter.inventory());
    lockBrowser(initial.browser.instance);
    lockedBrowser = initial.browser.instance;
    canCleanup = true;
    const original = MUTABLE.map(id => initial.extensions.find(item => item.id === id)).filter(Boolean);
    if (!original.some(item => item.id === ADGUARD)) {
      result.state = 'inconclusive';
      result.limitations.push('AdGuard is not installed; the authorized comparison is unsupported.');
      return result;
    }
    checkAbort(signal);
    snapshot = { schemaVersion: 1, kind: 'filter-observatory-comparison', comparisonId: randomUUID(),
      browser: { ...initial.browser }, url, createdAt: new Date().toISOString(), phase: 'installed', isolateUbol,
      original: structuredClone(original), intent: [], restore: original.map(item => ({ id: item.id, enabled: item.enabled })) };
    // The caller owns the durable profile lease; these checks also reject same-process reentry.
    if (await journal.read() != null) throw problem('recovery_required', 'A pending journal must not be overwritten');
    await journal.write(structuredClone(snapshot));
    journalOwned = true;
    if (stableJson(await journal.read()) !== stableJson(snapshot)) throw problem('journal_write_unverified', 'Original-state journal was not persisted');
    const expected = new Map(original.map(item => [item.id, item.enabled]));

    async function currentInventory() {
      const value = inventoryRecord(await adapter.inventory());
      if (value.browser.instance !== initial.browser.instance) throw problem('browser_identity_mismatch', 'Pinned browser identity changed');
      return value;
    }
    async function observe(condition) {
      checkAbort(signal);
      const value = validateCapture(await adapter.capture(url, { condition, comparisonId: snapshot.comparisonId, signal }));
      if (value.browser.instance !== initial.browser.instance || value.context.condition !== condition || value.context.comparisonId !== snapshot.comparisonId) {
        throw problem('capture_identity_mismatch', 'Capture belongs to a different browser or condition');
      }
      const expectedStates = [...expected].map(([id, enabled]) => ({ id, enabled }));
      if (!enabledMatches(extensionRecords(value.context.blockers), expectedStates)) throw problem('capture_state_mismatch', 'Capture blocker readback does not match its condition');
      const after = await currentInventory();
      if (!enabledMatches(after.extensions, expectedStates)) throw problem('enabled_readback_mismatch', 'Extension state changed during the observation');
      value.context.prerequisites = { ...value.context.prerequisites, isolated: false };
      if (value.context.pageState !== 'usable') {
        inconclusive = true;
        result.limitations.push(`${condition} page acquisition is ${value.context.pageState ?? 'unknown'}.`);
      }
      const first = result.captures[0];
      const expectedInventory = initial.extensions.map(item => ({ ...item, enabled: expected.get(item.id) ?? item.enabled }));
      if (!sameInventory(value.context.blockers, expectedInventory) || !sameInventory(after.extensions, value.context.blockers)
        || (first && (first.url !== value.url || first.browser.name !== value.browser.name || first.browser.version !== value.browser.version))) {
        inconclusive = true;
        result.limitations.push(`${condition} changed final URL, browser metadata or extension configuration; comparability is uncertain.`);
      }
      result.captures.push(value);
      checkAbort(signal);
    }
    async function transition(phase, targets) {
      checkAbort(signal);
      if (!sameDebt(await journal.read(), snapshot)) throw problem('journal_changed', 'Pending comparison journal changed before mutation');
      const next = { ...snapshot, phase, intent: targets.map(([id, enabled]) => ({ id, enabled })) };
      await journal.write(structuredClone(next));
      snapshot = next;
      if (stableJson(await journal.read()) !== stableJson(snapshot)) throw problem('journal_write_unverified', 'Mutation intent was not persisted');
      for (const [id, enabled] of targets) {
        checkAbort(signal);
        const current = await currentInventory();
        checkAbort(signal);
        const item = current.extensions.find(item => item.id === id);
        if (!item) throw problem('extension_missing', 'A controlled extension disappeared');
        if (item.enabled !== enabled) {
          await adapter.setEnabled(id, enabled);
          const readback = await currentInventory();
          if (readback.extensions.find(extension => extension.id === id)?.enabled !== enabled) throw problem('enabled_readback_mismatch', 'Extension enabled-state readback disagrees after mutation');
        }
        expected.set(id, enabled);
        checkAbort(signal);
      }
      await observe(phase);
    }
    await observe('installed');
    const isolate = isolateUbol && expected.has(UBOL) ? [[UBOL, false]] : [];
    if (!isolateUbol) result.limitations.push('uBO Lite isolation was not requested; its original state remains part of every control.');
    await transition('adguard-on', [...isolate, [ADGUARD, true]]);
    await transition('adguard-off', [[ADGUARD, false]]);
    await transition('adguard-restored', [[ADGUARD, true]]);
    result.state = inconclusive ? 'inconclusive' : 'completed';
  } catch (error) {
    result.state = 'failed';
    result.limitations.push(`Comparison stopped (${reason(error)}).`);
  } finally {
    if (journalOwned) {
      result.restoration = await restoreOriginal(adapter, journal, snapshot, lockedBrowser);
      result.limitations.push(...result.restoration.limitations);
      if (result.restoration.state !== 'restored') result.state = 'failed';
    }
    if (canCleanup) {
      try { await adapter.close(); }
      catch (error) { result.state = 'failed'; result.limitations.push(`Owned tab cleanup failed (${reason(error)}).`); }
    }
    if (lockedBrowser) activeBrowsers.delete(lockedBrowser);
    if (acquired) { activeAdapters.delete(adapter); activeJournals.delete(journal); }
  }
  return result;
}

export async function recoverComparison(adapter, journal) {
  let acquired = false;
  let lockedBrowser;
  try {
    acquire(adapter, journal);
    acquired = true;
    const snapshot = await journal.read();
    if (snapshot == null) return { state: 'not-needed', limitations: [] };
    checkSnapshot(snapshot);
    const current = inventoryRecord(await adapter.inventory());
    if (current.browser.instance !== snapshot.browser.instance) throw problem('browser_identity_mismatch', 'Pending journal belongs to a different browser');
    lockBrowser(current.browser.instance);
    lockedBrowser = current.browser.instance;
    return await restoreOriginal(adapter, journal, snapshot, lockedBrowser);
  } catch (error) {
    return { state: 'failed', reason: reason(error), limitations: [`Recovery stopped (${reason(error)}); the pending journal was retained.`] };
  } finally {
    if (lockedBrowser) activeBrowsers.delete(lockedBrowser);
    if (acquired) { activeAdapters.delete(adapter); activeJournals.delete(journal); }
  }
}
