import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.mjs';
import { createHttpServer } from '../src/server.mjs';
import { openStore } from '../src/store.mjs';

const hostname = 'transport-fixture.example.org';
const publicAddress = '93.184.216.34';
const publicBody = '[Adblock Plus 2.0]\n||public-fixture.example.org^\n';
const privateBody = '[Adblock Plus 2.0]\n||private-fixture.example.org^\n';
const digest = (body) => createHash('sha256').update(body).digest('hex');

async function listen(server) {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-transport-'));
  const store = openStore(directory);
  const servers = [];
  let server;
  t.after(async () => {
    try {
      await Promise.all([server?.shutdownOperations(), ...servers.map(close)]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const hits = { public: [], private: [] };
  const endpoint = (kind, body) => {
    const endpointServer = http.createServer((request, response) => {
      hits[kind].push(request.url);
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(body);
    });
    servers.push(endpointServer);
    return endpointServer;
  };
  const publicPort = await listen(endpoint('public', publicBody));
  const privatePort = await listen(endpoint('private', privateBody));
  const url = `http://${hostname}:${privatePort}/filter.txt`;
  const recordId = 'manual:dns-rebinding';
  store.saveCatalog({
    source: 'manual',
    records: [{ id: recordId, name: 'DNS transport fixture', downloadUrls: [url] }],
    counts: { records: 1 },
    errors: [],
  });
  const saved = new EventEmitter();
  const saveHealth = store.saveHealth;
  t.mock.method(store, 'saveHealth', (id, health) => {
    saveHealth(id, health);
    saved.emit('health');
  });

  const config = structuredClone(defaultConfig);
  const worker = { status: () => ({ processing: false, runId: null }), wake() {} };
  server = createHttpServer({ store, config, worker, token: 'transport-test-token', ...options });
  servers.push(server);
  const port = await listen(server);

  const resolution = { validation: 0, unpinned: 0, socketAddresses: [] };
  t.mock.method(dnsPromises, 'lookup', async (host, lookupOptions) => {
    assert.equal(host, hostname, 'External DNS is disabled in this fixture');
    resolution.validation++;
    const answer = { address: publicAddress, family: 4 };
    return lookupOptions?.all ? [answer] : answer;
  });
  t.mock.method(dns, 'lookup', (host, lookupOptions, callback) => {
    if (typeof lookupOptions === 'function') {
      callback = lookupOptions;
      lookupOptions = {};
    }
    if (host !== hostname && host !== '127.0.0.1') {
      callback(
        Object.assign(new Error('External DNS is disabled in this fixture'), { code: 'ENOTFOUND' }),
      );
      return;
    }
    if (host === hostname) resolution.unpinned++;
    if (lookupOptions?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  });

  const request = http.request;
  t.mock.method(http, 'request', (input, requestOptions, callback) => {
    const target = new URL(input);
    assert.equal(target.hostname, hostname, 'Unexpected native HTTP target');
    assert.equal(target.port, String(privatePort), 'Unexpected native HTTP port');
    const pinnedLookup = requestOptions.lookup;
    if (typeof pinnedLookup !== 'function') return request(input, requestOptions, callback);

    // Only the production-pinned public answer is translated to the public fixture.
    // An unpinned lookup reaches the separate private fixture through the original URL.
    target.port = String(publicPort);
    return request(
      target,
      {
        ...requestOptions,
        lookup(host, lookupOptions, done) {
          pinnedLookup(host, lookupOptions, (error, answer, family) => {
            if (error) return done(error);
            const addresses = Array.isArray(answer) ? answer : [{ address: answer, family }];
            resolution.socketAddresses.push(...addresses);
            if (
              !addresses.length ||
              addresses.some((item) => item.address !== publicAddress || item.family !== 4)
            ) {
              return done(
                Object.assign(new Error('Socket destination was not the vetted public address'), {
                  code: 'EFIXTURE_ADDRESS',
                }),
              );
            }
            if (lookupOptions?.all)
              done(
                null,
                addresses.map(() => ({ address: '127.0.0.1', family: 4 })),
              );
            else done(null, '127.0.0.1', 4);
          });
        },
      },
      callback,
    );
  });
  t.mock.method(https, 'request', () => {
    throw new Error('External HTTPS is disabled in this fixture');
  });
  syncBuiltinESMExports();

  return {
    hits,
    resolution,
    url,
    async check() {
      const signal = AbortSignal.any([t.signal, AbortSignal.timeout(5000)]);
      const completed = once(saved, 'health', { signal });
      const receipt = (async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/catalog/check`, {
          method: 'POST',
          signal,
          headers: {
            Authorization: 'Bearer transport-test-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ id: recordId }),
        });
        assert.equal(response.status, 202);
        await response.json();
      })();
      await Promise.all([completed, receipt]);
      return store.catalog().find((record) => record.id === recordId).health;
    },
  };
}

test(
  'default catalog HTTP transport pins vetted DNS instead of reaching a rebinding private endpoint',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const health = await f.check();
    assert.deepEqual(
      f.hits.private,
      [],
      'A second DNS resolution must never reach the private endpoint',
    );
    assert.deepEqual(
      f.hits.public,
      ['/filter.txt'],
      'The permitted public response must actually be retrieved',
    );
    assert.equal(f.resolution.validation, 1);
    assert.equal(f.resolution.unpinned, 0);
    assert.deepEqual(f.resolution.socketAddresses, [{ address: publicAddress, family: 4 }]);
    assert.equal(health.delivery.delivery.state, 'available');
    assert.equal(health.delivery.format.state, 'valid');
    assert.equal(health.delivery.segments[0].digest.sha256, digest(publicBody));
    assert.equal(health.delivery.segments[0].provenance.transport, 'node-pinned-dns');
  },
);

test(
  'catalog HTTP transport preserves an explicitly injected client',
  { timeout: 15000 },
  async (t) => {
    const body = '[Adblock Plus 2.0]\n||injected-fixture.example.org^\n';
    const targets = [];
    const f = await fixture(t, {
      fetchImpl: async (url) => {
        targets.push(url);
        return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
      },
    });
    const health = await f.check();
    assert.deepEqual(targets, [f.url]);
    assert.deepEqual(f.hits, { public: [], private: [] });
    assert.equal(f.resolution.validation, 1);
    assert.equal(f.resolution.unpinned, 0);
    assert.equal(health.delivery.delivery.state, 'available');
    assert.equal(health.delivery.format.state, 'valid');
    assert.equal(health.delivery.segments[0].digest.sha256, digest(body));
    assert.equal(health.delivery.segments[0].provenance.transport, 'injected-client');
  },
);
