import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { openStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { createHttpServer } from '../src/server.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-http-'));
  const store = openStore(directory);
  const config = structuredClone(defaultConfig);
  const token = 'local-test-token';
  const worker = { status: () => ({ processing: false, runId: null }), wake() {}, async cycle() { return { state: 'completed' }; } };
  const server = createHttpServer({ store, config, token, worker, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await server.shutdownOperations();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { base, store, token, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

test('capture intake requires the token and keeps evidence private while deduplicating retries', async t => {
  const f = await fixture(t);
  const capture = captureFixture();
  const without = await fetch(`${f.base}/api/captures`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(capture) });
  assert.equal(without.status, 401);
  for (const expected of [201, 200]) {
    const response = await fetch(`${f.base}/api/captures`, { method: 'POST', headers: f.headers, body: JSON.stringify(capture) });
    assert.equal(response.status, expected);
    assert.equal((await response.json()).duplicate, expected === 200);
  }
  const conflict = await fetch(`${f.base}/api/captures`, { method: 'POST', headers: f.headers, body: JSON.stringify({ ...capture, title: 'Changed capture' }) });
  assert.equal(conflict.status, 409);
  const imageUrl = `${f.base}/api/images/${capture.id}/viewport`;
  assert.equal((await fetch(imageUrl)).status, 401);
  const image = await fetch(imageUrl, { headers: f.headers });
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(capture.images[0].dataBase64, 'base64'));
  const state = await fetch(`${f.base}/api/state`, { headers: f.headers });
  const text = await state.text();
  assert.equal(text.includes('dataBase64'), false);
  assert.equal(text.includes(f.token), false);
  assert.equal(JSON.parse(text).totals.captures, 1);
});

test('host rebinding and foreign origins are rejected even with a bearer token', async t => {
  const f = await fixture(t);
  const foreign = await fetch(`${f.base}/api/health`, { headers: { ...f.headers, Origin: 'https://untrusted.example' } });
  assert.equal(foreign.status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${f.base}/api/health`, { headers: { ...f.headers, Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const preflight = await fetch(`${f.base}/api/captures`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal((await fetch(`${f.base}/api/health`, { headers: { ...f.headers, Origin: origin } })).status, 200);
});

test('malformed and oversized requests cannot create capture records', async t => {
  const f = await fixture(t, { maxBodyBytes: 2000 });
  const malformed = await fetch(`${f.base}/api/captures`, { method: 'POST', headers: f.headers, body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`${f.base}/api/captures`, { method: 'POST', headers: f.headers, body: JSON.stringify({ text: 'x'.repeat(2100) }) });
  assert.equal(oversized.status, 413);
  const badImage = captureFixture(); badImage.images[0].dataBase64 = 'bm90cG5n';
  const invalid = await fetch(`${f.base}/api/captures`, { method: 'POST', headers: f.headers, body: JSON.stringify(badImage) });
  assert.equal(invalid.status, 400);
  assert.equal(f.store.summary().totals.captures, 0);
});

test('authenticated annotations preserve original evidence and expose their provenance', async t => {
  const f = await fixture(t);
  const capture = captureFixture(); f.store.ingest(capture);
  const endpoint = `${f.base}/api/captures/${capture.id}/annotations`;
  const note = { source: 'Fixture settings observation', observedAt: '2026-11-21T16:01:00.000Z',
    context: { os: { name: 'Windows', version: '11' } }, images: [] };
  assert.equal((await fetch(endpoint)).status, 401);
  const saved = await fetch(endpoint, { method: 'POST', headers: f.headers, body: JSON.stringify(note) });
  assert.equal(saved.status, 200);
  assert.match((await saved.json()).revision, /^[a-f0-9]{64}$/);
  const readback = await fetch(endpoint, { headers: f.headers });
  assert.equal((await readback.json()).annotations.source, note.source);
  assert.deepEqual(f.store.capture(capture.id), capture);
  const invalid = await fetch(endpoint, { method: 'POST', headers: f.headers, body: JSON.stringify({ ...note, url: 'https://different.example.com' }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(f.store.capture(capture.id), capture);
});

test('catalog checks acknowledge only the requested selection while another check is running', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => {
    entered();
    await Promise.race([proceed, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    return new Response('[Adblock Plus 2.0]\n||advert.example^', { headers: { 'content-type': 'text/plain' } });
  } });
  f.store.saveCatalog({ source: 'manual', records: [
    { id: 'manual:first', name: 'First list', downloadUrls: ['https://93.184.216.34/first.txt'] },
    { id: 'manual:second', name: 'Second list', downloadUrls: ['https://93.184.216.34/second.txt'] },
  ], counts: {} });
  const check = id => fetch(`${f.base}/api/catalog/check`, { method: 'POST', headers: f.headers, body: JSON.stringify({ id }) });
  try {
    const first = await check('manual:first');
    assert.equal(first.status, 202);
    const operation = await first.json();
    await started;
    const same = await check('manual:first');
    assert.equal(same.status, 202);
    assert.equal((await same.json()).id, operation.id);
    const different = await check('manual:second');
    assert.equal(different.status, 409);
    assert.equal((await different.json()).error.code, 'operation_busy');
    assert.equal(f.store.catalog().find(record => record.id === 'manual:second').health, null);
  } finally { release(); }
});

test('HTTP corpus imports preserve embedded provenance unless an explicit override is supplied', async t => {
  const f = await fixture(t);
  const manifest = { source: 'tranco', snapshot: { listId: 'FIXED', retrievedAt: '2026-11-21T16:00:00.000Z' },
    entries: [{ rank: 1, domain: 'example.com' }] };
  const send = body => fetch(`${f.base}/api/corpora`, { method: 'POST', headers: f.headers, body: JSON.stringify(body) });
  const imported = await send({ format: 'json', input: JSON.stringify(manifest) });
  assert.equal(imported.status, 201);
  const run = await imported.json();
  assert.equal(run.corpus.source, 'tranco');
  assert.deepEqual(run.corpus.snapshot, { listId: 'FIXED', retrievedAt: '2026-11-21T16:00:00.000Z' });
  assert.deepEqual(f.store.run(run.id).corpus.snapshot, run.corpus.snapshot);
  const overridden = await send({ format: 'json', input: JSON.stringify(manifest), source: 'operator-reviewed', snapshot: 'explicit-revision' });
  assert.equal(overridden.status, 201);
  const override = await overridden.json();
  assert.equal(override.corpus.source, 'operator-reviewed');
  assert.equal(override.corpus.snapshot, 'explicit-revision');
  const plain = await send({ format: 'csv', input: '1,example.com' });
  assert.equal(plain.status, 201);
  const defaults = await plain.json();
  assert.equal(defaults.corpus.source, 'manual');
  assert.equal(defaults.corpus.snapshot, null);
});

test('capture history pages reach older evidence without duplicates when new captures arrive', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 203; index++) {
    f.store.ingest(captureFixture({ id: `history_${String(index).padStart(4, '0')}` }));
  }
  const state = await (await fetch(`${f.base}/api/state`, { headers: f.headers })).json();
  assert.equal(state.captures.length, 200);
  assert.equal(state.capturePage.total, 203);
  assert.equal(typeof state.capturePage.nextCursor, 'string');
  const cursor = state.capturePage.nextCursor;
  f.store.ingest(captureFixture({ id: 'history_new_capture' }));
  const older = await fetch(`${f.base}/api/captures?limit=200&before=${encodeURIComponent(cursor)}`, { headers: f.headers });
  assert.equal(older.status, 200);
  const page = await older.json();
  assert.equal(page.captures.length, 3);
  assert.equal(page.total, 204);
  assert.equal(page.nextCursor, null);
  const ids = [...state.captures, ...page.captures].map(capture => capture.id);
  assert.equal(new Set(ids).size, 203);
  assert.equal(ids.includes('history_new_capture'), false);
  assert.deepEqual([...ids].sort(), Array.from({ length: 203 }, (_, index) => `history_${String(index).padStart(4, '0')}`));
  assert.equal(JSON.stringify(page).includes('dataBase64'), false);
  assert.equal((await fetch(`${f.base}/api/captures?limit=50`)).status, 401);
  for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'before=not-a-cursor']) {
    assert.equal((await fetch(`${f.base}/api/captures?${query}`, { headers: f.headers })).status, 400);
  }
});

test('dashboard state retains failed catalog import evidence alongside last-known-good records after reopen', async t => {
  const f = await fixture(t);
  const record = { id: 'ubo:fixture', name: 'Previously imported list', source: 'ubo', raw: { fixture: true } };
  f.store.saveCatalog({ source: 'ubo', records: [record], counts: { imported: 1, complete: true }, errors: [] });
  const failure = { code: 'download_failed', message: 'Source could not be retrieved' };
  f.store.saveCatalog({ source: 'ubo', records: [], counts: { imported: 0, complete: false }, errors: [failure] });
  const state = await (await fetch(`${f.base}/api/state`, { headers: f.headers })).json();
  assert.equal(state.catalog.length, 1);
  assert.equal(state.catalog[0].name, 'Previously imported list');
  assert.equal(state.catalog[0].raw, undefined);
  assert.equal(state.catalogImports?.length, 1);
  assert.equal(state.catalogImports[0].source, 'ubo');
  assert.deepEqual(state.catalogImports[0].counts, { imported: 0, complete: false });
  assert.deepEqual(state.catalogImports[0].errors, [failure]);
  assert.ok(Number.isFinite(Date.parse(state.catalogImports[0].at)));
  const reopened = openStore(f.store.stateDir);
  try {
    assert.deepEqual(reopened.summary().catalogImports, state.catalogImports);
    assert.equal(reopened.catalog()[0].name, 'Previously imported list');
  } finally { reopened.close(); }
});
