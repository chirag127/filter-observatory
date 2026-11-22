#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { initializeState, defaultStateDir, loadConfig, readWorkerToken, acquireProcessLock } from './config.mjs';
import { openStore } from './store.mjs';
import { createWorker } from './worker.mjs';
import { createHttpServer } from './server.mjs';
import { CAPTURE_LIMITS } from './capture.mjs';

const help = `Filter Observatory

Usage: node src/cli.mjs <command> [arguments] [--state-dir DIRECTORY]

  init                                  Create local settings and connection token
  serve                                 Run the local worker and dashboard
  status                                Show stored counts and current configuration
  config                                Show configuration (environment-key names only)
  token                                 Print the local companion connection token
  ingest FILE                           Validate and store a captured evidence JSON file
  annotate CAPTURE_ID FILE               Add measured context and image-redaction notes
  process                               Analyze queued captures and handle the report outbox
  corpus import FILE [--format csv|json]  Create a reproducible run from a ranked manifest
  corpus tranco LIST_ID                  Import a fixed Tranco snapshot
  run RUN_ID [--retry-failed]            Execute or resume that run
  recover                               Restore an interrupted blocker comparison
  catalog discover adguard|ubo|filterlists [--snapshot REVISION]
  catalog import SOURCE FILE [--snapshot REVISION]
  catalog health [--id LIST_ID] [--limit 25]
  reports                               Show the local report outbox
  report REPORT_ID                      Print a report's Markdown

Options: --compare (when importing a corpus), --source NAME, --snapshot ID,
         --state-dir DIRECTORY, --help

Edit the generated config.json to enable a provider, choose the paired browser,
and configure automatic publication. New installations keep provider calls,
browser changes and publication disabled. Restart the worker after config edits.
Runtime evidence and secrets belong in the local state directory.
`;

const error = (code, message) => Object.assign(new Error(message), { code });
const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function readBounded(file, maximum = CAPTURE_LIMITS.requestBytes) {
  if (!file) throw error('file_required', 'A file path is required');
  if (statSync(file).size > maximum) throw error('file_too_large', 'Input exceeds the configured byte limit');
  return readFileSync(file, 'utf8');
}

function positiveLimit(value, fallback = 25) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 10000) {
    throw error('invalid_limit', 'Limit must be an integer from 1 to 10000');
  }
  return Number(value);
}

function requireId(value, name) {
  if (!value) throw error('id_required', `${name} is required`);
  return value;
}

async function serve({ directory, store, config, worker, signal }) {
  const token = readWorkerToken(directory);
  const server = createHttpServer({ store, config, worker, token });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', ready);
  });
  try {
    if (store.journals().length || store.leases().length) {
      try { await worker.recoverBrowserState(); }
      catch { store.event('recovery', 'Browser recovery needs attention; use the dashboard recovery action'); }
    }
    worker.start();
    print({ state: 'listening', dashboard: `http://127.0.0.1:${config.port}`, stateDir: directory,
      tokenPath: join(directory, 'worker.token'), providerEnabled: config.provider.enabled,
      publicationEnabled: config.publication.enabled });
    await new Promise(done => {
      if (signal.aborted) done();
      else signal.addEventListener('abort', done, { once: true });
    });
  } finally {
    const closing = new Promise(done => server.close(done));
    await Promise.allSettled([worker.stop(), server.shutdownOperations()]);
    server.closeAllConnections();
    await closing;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'state-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' }, format: { type: 'string' },
    source: { type: 'string' }, snapshot: { type: 'string' }, compare: { type: 'boolean' },
    id: { type: 'string' }, limit: { type: 'string' }, 'retry-failed': { type: 'boolean' },
  } });
  const [command, action, input] = positionals;
  if (!command || values.help || command === 'help') { print(help); return; }
  const commands = new Set(['init', 'serve', 'status', 'config', 'token', 'ingest', 'annotate', 'process', 'corpus', 'run', 'recover', 'catalog', 'reports', 'report']);
  if (!commands.has(command)) throw error('unknown_command', 'Unknown command; run --help');
  const directory = resolve(values['state-dir'] || defaultStateDir());
  if (command === 'init') { print(initializeState(directory)); return; }
  const config = loadConfig(directory);
  if (command === 'config') { print(config); return; }
  if (command === 'token') { print(readWorkerToken(directory)); return; }
  const readOnly = ['status', 'reports', 'report'].includes(command);
  const lock = readOnly ? null : await acquireProcessLock(directory);
  let store;
  let worker;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    store = openStore(directory);
    if (readOnly) {
      if (command === 'status') print({ totals: store.summary().totals, runs: store.summary().runs,
        recoveryRequired: store.journals().length > 0, providerEnabled: config.provider.enabled,
        publicationEnabled: config.publication.enabled });
      if (command === 'reports') print(store.reports());
      if (command === 'report') {
        const report = store.report(requireId(action, 'Report ID'));
        if (!report) throw error('report_not_found', 'Report not found');
        print(report.body);
      }
      return;
    }
    store.recoverInterrupted();
    worker = createWorker({ store, config });
    if (command === 'serve') return await serve({ directory, store, config, worker, signal: controller.signal });
    if (command === 'ingest') { print(store.ingest(JSON.parse(readBounded(action)))); return; }
    if (command === 'annotate') {
      print(store.annotateCapture(requireId(action, 'Capture ID'), JSON.parse(readBounded(input))));
      return;
    }
    if (command === 'process') { print(await worker.cycle({ signal: controller.signal })); return; }
    if (command === 'recover') {
      const results = await worker.recoverBrowserState();
      print(results);
      if (results.some(({ result }) => !['restored', 'not-needed'].includes(result?.state)) || store.journals().length
          || store.leases().some(lease => lease.name.startsWith('browser:'))) process.exitCode = 1;
      return;
    }
    if (command === 'corpus') {
      const { parseCorpus, fetchTrancoCorpus } = await import('./corpus.mjs');
      let corpus;
      if (action === 'import') corpus = parseCorpus(readBounded(input), {
        format: values.format, source: values.source, snapshot: values.snapshot, limit: 300,
      });
      else if (action === 'tranco') corpus = await fetchTrancoCorpus(requireId(input, 'Fixed Tranco list ID'), { signal: controller.signal });
      else throw error('unknown_command', 'Use corpus import FILE or corpus tranco LIST_ID');
      const run = store.createRun(corpus, { compare: values.compare === true });
      print(run);
      if (corpus.errors?.some(item => item.excluded)) process.exitCode = 1;
      return;
    }
    if (command === 'run') {
      const runId = requireId(action, 'Run ID');
      if (values['retry-failed']) store.resumeRun(runId, { retryFailed: true });
      const result = await worker.run(runId, { signal: controller.signal });
      print(result);
      if (result.counts.failed || result.counts.interrupted || result.counts.cancelled || result.counts.inconclusive) process.exitCode = 1;
      return;
    }
    if (command === 'catalog') {
      const { discoverCatalog, importCatalog, checkFeed, checkMaintenance } = await import('./catalog.mjs');
      if (action === 'discover' || action === 'import') {
        const source = requireId(input, 'Catalog source');
        const result = action === 'discover'
          ? await discoverCatalog(source, { snapshot: values.snapshot, signal: controller.signal })
          : importCatalog(source, JSON.parse(readBounded(positionals[3])), { snapshot: values.snapshot, retrievedAt: new Date().toISOString() });
        store.saveCatalog(result);
        print({ source: result.source, counts: result.counts, errors: result.errors });
        if (result.errors?.length) process.exitCode = 1;
        return;
      }
      if (action === 'health') {
        const records = store.catalog().filter(record => !values.id || record.id === values.id).slice(0, positiveLimit(values.limit));
        const results = [];
        for (const record of records) {
          if (controller.signal.aborted) break;
          const delivery = await checkFeed(record, { signal: controller.signal });
          const maintenance = await checkMaintenance(record, { signal: controller.signal });
          store.saveHealth(record.id, { delivery, maintenance, checkedAt: new Date().toISOString() });
          results.push({ id: record.id, delivery, maintenance });
        }
        print({ selected: records.length, checked: results.length, results });
        return;
      }
      throw error('unknown_command', 'Use catalog discover, import or health');
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await worker?.stop();
    store?.close();
    await lock?.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(cause => {
    const code = /^[a-z][a-z0-9_-]{0,79}$/.test(cause?.code ?? '') ? cause.code : 'operation_failed';
    const messages = {
      worker_busy: 'A worker is already running for this state directory. Use its dashboard or stop it before this command.',
      operation_failed: 'The operation failed. Check the input and local configuration.',
    };
    console.error(JSON.stringify({ error: code, message: messages[code] || cause.message }));
    process.exitCode = 1;
  });
}
