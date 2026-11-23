import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CAPTURE_LIMITS } from './capture.mjs';

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const reasonOf = (cause) =>
  /^[a-z][a-z0-9_-]{0,79}$/.test(cause?.code ?? '') ? cause.code : 'operation_failed';

function hasToken(request, token) {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function localRequest(request) {
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) return false;
  const address = new URL(`http://${host}`);
  return (
    localHosts.has(address.hostname) && Number(address.port || 80) === request.socket.localPort
  );
}

function allowedOrigin(origin, host) {
  if (!origin) return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  if (/^moz-extension:\/\/[a-f0-9-]{36}$/i.test(origin)) return true;
  return origin === `http://${host}`;
}

async function jsonBody(request, maxBytes) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw failure(415, 'json_required', 'Use application/json');
  }
  if (Number(request.headers['content-length'] || 0) > maxBytes)
    throw failure(413, 'payload_too_large', 'Request exceeds the size limit');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw failure(413, 'payload_too_large', 'Request exceeds the size limit');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw failure(400, 'invalid_json', 'Request must contain a JSON object');
  }
}

export function createHttpServer({
  store,
  config,
  worker,
  token,
  fetchImpl,
  maxBodyBytes = CAPTURE_LIMITS.requestBytes,
} = {}) {
  if (!store || !config || !worker || !token)
    throw new TypeError('store, config, worker and token are required');
  const operations = new Map();
  const lifetime = new AbortController();
  const pending = new Set();

  function schedule(name, action, selection = null) {
    const active = operations.get(name);
    if (active?.state === 'running') {
      if (active.selection !== selection)
        throw failure(
          409,
          'operation_busy',
          'A different selection is being checked; retry after it finishes',
        );
      return active;
    }
    const operation = {
      id: randomUUID(),
      name,
      selection,
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    operations.set(name, operation);
    const task = Promise.resolve()
      .then(action)
      .then(
        (result) => {
          Object.assign(operation, {
            state: 'completed',
            result,
            finishedAt: new Date().toISOString(),
          });
        },
        (cause) => {
          Object.assign(operation, {
            state: 'failed',
            reason: reasonOf(cause),
            finishedAt: new Date().toISOString(),
          });
          store.event('operation', `${name} failed`, {
            operationId: operation.id,
            reason: operation.reason,
          });
        },
      )
      .finally(() => pending.delete(task));
    pending.add(task);
    return operation;
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const send = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      if (!localRequest(request))
        throw failure(403, 'invalid_host', 'Only the worker loopback address is accepted');
      const origin = request.headers.origin;
      if (!allowedOrigin(origin, request.headers.host))
        throw failure(403, 'invalid_origin', 'Origin is not allowed');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        if (
          !origin ||
          !['GET', 'POST'].includes(request.headers['access-control-request-method'])
        ) {
          throw failure(403, 'invalid_preflight', 'Unsupported preflight');
        }
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        response.end();
        return;
      }
      if (!['GET', 'POST'].includes(request.method))
        throw failure(405, 'method_not_allowed', 'Use GET or POST');
      if (!request.url?.startsWith('/') || request.url.startsWith('//'))
        throw failure(400, 'invalid_path', 'Invalid request path');
      const url = new URL(request.url, `http://${request.headers.host}`);
      const asset = assets.get(url.pathname);
      if (asset && request.method === 'GET') {
        const body = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': asset[1] });
        response.end(body);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw failure(404, 'not_found', 'Route not found');
      if (!hasToken(request, token))
        throw failure(401, 'unauthorized', 'A worker bearer token is required');
      if (request.method === 'GET') {
        if (url.pathname === '/api/health')
          return send(200, { ok: true, version: '0.1.0', worker: worker.status() });
        if (url.pathname === '/api/state')
          return send(200, {
            ...store.summary(),
            worker: worker.status(),
            operations: [...operations.values()],
            configuration: {
              providerEnabled: config.provider.enabled,
              providerModel: config.provider.model,
              publicationEnabled: config.publication.enabled,
              browser: config.browser.instance,
              allowChanges: config.browser.allowChanges,
            },
          });
        if (url.pathname === '/api/captures') {
          const limit = url.searchParams.get('limit');
          if (limit !== null && !/^\d{1,3}$/.test(limit))
            throw failure(
              400,
              'invalid_page',
              'Capture page limit must be an integer from 1 to 200',
            );
          return send(
            200,
            store.capturePage({
              ...(limit !== null ? { limit: Number(limit) } : {}),
              before: url.searchParams.get('before') ?? undefined,
            }),
          );
        }
        const annotations = /^\/api\/captures\/([A-Za-z0-9_-]+)\/annotations$/.exec(url.pathname);
        if (annotations) {
          if (!store.captureStatus(annotations[1]))
            throw failure(404, 'capture_not_found', 'Capture not found');
          return send(200, { id: annotations[1], annotations: store.annotations(annotations[1]) });
        }
        const image = /^\/api\/images\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (image) {
          const value = store.image(image[1], image[2]);
          if (!value) throw failure(404, 'image_not_found', 'Image not found');
          response.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': value.bytes.length,
          });
          response.end(value.bytes);
          return;
        }
        const capture = /^\/api\/captures\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (capture) {
          const value = store.captureStatus(capture[1]);
          if (!value) throw failure(404, 'capture_not_found', 'Capture not found');
          return send(200, value);
        }
        const run = /^\/api\/runs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (run) {
          const value = store.run(run[1]);
          if (!value) throw failure(404, 'run_not_found', 'Run not found');
          return send(200, { ...value, entries: store.entries(run[1]) });
        }
        throw failure(404, 'not_found', 'API route not found');
      }
      const body = await jsonBody(request, maxBodyBytes);
      if (url.pathname === '/api/captures') {
        const receipt = store.ingest(body);
        worker.wake();
        return send(receipt.duplicate ? 200 : 201, receipt);
      }
      const annotations = /^\/api\/captures\/([A-Za-z0-9_-]+)\/annotations$/.exec(url.pathname);
      if (annotations) {
        const receipt = store.annotateCapture(annotations[1], body);
        worker.wake();
        return send(200, receipt);
      }
      if (url.pathname === '/api/process')
        return send(
          202,
          schedule('process', () => worker.cycle({ signal: lifetime.signal })),
        );
      if (url.pathname === '/api/recover') {
        if (worker.status().runId)
          throw failure(409, 'run_busy', 'Stop the active browser run before recovery');
        return send(
          202,
          schedule('recovery', () => worker.recoverBrowserState()),
        );
      }
      const retry = /^\/api\/captures\/([A-Za-z0-9_-]+)\/retry$/.exec(url.pathname);
      if (retry) {
        if (!store.retryCapture(retry[1]))
          throw failure(
            409,
            'capture_not_retryable',
            'Only interrupted, failed, cancelled or abstained captures can be retried',
          );
        worker.wake();
        return send(200, store.captureStatus(retry[1]));
      }
      if (url.pathname === '/api/corpora') {
        if (!['json', 'csv'].includes(body.format) || typeof body.input !== 'string')
          throw failure(400, 'invalid_corpus', 'Supply input text and json or csv format');
        const { parseCorpus } = await import('./corpus.mjs');
        const corpus = parseCorpus(body.input, {
          format: body.format,
          source: body.source,
          snapshot: body.snapshot,
          limit: 300,
        });
        const run = store.createRun(corpus, { compare: body.compare === true });
        return send(201, run);
      }
      const runAction = /^\/api\/runs\/([A-Za-z0-9_-]+)\/(start|cancel)$/.exec(url.pathname);
      if (runAction) {
        if (!store.run(runAction[1])) throw failure(404, 'run_not_found', 'Run not found');
        if (runAction[2] === 'cancel') return send(200, worker.cancelRun(runAction[1]));
        if (!config.browser.instance)
          throw failure(409, 'browser_not_configured', 'Set browser.instance in local config.json');
        if (store.run(runAction[1]).options.compare && !config.browser.allowChanges)
          throw failure(
            409,
            'browser_changes_disabled',
            'Comparison changes are disabled in config.json',
          );
        return send(
          202,
          schedule(`run:${runAction[1]}`, () =>
            worker.run(runAction[1], { signal: lifetime.signal }),
          ),
        );
      }
      if (url.pathname === '/api/catalog/import') {
        if (!['adguard', 'ubo', 'filterlists', 'manual'].includes(body.source))
          throw failure(400, 'invalid_source', 'Unknown catalog source');
        const { importCatalog } = await import('./catalog.mjs');
        const result = importCatalog(body.source, body.raw, {
          snapshot: body.snapshot,
          retrievedAt: new Date().toISOString(),
        });
        store.saveCatalog(result);
        return send(200, { counts: result.counts, errors: result.errors });
      }
      if (url.pathname === '/api/catalog/discover') {
        if (!['adguard', 'ubo', 'filterlists'].includes(body.source))
          throw failure(400, 'invalid_source', 'Choose AdGuard, uBO or FilterLists');
        return send(
          202,
          schedule(
            `discover:${body.source}`,
            async () => {
              const { discoverCatalog } = await import('./catalog.mjs');
              const result = await discoverCatalog(body.source, {
                current: body.current === true,
                snapshot: body.snapshot,
                fetchImpl,
                signal: lifetime.signal,
              });
              store.saveCatalog(result);
              return { counts: result.counts, errors: result.errors };
            },
            JSON.stringify({ snapshot: body.snapshot ?? null, current: body.current === true }),
          ),
        );
      }
      if (url.pathname === '/api/catalog/check') {
        if (
          body.id !== undefined &&
          (typeof body.id !== 'string' || !body.id.length || body.id.length > 500)
        )
          throw failure(400, 'invalid_list', 'Choose an imported list ID');
        const records = store
          .catalog()
          .filter((record) => (body.id ? record.id === body.id : true))
          .slice(0, 25);
        if (body.id && !records.length)
          throw failure(404, 'list_not_found', 'The selected list is not in this catalog');
        return send(
          202,
          schedule(
            'catalog-health',
            async () => {
              const { checkFeed, checkMaintenance } = await import('./catalog.mjs');
              let checked = 0;
              for (const record of records) {
                if (lifetime.signal.aborted) break;
                const delivery = await checkFeed(record, { fetchImpl, signal: lifetime.signal });
                const maintenance = await checkMaintenance(record, {
                  fetchImpl,
                  signal: lifetime.signal,
                });
                store.saveHealth(record.id, {
                  delivery,
                  maintenance,
                  checkedAt: new Date().toISOString(),
                });
                checked++;
              }
              return { selected: records.length, checked };
            },
            JSON.stringify(records.map((record) => record.id).sort()),
          ),
        );
      }
      throw failure(404, 'not_found', 'API route not found');
    } catch (cause) {
      const status =
        Number.isInteger(cause.status) && cause.status >= 400 && cause.status < 600
          ? cause.status
          : 500;
      send(status, {
        error: {
          code: reasonOf(cause),
          message: status === 500 ? 'Operation failed; inspect the local event log' : cause.message,
        },
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.shutdownOperations = async () => {
    lifetime.abort();
    await Promise.allSettled([...pending]);
  };
  return server;
}
