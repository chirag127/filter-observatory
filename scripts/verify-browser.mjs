import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { PNG } from 'pngjs';
import { createSctlBrowser } from '../src/browser.mjs';

const { values } = parseArgs({ options: { browser: { type: 'string' }, output: { type: 'string' } } });
if (!values.browser || !values.output) throw new Error('Supply --browser FULL_PAIRED_ID --output NEW_EVIDENCE_DIRECTORY');
const output = resolve(values.output);
// An exclusive directory claim prevents an interrupted live capture from being replayed accidentally.
await mkdir(output);
const id = randomUUID();
const title = `Filter Observatory capture ${id}`;
const path = `/fixture/${id}`;
const report = { id, startedAt: new Date().toISOString(), pid: process.pid,
  browser: values.browser, state: 'started', sourceHashes: {}, commands: [], cleanup: {} };
for (const name of ['browser', 'capture']) {
  report.sourceHashes[`src/${name}.mjs`] = createHash('sha256')
    .update(await readFile(new URL(`../src/${name}.mjs`, import.meta.url))).digest('hex');
}
report.sourceHashes['scripts/verify-browser.mjs'] = createHash('sha256')
  .update(await readFile(new URL(import.meta.url))).digest('hex');
const save = () => writeFile(join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`);
await save();
const run = promisify(execFile);
const protocolKeys = new Set(['contentTrust', 'tabId', 'tabIds', 'tabs', 'items', 'navigated',
  'url', 'title', 'value', 'snapshot', 'text', 'path', 'file', 'format', 'width', 'height',
  'status', 'ok', 'result', 'error', 'code', 'message']);
const adapter = createSctlBrowser({ browser: values.browser, async execFileImpl(file, args, options) {
  const operation = `${args[0]} ${args[1]}`;
  const entry = { operation, startedAt: new Date().toISOString(), state: 'started' };
  if (args.includes('--tab')) entry.requestedTab = Number(args[args.indexOf('--tab') + 1]);
  if (args[0] === 'page' && args[1] !== 'detach') report.lastCaptureOperation = operation;
  report.commands.push(entry);
  await save();
  try {
    const output = await run(file, args, options);
    let value;
    try { value = JSON.parse(output.stdout); } catch {}
    Object.assign(entry, { state: 'completed', stdoutBytes: Buffer.byteLength(output.stdout),
      stderrBytes: Buffer.byteLength(output.stderr), validJson: value !== undefined,
      displayTabPrefix: /^tab\s+\d+:/i.test(output.stdout.trim()) });
    if (value && typeof value === 'object') {
      entry.protocolKeys = Object.keys(value).filter(key => protocolKeys.has(key));
      if (Number.isSafeInteger(value.tabId)) entry.returnedTabId = value.tabId;
      if (typeof value.navigated === 'boolean') entry.navigated = value.navigated;
    }
    return output;
  } catch (error) {
    entry.state = 'failed';
    entry.reason = /^[A-Za-z0-9_-]{1,80}$/.test(error?.code ?? '') ? error.code : 'command_failed';
    throw error;
  } finally { entry.finishedAt = new Date().toISOString(); await save(); }
} });
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>:root{--paper:#e8eef4;--ink:#173448;--signal:#166d80;font:16px/1.5 system-ui;color:var(--ink);background:var(--paper)}body{margin:24px}h1{font-size:24px}.swatches{display:flex;gap:16px}.swatch{width:90px;height:90px}a{color:var(--signal)}footer{margin-top:24px;font-size:13px}</style>
<h1>${title}</h1><p>This local fixture checks capture attribution and screenshot pixels.</p>
<div class="swatches"><div class="swatch" style="background:#d92d20" aria-label="Red square"></div><div class="swatch" style="background:#12b76a" aria-label="Green square"></div><div class="swatch" style="background:#2e90fa" aria-label="Blue square"></div></div>
<footer class="hire-me"><h3>Hire me</h3><p>Chirag Singhal — building free, open APIs and tools.</p><p><a href="mailto:chirag@oriz.in">chirag@oriz.in</a> · <a href="https://github.com/chirag127">GitHub</a> · <a href="https://www.linkedin.com/in/chirag127/">LinkedIn</a> · <a href="https://x.com/singhal127">X</a> · <a href="https://www.youtube.com/@ChiragSinghal127">YouTube</a> · <a href="https://www.instagram.com/chiragsinghal127/">Instagram</a> · <a href="https://www.reddit.com/user/Far_Macaron_9910/">Reddit</a> · <a href="https://buymeacoffee.com/chirag127">Buy me a coffee</a></p></footer></html>`;
const server = createServer((request, response) => {
  response.writeHead(request.url === path ? 200 : 404, { 'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'" });
  response.end(request.url === path ? page : 'Fixture route not found');
});
const inventoryKey = value => JSON.stringify([...value.extensions].sort((a, b) => a.id.localeCompare(b.id)));
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const url = `http://127.0.0.1:${server.address().port}${path}`;
  const before = await adapter.inventory();
  report.fixtureUrl = url;
  report.observedExtensions = before.extensions;
  report.state = 'capturing';
  await save();
  const capture = await adapter.capture(url, { signal: AbortSignal.timeout(180000) });
  await writeFile(join(output, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`);
  const bytes = Buffer.from(capture.images[0].dataBase64, 'base64');
  await writeFile(join(output, 'viewport.png'), bytes);
  assert.equal(capture.url, url);
  assert.equal(capture.title, title);
  assert.ok(capture.text.includes(id));
  assert.equal(capture.browser.instance, values.browser);
  assert.equal(capture.context.condition, 'installed');
  const png = PNG.sync.read(bytes, { checkCRC: true });
  const colors = new Map([[0xd92d20, 0], [0x12b76a, 0], [0x2e90fa, 0]]);
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const color = (png.data[offset] << 16) | (png.data[offset + 1] << 8) | png.data[offset + 2];
    if (png.data[offset + 3] === 255 && colors.has(color)) colors.set(color, colors.get(color) + 1);
  }
  for (const count of colors.values()) assert.ok(count >= 100, 'The captured viewport must contain each fixture square');
  const after = await adapter.inventory();
  report.inventoryUnchanged = inventoryKey(before) === inventoryKey(after);
  assert.equal(report.inventoryUnchanged, true, 'Extension readback changed during the fixture capture');
  report.capture = { id: capture.id, tab: capture.tab, browser: capture.browser,
    pageState: capture.context.pageState, width: png.width, height: png.height,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    colorPixels: Object.fromEntries([...colors].map(([color, count]) => [color.toString(16), count])),
    limitations: capture.limitations };
  report.state = 'completed';
} catch (error) {
  report.state = 'failed';
  report.reason = /^[A-Za-z0-9_-]{1,80}$/.test(error?.code ?? '') ? error.code : 'verification_failed';
  process.exitCode = 1;
} finally {
  try { await adapter.close(); report.cleanup.browser = 'completed'; }
  catch { report.cleanup.browser = 'failed'; report.state = 'failed'; process.exitCode = 1; }
  if (server.listening) {
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
  }
  report.cleanup.listener = 'closed';
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ state: report.state, reason: report.reason, output, cleanup: report.cleanup }));
}
