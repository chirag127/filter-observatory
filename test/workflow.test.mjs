import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { createWorker } from '../src/worker.mjs';
import { createHttpServer } from '../src/server.mjs';
import { createGitHubPublisher, prepareReport } from '../src/reports.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

const list = { id: 'adguard:filter:2', name: 'AdGuard Base filter', enabled: true };
const observation = {
  category: 'missed-ads',
  observation: 'A paid banner remains next to the article',
  expectedBehavior: 'Hide the paid advertisement',
  reproduction: ['Open the recorded article'],
  evidenceIds: ['viewport'],
  confidence: 0.95,
  sensitivity: 'ordinary',
  suggestedListIds: [list.id],
};

function notes() {
  return {
    source: 'Synthetic fixture with independently specified browser facts',
    observedAt: '2026-11-21T16:01:00.000Z',
    context: {
      sensitivity: 'ordinary',
      privacyChecked: true,
      os: { name: 'Windows', version: '11' },
      product: {
        id: 'adguard',
        name: 'AdGuard AdBlocker',
        version: '5.5.4.76',
        manifestVersion: 3,
      },
      prerequisites: { filtersCurrent: true, productCurrent: true, browserCurrent: true },
    },
    images: [{ id: 'viewport', sensitivity: 'ordinary', sanitized: true, redactions: [] }],
  };
}

async function githubFixture(t) {
  let file;
  let issue;
  const writes = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-github-token');
      if (
        request.method === 'GET' &&
        ['/repos/operator/evidence', '/repos/AdguardTeam/AdguardFilters'].includes(url.pathname)
      ) {
        const full_name = url.pathname.slice('/repos/'.length);
        return send(200, {
          id: full_name.startsWith('operator/') ? 1 : 2,
          full_name,
          private: false,
          archived: false,
          disabled: false,
          has_issues: true,
          default_branch: 'main',
          permissions: {
            push: full_name.startsWith('operator/'),
            admin: full_name.startsWith('operator/'),
          },
        });
      }
      if (url.pathname.startsWith('/repos/operator/evidence/contents/screenshots/')) {
        if (request.method === 'GET')
          return send(file ? 200 : 404, file ?? { message: 'Not Found' });
        assert.equal(request.method, 'PUT');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        const bytes = Buffer.from(body.content, 'base64');
        file = {
          type: 'file',
          path: url.pathname.split('/contents/')[1],
          sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
        };
        writes.push({ operation: 'upload', at: Date.now() });
        return send(201, { content: file, commit: { sha: 'a'.repeat(40) } });
      }
      if (url.pathname === '/search/issues')
        return send(200, {
          total_count: issue ? 1 : 0,
          incomplete_results: false,
          items: issue ? [issue] : [],
        });
      if (
        url.pathname === '/repos/AdguardTeam/AdguardFilters/issues' &&
        request.method === 'POST'
      ) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.match(body.body, /https:\/\/raw\.githubusercontent\.com\/operator\/evidence\//);
        assert.equal(body.body.includes('dataBase64'), false);
        issue = {
          id: 42,
          number: 42,
          html_url: 'https://github.com/AdguardTeam/AdguardFilters/issues/42',
          title: body.title,
          body: body.body,
          comments: 0,
          state: 'closed',
          state_reason: 'not_planned',
          locked: false,
          labels: [],
        };
        writes.push({ operation: 'issue', at: Date.now() });
        return send(201, issue);
      }
      if (url.pathname === '/repos/AdguardTeam/AdguardFilters/issues/42') return send(200, issue);
      if (url.pathname === '/repos/AdguardTeam/AdguardFilters/issues/42/comments')
        return send(200, []);
      throw new Error(`Unexpected fixture request ${request.method} ${url.pathname}`);
    } catch (error) {
      failures.push(error);
      send(500, { message: 'Fixture assertion failed' });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    assert.deepEqual(failures, []);
  });
  return { base: `http://127.0.0.1:${server.address().port}`, writes };
}

test('real report and upload adapters deliver once after annotation, survive reopen, and retain a closed-but-unverified fix', async (t) => {
  const github = await githubFixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'observatory-workflow-'));
  let store = openStore(directory);
  let worker;
  t.after(async () => {
    await worker?.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  config.publication.enabled = true;
  config.publication.evidenceRepository = 'operator/evidence';
  config.publication.minIntervalMs = 1100;
  let analyses = 0;
  const makeWorker = () =>
    createWorker({
      store,
      config,
      env: {},
      prepare: prepareReport,
      analyze: async () => {
        analyses++;
        return {
          state: 'accepted',
          findings: [observation],
          provenance: { model: 'external-fixture' },
        };
      },
      publisher: createGitHubPublisher({ token: 'fixture-github-token', apiBase: github.base }),
    });
  worker = makeWorker();
  const capture = captureFixture({
    context: {
      lists: [list],
      pageState: 'usable',
      blockers: [{ id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true }],
    },
  });
  store.saveCatalog({
    source: 'manual',
    records: [{ ...list, owner: 'AdguardTeam/AdguardFilters', categories: ['ads'] }],
    counts: {},
  });
  store.ingest(capture);
  await worker.cycle();
  assert.equal(store.reports()[0].state, 'deferred');
  assert.equal(github.writes.length, 0);
  store.annotateCapture(capture.id, notes());
  await worker.cycle();
  const report = store.reports()[0];
  assert.equal(
    report.state,
    'created',
    JSON.stringify({ reasons: report.reasons, reason: report.reason, writes: github.writes }),
  );
  assert.equal(report.receipt.issueNumber, 42);
  assert.equal(report.receipt.attachmentCompleteness.state, 'complete');
  assert.deepEqual(
    github.writes.map((item) => item.operation),
    ['upload', 'issue'],
  );
  assert.ok(github.writes[1].at - github.writes[0].at >= 1000);
  assert.equal(store.getRecord(`followup:${report.id}`).result.lifecycle.resolved, false);
  assert.deepEqual(store.capture(capture.id), capture);
  await worker.stop();
  store.close();
  store = openStore(directory);
  worker = makeWorker();
  await worker.cycle();
  assert.equal(analyses, 1);
  assert.equal(github.writes.length, 2);
  assert.equal(store.reports()[0].receipt.issueNumber, 42);
});

test(
  'authenticated intake reaches the real findings adapter and delivers one receipt through the HTTP pipeline',
  { timeout: 30000 },
  async (t) => {
    const github = await githubFixture(t);
    const directory = mkdtempSync(join(tmpdir(), 'observatory-http-pipeline-'));
    const store = openStore(directory);
    const capture = captureFixture({
      id: 'capture_http_pipeline',
      context: {
        lists: [list],
        pageState: 'usable',
        blockers: [
          { id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true },
        ],
      },
    });
    const providerErrors = [];
    let requests = 0;
    const provider = createServer(async (request, response) => {
      try {
        requests++;
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer fixture-provider-key');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.model, 'fixture-vision');
        assert.deepEqual(
          body.tools.map((tool) => tool.function.name),
          ['return_findings'],
        );
        assert.equal(body.response_format, undefined);
        const image = body.messages[1].content.find((part) => part.type === 'image_url');
        assert.equal(image.image_url.url, `data:image/png;base64,${capture.images[0].dataBase64}`);
        const payload = {
          schemaVersion: 1,
          assessment: 'observed_issue',
          findings: [observation],
          limitations: ['Synthetic transport fixture'],
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'fixture_findings_call',
                      type: 'function',
                      function: { name: 'return_findings', arguments: JSON.stringify(payload) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 120, total_tokens: 220 },
          }),
        );
      } catch (error) {
        providerErrors.push(error);
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture assertion failed' }));
      }
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const config = structuredClone(defaultConfig);
    config.autoProcess = false;
    config.provider.enabled = true;
    config.provider.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    config.provider.model = 'fixture-vision';
    config.publication.enabled = true;
    config.publication.evidenceRepository = 'operator/evidence';
    config.publication.minIntervalMs = 1100;
    const worker = createWorker({
      store,
      config,
      env: { PROXY_API_KEY: 'fixture-provider-key' },
      publisher: createGitHubPublisher({ token: 'fixture-github-token', apiBase: github.base }),
    });
    const server = createHttpServer({ store, config, worker, token: 'fixture-worker-token' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await Promise.all([worker.stop(), server.shutdownOperations()]);
      await Promise.all(
        [server, provider].map(
          (listener) =>
            new Promise((resolve) => {
              listener.close(resolve);
              listener.closeAllConnections();
            }),
        ),
      );
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      Authorization: 'Bearer fixture-worker-token',
      'Content-Type': 'application/json',
    };
    const post = (path, body) =>
      fetch(`${base}/api/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: t.signal,
      });
    store.saveCatalog({
      source: 'manual',
      records: [{ ...list, owner: 'AdguardTeam/AdguardFilters', categories: ['ads'] }],
      counts: {},
    });
    for (const status of [201, 200]) {
      const response = await post('captures', capture);
      assert.equal(response.status, status);
      assert.equal((await response.json()).duplicate, status === 200);
    }
    const annotated = await post(`captures/${capture.id}/annotations`, notes());
    assert.equal(annotated.status, 200);
    await annotated.json();
    assert.equal(requests, 0);
    let completed;
    const completion = new Promise((resolve) => {
      completed = resolve;
    });
    const cycle = worker.cycle.bind(worker);
    t.mock.method(worker, 'cycle', (options) => {
      const result = cycle(options);
      completed(result);
      return result;
    });
    const processed = await post('process', {});
    assert.equal(processed.status, 202);
    await processed.json();
    await completion;
    assert.deepEqual(providerErrors, []);
    const state = await (await fetch(`${base}/api/state`, { headers, signal: t.signal })).json();
    assert.equal(state.captures[0].state, 'accepted');
    assert.equal(state.captures[0].analysis.provenance.assessment, 'observed_issue');
    assert.equal(state.captures[0].analysis.provenance.attempts, 1);
    assert.equal(state.reports[0].state, 'created', JSON.stringify(state.reports[0].reasons));
    assert.equal(state.reports[0].receipt.issueNumber, 42);
    assert.equal(state.operations[0].state, 'completed');
    assert.equal(requests, 1);
    assert.deepEqual(
      github.writes.map((item) => item.operation),
      ['upload', 'issue'],
    );
    const serialized = JSON.stringify(state);
    for (const privateValue of [
      'dataBase64',
      'fixture-provider-key',
      'fixture-worker-token',
      'fixture-github-token',
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
    const retry = await post('captures', capture);
    assert.equal(retry.status, 200);
    await retry.json();
    await worker.cycle();
    assert.equal(requests, 1);
    assert.equal(store.reports().length, 1);
    assert.equal(github.writes.length, 2);
  },
);

test('per-image sensitivity restricts provider dispatch and remains accurate when explicitly enabled', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-sensitivity-'));
  const store = openStore(directory);
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  config.provider.allowedSensitivity = ['ordinary'];
  const dispatched = [];
  const worker = createWorker({
    store,
    config,
    env: {},
    analyze: async (capture) => {
      dispatched.push(capture.context.sensitivity);
      return { state: 'accepted', findings: [], provenance: {} };
    },
  });
  t.after(async () => {
    await worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const capture = captureFixture({ context: { sensitivity: 'ordinary' } });
  const input = notes();
  input.images[0].sensitivity = 'nsfw';
  input.images[0].sanitized = false;
  store.ingest(capture);
  store.annotateCapture(capture.id, input);
  await worker.processCaptures();
  assert.equal(store.captureStatus(capture.id).state, 'abstained');
  assert.equal(store.captureStatus(capture.id).result.reason, 'evidence_class_not_enabled');
  assert.deepEqual(dispatched, []);
  config.provider.allowedSensitivity = ['nsfw'];
  assert.equal(store.retryCapture(capture.id), true);
  await worker.processCaptures();
  assert.equal(store.captureStatus(capture.id).state, 'accepted');
  assert.deepEqual(dispatched, ['nsfw']);
});

test('bounded preparation rotates past repeatedly deferred findings', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-fair-preparation-'));
  const store = openStore(directory);
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.scheduler.maxAnalysesPerCycle = 2;
  const examined = [];
  const worker = createWorker({
    store,
    config,
    env: {},
    prepare: (finding) => {
      examined.push(finding.id);
      return {
        id: finding.id,
        fingerprint: finding.id,
        state: 'deferred',
        reasons: ['fixture-missing-context'],
        body: '',
        title: '',
      };
    },
  });
  t.after(async () => {
    await worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 5; index++) {
    const capture = captureFixture({ id: `capture_fair_${index}` });
    store.ingest(capture);
    store.claimCapture(capture.id);
    const finding = { ...observation, id: `finding-${index}`, captureId: capture.id };
    store.finishCapture(capture.id, { state: 'accepted', findings: [finding], provenance: {} }, [
      {
        id: finding.id,
        fingerprint: finding.id,
        findingId: finding.id,
        captureId: capture.id,
        state: 'deferred',
        reasons: ['fixture-missing-context'],
        title: '',
        body: '',
      },
    ]);
  }
  await worker.refreshReports();
  await worker.refreshReports();
  await worker.refreshReports();
  assert.deepEqual([...new Set(examined)].sort(), [
    'finding-0',
    'finding-1',
    'finding-2',
    'finding-3',
    'finding-4',
  ]);
});

test('uncertain image recovery remains read-only after an unavailable reconciliation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-upload-recovery-'));
  const store = openStore(directory);
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  config.publication.enabled = true;
  config.publication.evidenceRepository = 'operator/evidence';
  const modes = [];
  const worker = createWorker({
    store,
    config,
    env: {},
    prepare: prepareReport,
    analyze: async () => ({ state: 'accepted', findings: [observation], provenance: {} }),
    publisher: {
      async uploadEvidence(_image, _config, options) {
        modes.push(options.reconcileOnly);
        return modes.length === 1
          ? { state: 'uncertain', reason: 'response_lost' }
          : { state: 'deferred', reason: 'github-read-unavailable' };
      },
    },
  });
  t.after(async () => {
    await worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const capture = captureFixture({
    context: {
      lists: [list],
      pageState: 'usable',
      blockers: [{ id: 'adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true }],
    },
  });
  store.saveCatalog({
    source: 'manual',
    records: [{ ...list, owner: 'AdguardTeam/AdguardFilters', categories: ['ads'] }],
    counts: {},
  });
  store.ingest(capture);
  store.annotateCapture(capture.id, notes());
  await worker.processCaptures();
  await worker.refreshReports();
  await worker.refreshReports();
  await worker.refreshReports();
  assert.deepEqual(modes, [false, true, true]);
  assert.equal(store.reports()[0].state, 'deferred');
});

test('context edited during preparation cannot make an older report ready', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-context-race-'));
  const store = openStore(directory);
  const config = structuredClone(defaultConfig);
  config.autoProcess = false;
  config.provider.enabled = true;
  let entered;
  let release;
  const preparing = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  const worker = createWorker({
    store,
    config,
    env: {},
    analyze: async () => ({ state: 'accepted', findings: [observation], provenance: {} }),
    prepare: async (finding) => {
      const ready = finding.context.privacyChecked === true;
      if (ready) {
        entered();
        await proceed;
      }
      return {
        id: finding.id,
        fingerprint: finding.id,
        state: ready ? 'ready' : 'deferred',
        reasons: ready ? [] : ['privacy-check-missing'],
        body: 'Synthetic report',
        title: 'Synthetic finding',
      };
    },
  });
  t.after(async () => {
    release();
    await worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const capture = captureFixture();
  store.ingest(capture);
  await worker.processCaptures();
  store.annotateCapture(capture.id, notes());
  const pending = worker.refreshReports();
  await preparing;
  const changed = notes();
  changed.context.privacyChecked = false;
  changed.images[0].sanitized = false;
  store.annotateCapture(capture.id, changed);
  release();
  await pending;
  assert.equal(store.reports()[0].state, 'deferred');
  assert.equal(store.annotations(capture.id).context.privacyChecked, false);
});
