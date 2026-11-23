import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { analyzeEvidence, findingsSchema, validateFindings } from '../src/analysis.mjs';
import { validateCapture } from '../src/capture.mjs';
import {
  buildFixtures,
  claimEvidence,
  createUpstreamGuard,
  evaluateCase,
  inspectClientRequest,
  inspectProxyError,
  observeUpstreamResponse,
  inspectUpstreamShape,
  readRepositoryMetadata,
  runQualification as runProductionQualification,
} from '../scripts/verify-analysis.mjs';

const fixtures = buildFixtures({ capturedAt: '2026-11-22T00:00:00.000Z' });
const provider = {
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'gpt-4.1',
  vision: true,
  outputMode: 'tool',
  timeoutMs: 2000,
  maxOutputTokens: 1536,
};
const issue = (brand, imageId) => ({
  schemaVersion: 1,
  assessment: 'observed_issue',
  findings: [
    {
      category: 'missed-ads',
      observation: `An advertisement for ${brand} is visible in the sidebar.`,
      expectedBehavior: 'The ad should be hidden by an ad-blocking policy.',
      reproduction: ['Open the supplied article and inspect the sidebar.'],
      evidenceIds: [imageId],
      confidence: 0.9,
      sensitivity: 'ordinary',
      suggestedListIds: [],
    },
  ],
  limitations: ['No blocker or network behavior was measured.'],
});
const clean = { schemaVersion: 1, assessment: 'no_issue_observed', findings: [], limitations: [] };
const completion = (payload) => ({
  id: 'offline-completion',
  model: 'gpt-4.1',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'offline-call',
            type: 'function',
            function: { name: 'return_findings', arguments: JSON.stringify(payload) },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 },
});
const result = (payload) => ({
  state: 'accepted',
  findings: payload.findings,
  provenance: { assessment: payload.assessment, limitations: payload.limitations },
});
const directory = async (t) => {
  const base = path.join(tmpdir(), 'opencode');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'verify-analysis-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('synthetic fixture answers occur in pixels, not transmitted metadata or PNG text chunks', () => {
  for (const fixture of fixtures.live) {
    assert.deepEqual(validateCapture(fixture.capture), fixture.capture);
    const metadata = JSON.stringify({
      ...fixture.capture,
      images: fixture.capture.images.map(({ dataBase64, ...image }) => image),
    });
    for (const word of [
      'Cobalt',
      'Kettle',
      'Amber',
      'Mug',
      'observed_issue',
      'no_issue_observed',
      'missed-ads',
    ])
      assert.equal(metadata.includes(word), false);
    assert.equal(fixture.capture.text, '');
    assert.deepEqual(fixture.capture.context.lists, []);
  }
  for (const [index, bytes] of fixtures.images.entries()) {
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    assert.equal(decoded.width, 960);
    assert.equal(decoded.height, 640);
    const chunks = [];
    for (let at = 8; at < bytes.length; at += bytes.readUInt32BE(at) + 12)
      chunks.push(bytes.toString('ascii', at + 4, at + 8));
    assert.ok(chunks.every((chunk) => ['IHDR', 'IDAT', 'IEND'].includes(chunk)));
    assert.equal(
      decoded.data.every((byte) => byte === 255),
      index === 3,
    );
  }
  assert.equal(
    fixtures.live[2].capture.images[0].dataBase64,
    fixtures.live[1].capture.images[0].dataBase64,
  );
  assert.notEqual(
    fixtures.live[2].capture.images[0].dataBase64,
    fixtures.live[2].capture.images[1].dataBase64,
  );
});

test('production adapter abstains on both local controls without an outbound fetch', async () => {
  for (const fixture of fixtures.local) {
    let calls = 0;
    const value = await analyzeEvidence(fixture.capture, provider, {
      fetchImpl: async () => {
        calls++;
        throw new Error('must not dispatch');
      },
    });
    assert.equal(value.state, 'abstained');
    assert.equal(value.reason, fixture.reason);
    assert.deepEqual(value.findings, []);
    assert.equal(value.provenance.attempts, 0);
    assert.equal(calls, 0);
  }
});

test('oracle distinguishes a grounded ad, clean capture and second-image citation through the real adapter', async () => {
  const payloads = [
    issue('Cobalt Kettle', fixtures.live[0].capture.images[0].id),
    clean,
    issue('Amber Mug', fixtures.live[2].capture.images[1].id),
  ];
  for (const [index, fixture] of fixtures.live.entries()) {
    const value = await analyzeEvidence(fixture.capture, provider, {
      fetchImpl: async (_url, init) => {
        inspectClientRequest(init.body, fixture, findingsSchema);
        return Response.json(completion(payloads[index]));
      },
    });
    assert.equal(value.state, 'accepted');
    assert.equal(evaluateCase(fixture, value, validateFindings).passed, true);
    assert.equal(value.provenance.assessment, index === 1 ? 'no_issue_observed' : 'observed_issue');
  }
});

test('semantic oracle rejects extra findings, wrong visual brand, wrong image and invented experiments', () => {
  const fixture = fixtures.live[2];
  const valid = issue('Amber Mug', fixture.capture.images[1].id);
  const cases = [
    [
      'wrong_visual_brand',
      (payload) => {
        payload.findings[0].observation = 'An advertisement for Cobalt Kettle is visible.';
      },
    ],
    [
      'ad_image_not_cited',
      (payload) => {
        payload.findings[0].evidenceIds = [fixture.capture.images[0].id];
      },
    ],
    [
      'wrong_finding_count',
      (payload) => {
        payload.findings.push(structuredClone(payload.findings[0]));
      },
    ],
    [
      'unexpected_category',
      (payload) => {
        payload.findings[0].category = 'tracker';
      },
    ],
    [
      'missing_expected_ad_suppression',
      (payload) => {
        payload.findings[0].expectedBehavior = 'A nice website.';
      },
    ],
    [
      'unsupported_experiment_claim',
      (payload) => {
        payload.findings[0].reproduction.push('We disabled the blocker and verified the result.');
      },
    ],
    [
      'invalid_production_findings',
      (payload) => {
        payload.findings[0].evidenceIds = ['text'];
      },
    ],
    [
      'invalid_production_findings',
      (payload) => {
        payload.findings[0].suggestedListIds = ['made-up-list'];
      },
    ],
  ];
  for (const [reason, mutate] of cases) {
    const payload = structuredClone(valid);
    mutate(payload);
    const checks = evaluateCase(fixture, result(payload), validateFindings);
    assert.equal(checks.passed, false, reason);
    assert.ok(checks.problems.includes(reason), reason);
  }
  assert.equal(evaluateCase(fixtures.live[0], result(clean), validateFindings).passed, false);
  assert.equal(
    evaluateCase(
      fixtures.live[1],
      result(issue('Cobalt Kettle', fixtures.live[1].capture.images[0].id)),
      validateFindings,
    ).passed,
    false,
  );
});

test('semantic oracle rejects unmeasured blocking-state inferences in otherwise valid findings', () => {
  const fixture = fixtures.live[2];
  for (const mutate of [
    (payload) => {
      payload.findings[0].observation =
        "An advertisement for 'Amber Mug' appears in the second screenshot. This indicates that the ad was not blocked.";
    },
    (payload) => {
      payload.findings[0].reproduction = [
        'Compare the screenshots: the second (presumably without content blocking) displays an advertisement.',
      ];
    },
  ]) {
    const payload = issue('Amber Mug', fixture.capture.images[1].id);
    mutate(payload);
    assert.deepEqual(validateFindings(payload, fixture.capture), payload);
    const checks = evaluateCase(fixture, result(payload), validateFindings);
    assert.equal(checks.passed, false);
    assert.ok(checks.problems.includes('unsupported_experiment_claim'));
  }
  const grounded = issue('Amber Mug', fixture.capture.images[1].id);
  grounded.findings[0].observation =
    'An advertisement for Amber Mug is visible; blocker state is unknown.';
  assert.equal(evaluateCase(fixture, result(grounded), validateFindings).passed, true);
});

test('production rejects incomplete findings and forbidden citations before qualification can pass', async () => {
  for (const mutate of [
    (payload) => {
      delete payload.findings[0].expectedBehavior;
    },
    (payload) => {
      payload.findings[0].evidenceIds = ['unsupplied'];
    },
    (payload) => {
      payload.findings[0].evidenceIds = ['text'];
    },
    (payload) => {
      payload.findings[0].confidence = 'certain';
    },
  ]) {
    const fixture = fixtures.live[0];
    const payload = issue('Cobalt Kettle', fixture.capture.images[0].id);
    mutate(payload);
    const value = await analyzeEvidence(fixture.capture, provider, {
      fetchImpl: async () => Response.json(completion(payload)),
    });
    assert.equal(value.state, 'failed');
    assert.equal(value.reason, 'invalid_findings');
    assert.equal(evaluateCase(fixture, value, validateFindings).passed, false);
  }
});

async function outgoing(fixture) {
  let request;
  await analyzeEvidence(fixture.capture, provider, {
    fetchImpl: async (_url, init) => {
      request = inspectClientRequest(init.body, fixture, findingsSchema).request;
      return Response.json(completion(clean));
    },
  });
  return request;
}
function mapped(request) {
  return {
    config: {
      stream: { enabled: true },
      modules: {
        prompt_templating: {
          model: {
            name: 'gpt-4.1',
            version: '2025-04-14',
            params: { max_completion_tokens: 1536 },
          },
          prompt: { template: [{ role: 'user', content: request.messages[1].content }] },
        },
      },
    },
    messages_history: [
      {
        role: 'system',
        content: [{ type: 'text', text: `return_findings ${JSON.stringify(findingsSchema)}` }],
      },
      { role: 'system', content: [{ type: 'text', text: request.messages[0].content }] },
    ],
  };
}
const endpoint =
  'https://sap-fixture.invalid/aic/llm/api/v1/completionV2?workspace=fixture&resourceGroupId=fixture';
const initFor = (request) => ({
  method: 'POST',
  redirect: 'manual',
  body: JSON.stringify(mapped(request)),
});

test('guard rejects altered bytes, swapped images, route/version/output-limit changes before transport', async () => {
  const fixture = fixtures.live[2],
    request = await outgoing(fixture);
  for (const alter of [
    (body) => {
      body.config.modules.prompt_templating.model.version = 'other';
    },
    (body) => {
      body.config.modules.prompt_templating.model.params.max_completion_tokens = 131072;
    },
    (body) => {
      body.config.modules.prompt_templating.prompt.template[0].content[2].image_url.url =
        'data:image/png;base64,bad';
    },
    (body) => {
      const parts = body.config.modules.prompt_templating.prompt.template[0].content;
      [parts[2], parts[4]] = [parts[4], parts[2]];
    },
    (body) => {
      body.messages_history[1].content[0].text = 'altered';
    },
  ]) {
    let calls = 0;
    const guard = createUpstreamGuard({
      endpoint,
      remoteFetch: async () => {
        calls++;
        return new Response('');
      },
      write: async () => {},
    });
    guard.select(fixture, request);
    const body = structuredClone(mapped(request));
    alter(body);
    await assert.rejects(
      guard.fetch(endpoint, { method: 'POST', redirect: 'manual', body: JSON.stringify(body) }),
    );
    assert.equal(calls, 0);
    assert.equal(guard.counts().reserved, 0);
  }
  let calls = 0;
  const guard = createUpstreamGuard({
    endpoint,
    remoteFetch: async () => {
      calls++;
    },
    write: async () => {},
  });
  guard.select(fixture, request);
  for (const [url, init] of [
    ['https://sap-fixture.invalid/', { method: 'GET', redirect: 'manual' }],
    [endpoint, { ...initFor(request), redirect: 'follow' }],
    ['https://other.invalid/aic/llm/api/v1/completionV2', initFor(request)],
  ])
    await assert.rejects(guard.fetch(url, init), { code: 'non_completion_operation_blocked' });
  assert.equal(calls, 0);
});

test('inherited multiple-choice parameters cannot multiply the qualified output allowance', async () => {
  const fixture = fixtures.live[0],
    request = await outgoing(fixture);
  for (const n of [2, 0, -1, '1', null, 1.5]) {
    let calls = 0;
    const guard = createUpstreamGuard({
      endpoint,
      remoteFetch: async () => {
        calls++;
        return new Response('');
      },
      write: async () => {},
    });
    guard.select(fixture, request);
    const body = mapped(request);
    body.config.modules.prompt_templating.model.params.n = n;
    await assert.rejects(
      guard.fetch(endpoint, { method: 'POST', redirect: 'manual', body: JSON.stringify(body) }),
      { code: 'upstream_choice_count_changed' },
    );
    assert.equal(calls, 0);
    assert.equal(guard.counts().reserved, 0);
  }
  for (const n of [undefined, 1]) {
    let calls = 0;
    const guard = createUpstreamGuard({
      endpoint,
      remoteFetch: async () => {
        calls++;
        return new Response('');
      },
      write: async () => {},
    });
    guard.select(fixture, request);
    const body = mapped(request);
    if (n !== undefined) body.config.modules.prompt_templating.model.params.n = n;
    await guard.fetch(endpoint, { method: 'POST', redirect: 'manual', body: JSON.stringify(body) });
    assert.equal(calls, 1);
    assert.equal(guard.counts().reserved, 1);
  }
});

test('guard reserves before await, blocks concurrent same-case calls, and stops at three total', async () => {
  let calls = 0;
  const records = [];
  const guard = createUpstreamGuard({
    endpoint,
    remoteFetch: async () => {
      calls++;
      return new Response('');
    },
    write: async (name, value) => {
      records.push({ name, value, callsAtWrite: calls });
    },
  });
  const first = await outgoing(fixtures.live[0]);
  guard.select(fixtures.live[0], first);
  const pair = await Promise.allSettled([
    guard.fetch(endpoint, initFor(first)),
    guard.fetch(endpoint, initFor(first)),
  ]);
  assert.deepEqual(
    pair.map((item) => item.status),
    ['fulfilled', 'rejected'],
  );
  for (const fixture of fixtures.live.slice(1)) {
    const request = await outgoing(fixture);
    guard.select(fixture, request);
    await guard.fetch(endpoint, initFor(request));
  }
  const fourth = structuredClone(fixtures.live[0]);
  fourth.id = 'extra-case';
  guard.select(fourth, first);
  await assert.rejects(guard.fetch(endpoint, initFor(first)), {
    code: 'upstream_request_budget_exhausted',
  });
  assert.equal(calls, 3);
  assert.equal(guard.counts().reserved, 3);
  assert.deepEqual(
    records
      .filter((record) => record.name.endsWith('-dispatch.json'))
      .map((record) => record.callsAtWrite),
    [0, 1, 2],
  );
});

test('a failed durable dispatch write spends its reservation without sending or allowing replay', async () => {
  const fixture = fixtures.live[0],
    request = await outgoing(fixture);
  let calls = 0;
  const guard = createUpstreamGuard({
    endpoint,
    remoteFetch: async () => {
      calls++;
    },
    write: async () => {
      throw new Error('disk unavailable');
    },
  });
  guard.select(fixture, request);
  await assert.rejects(guard.fetch(endpoint, initFor(request)), /disk unavailable/);
  await assert.rejects(guard.fetch(endpoint, initFor(request)), {
    code: 'upstream_request_budget_exhausted',
  });
  assert.equal(guard.counts().reserved, 1);
  assert.equal(calls, 0);
});

test('inherited reservations exclude spent cases and limit continuation to two new dispatches', async () => {
  let calls = 0;
  const guard = createUpstreamGuard({
    endpoint,
    priorSpent: ['case-01'],
    remoteFetch: async () => {
      calls++;
      return new Response('');
    },
    write: async () => {},
  });
  const first = await outgoing(fixtures.live[0]);
  guard.select(fixtures.live[0], first);
  await assert.rejects(guard.fetch(endpoint, initFor(first)), {
    code: 'upstream_request_budget_exhausted',
  });
  for (const fixture of fixtures.live.slice(1)) {
    const request = await outgoing(fixture);
    guard.select(fixture, request);
    await guard.fetch(endpoint, initFor(request));
  }
  assert.equal(calls, 2);
  assert.equal(guard.counts().reserved, 2);
  assert.deepEqual(guard.reservedCaseIds(), ['case-01', 'case-02', 'case-03']);
});

test('status-receipt failure cancels the upstream body without refunding its request', async () => {
  let cancelled = false;
  const fixture = fixtures.live[0],
    request = await outgoing(fixture);
  const guard = createUpstreamGuard({
    endpoint,
    remoteFetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    write: async (name) => {
      if (name.endsWith('-upstream-status.json')) throw new Error('status write failed');
    },
  });
  guard.select(fixture, request);
  await assert.rejects(guard.fetch(endpoint, initFor(request)), /status write failed/);
  assert.equal(cancelled, true);
  assert.equal(guard.counts().reserved, 1);
  assert.equal(guard.counts().started, 1);
  assert.equal(await guard.settle(), true);
  assert.equal(guard.counts().pendingHeaders, 0);
});

test('proxy diagnostics retain only fixed typed facts and distinguish upstream errors from missing tools', async () => {
  const secret = 'untrusted-value-that-must-never-be-recorded';
  const diagnostic = await inspectProxyError(
    Response.json(
      {
        error: {
          message: secret,
          code: secret,
          type: secret,
          param: secret,
          model: secret,
          retryable: true,
          partial_output: false,
          extra: secret,
        },
      },
      { status: 502 },
    ),
  );
  assert.deepEqual(diagnostic, {
    httpStatus: 502,
    code: null,
    type: null,
    param: null,
    retryable: true,
    partialOutput: false,
    requestedModelMatches: false,
    classification: 'unclassified_proxy_failure',
    readState: 'complete',
  });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  const error = await inspectProxyError(
    Response.json(
      {
        error: {
          code: 'upstream_error',
          type: 'upstream_error',
          message: secret,
          model: 'gpt-4.1',
          partial_output: true,
        },
      },
      { status: 502 },
    ),
  );
  assert.equal(error.classification, 'upstream_failure');
  assert.equal(error.partialOutput, true);
  assert.equal(error.requestedModelMatches, true);
  assert.equal(JSON.stringify(error).includes(secret), false);
});

test('oversized and cancelled proxy diagnostics stop reading and cancel their response streams', async () => {
  let largeCancelled = false;
  const large = await inspectProxyError(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8193));
        },
        cancel() {
          largeCancelled = true;
        },
      }),
      { status: 502 },
    ),
  );
  assert.equal(large.readState, 'too_large');
  assert.equal(largeCancelled, true);
  let cancelled = false;
  const controller = new AbortController();
  const pending = inspectProxyError(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 502 },
    ),
    controller.signal,
  );
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.readState, 'cancelled');
  assert.equal(cancelled, true);
});

test('evidence claims and files are exclusive and preserve an earlier attempt', async (t) => {
  const root = await directory(t),
    output = path.join(root, 'missing-parent', 'nested', 'run');
  const recorder = await claimEvidence(output);
  await recorder.write('intent.json', { intent: 'first' });
  await assert.rejects(claimEvidence(output), { code: 'EEXIST' });
  await assert.rejects(recorder.write('intent.json', { intent: 'replacement' }), {
    code: 'EEXIST',
  });
  await assert.rejects(recorder.write('../outside.json', {}), { code: 'invalid_artifact_name' });
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'intent.json'), 'utf8')), {
    intent: 'first',
  });
});

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const proxyRoot =
  process.env.SAP_QUALIFICATION_PROXY_ROOT ||
  path.resolve(projectRoot, '../../cli-tools/sap-aic-openai-proxy');
const hasProxy = await access(path.join(proxyRoot, 'src/server.mjs')).then(
  () => true,
  () => false,
);
const loadProxy = async () =>
  Object.assign(
    {},
    ...(await Promise.all(
      ['mapper', 'tools', 'upstream'].map(
        (name) => import(pathToFileURL(path.join(proxyRoot, `src/${name}.mjs`))),
      ),
    )),
  );
function metadataReply(callback, error = null, stdout = '', stderr = '') {
  const child = new EventEmitter();
  queueMicrotask(() => {
    callback(error, stdout, stderr);
    child.emit('close', error ? 1 : 0, null);
  });
  return child;
}
function fixtureMetadata(file, args, options, callback) {
  assert.equal(file, 'git');
  assert.equal(options.shell, false);
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok([projectRoot, proxyRoot].some((root) => path.relative(root, options.cwd) === ''));
  if (args.join(' ') === 'rev-parse HEAD')
    return metadataReply(callback, null, '1'.repeat(40) + '\n');
  assert.deepEqual(args, ['--no-optional-locks', 'status', '--short']);
  return metadataReply(callback);
}
const runQualification = (options, dependencies) =>
  runProductionQualification(options, { metadataExecFile: fixtureMetadata, ...dependencies });

test('metadata failures distinguish termination, unavailable executables, overflow and invalid output', async () => {
  for (const [error, stdout, outcome] of [
    [Object.assign(new Error('unretained process detail'), { code: 'ENOENT' }), '', 'spawn_failed'],
    [
      Object.assign(new Error('unretained process detail'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      }),
      '',
      'output_limit',
    ],
    [Object.assign(new Error('unretained process detail'), { code: 128 }), '', 'exited_nonzero'],
    [
      Object.assign(new Error('unretained process detail'), {
        code: null,
        signal: 'SIGTERM',
        killed: true,
      }),
      '',
      'terminated',
    ],
    [null, 'not-a-commit', 'invalid_output'],
  ]) {
    let operations = 0;
    const result = await readRepositoryMetadata(projectRoot, {
      execFileImpl(_file, _args, _options, callback) {
        operations++;
        return metadataReply(callback, error, stdout, 'unretained stderr');
      },
    });
    assert.equal(result.metadata.state, 'failed');
    assert.equal(result.metadata.operations[0].outcome, outcome);
    assert.equal(result.metadata.operations[0].cleanupConfirmed, true);
    assert.equal(result.head, null);
    assert.equal(result.dirtyState, null);
    assert.equal(operations, 1, 'failed metadata cannot start a second command');
    assert.equal(JSON.stringify(result).includes('unretained'), false);
    assert.equal(JSON.stringify(result).includes('not-a-commit'), false);
  }
});

test('metadata cancellation waits for process close and cannot accept late successful output', async () => {
  const controller = new AbortController();
  let calls = 0,
    finishChild,
    resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const pending = readRepositoryMetadata(projectRoot, {
    signal: controller.signal,
    execFileImpl(_file, _args, options, callback) {
      calls++;
      const child = new EventEmitter();
      options.signal.addEventListener(
        'abort',
        () => callback(Object.assign(new Error('unretained abort detail'), { code: 'ABORT_ERR' })),
        { once: true },
      );
      finishChild = () => {
        callback(null, '2'.repeat(40) + '\n', '');
        child.emit('close', 0, null);
      };
      resolveStarted();
      return child;
    },
  });
  await started;
  controller.abort();
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'an abort callback does not establish subprocess termination');
  finishChild();
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.head, null);
  assert.equal(result.metadata.operations[0].outcome, 'cancelled');
  assert.equal(result.metadata.operations[0].cleanupConfirmed, true);
});

test('metadata collection uses real asynchronous child close semantics with a synthetic executable', async () => {
  let operations = 0;
  const result = await readRepositoryMetadata(projectRoot, {
    execFileImpl(file, args, options, callback) {
      assert.equal(file, 'git');
      assert.equal(options.shell, false);
      operations++;
      const answer = args[0] === 'rev-parse' ? '3'.repeat(40) + '\n' : ' M synthetic-file.mjs\n';
      return execFile(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', answer],
        options,
        callback,
      );
    },
  });
  assert.equal(result.head, '3'.repeat(40));
  assert.equal(result.dirtyState, 'M synthetic-file.mjs');
  assert.equal(result.metadata.source, 'injected-offline');
  assert.equal(result.metadata.state, 'completed');
  assert.equal(operations, 2);
  assert.ok(
    result.metadata.operations.every(
      (operation) =>
        operation.outcome === 'completed' && operation.cleanupConfirmed && operation.pid > 0,
    ),
  );
});

test(
  'metadata timeout retains collected hashes and its exact startup boundary without dispatch',
  { skip: !hasProxy && 'Sibling proxy required for source hashing' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run');
    let transportCalls = 0;
    const report = await runQualification(
      { output, proxyRoot, sessionFile: path.join(root, 'absent-session.json') },
      {
        metadataExecFile(file, args, options, callback) {
          if (path.relative(proxyRoot, options.cwd) === '' && args[0] === 'rev-parse') {
            return metadataReply(
              callback,
              Object.assign(new Error('private process detail'), { code: 'ETIMEDOUT' }),
              'private stdout',
              'private stderr',
            );
          }
          return fixtureMetadata(file, args, options, callback);
        },
        upstreamFetch: async () => {
          transportCalls++;
          throw new Error('must not dispatch');
        },
      },
    );
    assert.equal(report.reason, 'source_metadata_timeout');
    assert.equal(report.sourceMetadataFailure.scope, 'proxy');
    assert.equal(report.sourceMetadataFailure.operation, 'head');
    assert.equal(report.sourceMetadataFailure.outcome, 'timeout');
    assert.equal(report.sourceMetadataFailure.cleanupConfirmed, true);
    assert.equal(report.sources.application.metadata.source, 'injected-offline');
    assert.equal(report.sources.application.metadata.state, 'completed');
    assert.equal(report.sources.proxy.head, null);
    const expectedHash = createHash('sha256')
      .update(await readFile(new URL('../src/analysis.mjs', import.meta.url)))
      .digest('hex');
    assert.equal(report.sources.application.hashes['src/analysis.mjs'], expectedHash);
    assert.equal(report.sourceMatchesAfter.application['src/analysis.mjs'], true);
    assert.equal(report.sourceMatchesAfter.proxy['src/mapper.mjs'], true);
    assert.equal(report.requests.adapterFetches, 0);
    assert.equal(report.requests.upstream.reserved, 0);
    assert.equal(transportCalls, 0);
    assert.equal(report.cleanup.listenerClosed, true);
    assert.equal(report.cleanup.sessionSnapshotRemoved, true);
    assert.equal(report.localControls, undefined);
    const saved = await readFile(path.join(output, 'receipt.json'), 'utf8');
    for (const withheld of ['private process detail', 'private stdout', 'private stderr'])
      assert.equal(saved.includes(withheld), false);
  },
);

test(
  'metadata cancellation stops qualification before local controls, credentials and dispatch',
  { skip: !hasProxy && 'Sibling proxy required for source hashing' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run');
    const controller = new AbortController();
    let operations = 0,
      transportCalls = 0;
    const report = await runQualification(
      {
        output,
        proxyRoot,
        signal: controller.signal,
        sessionFile: path.join(root, 'absent-session.json'),
      },
      {
        metadataExecFile(_file, _args, options, callback) {
          operations++;
          const child = new EventEmitter();
          options.signal.addEventListener(
            'abort',
            () => {
              callback(Object.assign(new Error('unretained abort detail'), { code: 'ABORT_ERR' }));
              child.emit('close', null, 'SIGTERM');
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
          return child;
        },
        upstreamFetch: async () => {
          transportCalls++;
          throw new Error('must not dispatch');
        },
      },
    );
    assert.equal(report.reason, 'source_metadata_cancelled');
    assert.equal(report.sourceMetadataFailure.scope, 'application');
    assert.equal(report.sourceMetadataFailure.outcome, 'cancelled');
    assert.equal(report.sourceMetadataFailure.cleanupConfirmed, true);
    assert.equal(operations, 1);
    assert.equal(report.localControls, undefined);
    assert.equal(report.requests.adapterFetches, 0);
    assert.equal(report.requests.upstream.reserved, 0);
    assert.equal(transportCalls, 0);
    assert.equal(report.cleanup.listenerClosed, true);
    assert.equal(report.cleanup.sessionSnapshotRemoved, true);
    assert.equal(
      await access(path.join(output, 'session.private.json')).then(
        () => true,
        () => false,
      ),
      false,
    );
  },
);

test('live mode rejects injected metadata before claiming evidence or accessing a session', async (t) => {
  const root = await directory(t),
    output = path.join(root, 'run');
  await assert.rejects(
    runProductionQualification(
      { live: true, output, proxyRoot, sessionFile: path.join(root, 'absent-session.json') },
      { metadataExecFile: fixtureMetadata },
    ),
    { code: 'live_run_cannot_inject_metadata' },
  );
  assert.equal(
    await access(output).then(
      () => true,
      () => false,
    ),
    false,
  );
});

async function sessionFixture(root, overrides = {}) {
  const sessionFile = path.join(root, 'source.private.json');
  await writeFile(
    sessionFile,
    JSON.stringify({
      baseUrl: 'https://sap-fixture.invalid',
      workspace: 'fixture',
      resourceGroupId: 'fixture',
      deploymentId: 'fixture',
      cookie: `offline-cookie-${randomUUID()}`,
      csrf: `offline-csrf-${randomUUID()}`,
      models: [{ id: 'gpt-4.1', version: '2025-04-14', enabled: true }],
      ...overrides,
    }),
  );
  return sessionFile;
}
function sse(payload) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ tool_calls: [{ name: 'return_findings', arguments: payload }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test(
  'real disposable proxy and production adapter complete an offline three-cell run and remove the private snapshot',
  { skip: !hasProxy && 'Sibling proxy required for this optional loopback integration check' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run'),
      sessionFile = await sessionFixture(root);
    const before = await readFile(sessionFile);
    let calls = 0;
    const report = await runQualification(
      { output, proxyRoot, sessionFile },
      {
        upstreamFetch: async (_url, init) => {
          assert.equal(
            await access(path.join(output, 'local-controls.json')).then(
              () => true,
              () => false,
            ),
            true,
          );
          const body = JSON.parse(init.body),
            content = body.config.modules.prompt_templating.prompt.template[0].content;
          const imageId = JSON.parse(content[calls === 2 ? 3 : 1].text).evidenceId;
          return sse(
            calls++ === 1 ? clean : issue(calls === 1 ? 'Cobalt Kettle' : 'Amber Mug', imageId),
          );
        },
      },
    );
    assert.equal(report.state, 'passed', report.reason);
    assert.equal(report.mode, 'offline-transport-double');
    assert.equal(report.cases.length, 3);
    assert.equal(report.requests.adapterFetches, 3);
    assert.equal(report.requests.proxyRequests, 3);
    assert.equal(report.requests.upstream.started, 3);
    assert.equal(calls, 3);
    assert.ok(
      report.localControls.every(
        (control) =>
          control.passed && control.credentialsLoaded === false && control.upstreamPosts === 0,
      ),
    );
    assert.equal(report.cleanup.sessionSnapshotRemoved, true);
    assert.equal(report.cleanup.listenerClosed, true);
    assert.equal(report.cleanup.activeLocalResponses, 0);
    assert.equal(report.cleanup.originalSessionUnchanged, true);
    assert.deepEqual(await readFile(sessionFile), before);
    const files = await readdir(output);
    assert.equal(files.includes('session.private.json'), false);
    const saved = (
      await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) => readFile(path.join(output, file), 'utf8')),
      )
    ).join('\n');
    const session = JSON.parse(before);
    assert.equal(saved.includes(session.cookie), false);
    assert.equal(saved.includes(session.csrf), false);
    const count = calls;
    await assert.rejects(
      runQualification(
        { output, proxyRoot, sessionFile },
        {
          upstreamFetch: async () => {
            calls++;
          },
        },
      ),
      { code: 'EEXIST' },
    );
    assert.equal(calls, count);
  },
);

test(
  'unavailable model fails before transport and cleans a snapshot created before listener startup',
  { skip: !hasProxy && 'Sibling proxy required for this optional loopback integration check' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run');
    const sessionFile = await sessionFixture(root, {
      models: [{ id: 'gpt-4.1', version: 'other', enabled: true }],
    });
    let calls = 0;
    const report = await runQualification(
      { output, proxyRoot, sessionFile },
      {
        upstreamFetch: async () => {
          calls++;
        },
      },
    );
    assert.equal(report.state, 'failed');
    assert.equal(report.reason, 'configured_model_version_unavailable');
    assert.equal(calls, 0);
    assert.equal(report.requests.upstream.reserved, 0);
    assert.equal(report.cleanup.sessionSnapshotRemoved, true);
    assert.equal(report.cleanup.listenerClosed, true);
  },
);

test(
  'a 403 cannot refresh credentials or replay a completion, and cleanup still closes the proxy',
  { skip: !hasProxy && 'Sibling proxy required for this optional loopback integration check' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run'),
      sessionFile = await sessionFixture(root);
    let calls = 0;
    const report = await runQualification(
      { output, proxyRoot, sessionFile },
      {
        upstreamFetch: async () => {
          calls++;
          return new Response('', { status: 403 });
        },
      },
    );
    assert.equal(report.state, 'failed');
    assert.equal(calls, 1);
    assert.equal(report.requests.upstream.reserved, 1);
    assert.equal(report.requests.upstream.blocked, 1);
    assert.equal(report.cases[0].result.state, 'failed');
    assert.equal(report.cleanup.sessionSnapshotRemoved, true);
    assert.equal(report.cleanup.listenerClosed, true);
    assert.equal(report.cleanup.fetchRestored, true);
  },
);

function rawFindingsSse() {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(clean) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test(
  'failed adapter responses retain typed proxy diagnostics without claiming a semantic failure',
  { skip: !hasProxy && 'Sibling proxy required for this optional loopback integration check' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run'),
      sessionFile = await sessionFixture(root);
    const report = await runQualification(
      { output, proxyRoot, sessionFile },
      { upstreamFetch: async () => rawFindingsSse() },
    );
    assert.equal(report.requests.upstream.started, 1);
    assert.equal(report.cases[0].result.reason, 'http_error');
    assert.equal(report.cases[0].result.provenance.httpStatus, 502);
    assert.equal(report.cases[0].proxyDiagnostic.code, 'invalid_tool_call');
    assert.equal(report.cases[0].proxyDiagnostic.classification, 'required_tool_missing');
    assert.equal(report.cases[0].responseShape.classification, 'direct_findings_json');
    assert.equal(report.cases[0].responseShape.directFindingsSchemaValid, true);
    assert.equal(report.cases[0].responseShape.parser.reason, 'required_tool_missing');
    assert.equal(report.cases[0].checks.semanticEvaluated, false);
    assert.equal(report.reason, 'production_adapter_failed');
    const diagnostic = JSON.parse(
      await readFile(path.join(output, 'case-01-proxy-error.json'), 'utf8'),
    );
    assert.equal(Object.hasOwn(diagnostic, 'message'), false);
    assert.equal(Object.hasOwn(diagnostic, 'body'), false);
    assert.equal(report.cleanup.sessionSnapshotRemoved, true);
  },
);

test(
  'continuation spends only two unattempted cells and preserves the first failure and immutable evidence',
  { skip: !hasProxy && 'Sibling proxy required for this optional loopback integration check' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run'),
      sessionFile = await sessionFixture(root);
    const first = await runQualification(
      { output, proxyRoot, sessionFile },
      { upstreamFetch: async () => rawFindingsSse() },
    );
    assert.equal(
      first.reason,
      'production_adapter_failed',
      JSON.stringify({
        reason: first.reason,
        metadata: first.sourceMetadataFailure,
        requests: first.requests,
        cleanup: first.cleanup,
      }),
    );
    assert.equal(first.cases[0]?.proxyDiagnostic?.classification, 'required_tool_missing');
    assert.equal(first.requests.upstream.started, 1);
    const before = Object.fromEntries(
      await Promise.all(
        (await readdir(output)).map(async (file) => [
          file,
          await readFile(path.join(output, file), 'utf8'),
        ]),
      ),
    );
    let calls = 0;
    const next = await runQualification(
      {
        output: `${output}-continuation`,
        proxyRoot,
        sessionFile,
        continueFrom: path.join(output, 'receipt.json'),
      },
      {
        upstreamFetch: async (_url, init) => {
          const content = JSON.parse(init.body).config.modules.prompt_templating.prompt.template[0]
            .content;
          assert.equal(content.length, calls === 0 ? 3 : 5);
          return sse(
            calls++ === 0 ? clean : issue('Amber Mug', JSON.parse(content[3].text).evidenceId),
          );
        },
      },
    );
    assert.equal(calls, 2);
    assert.equal(next.state, 'partial');
    assert.equal(next.reason, 'prior_qualification_failure');
    assert.deepEqual(
      next.cases.map((cell) => cell.id),
      ['case-02', 'case-03'],
    );
    assert.ok(next.cases.every((cell) => cell.checks.passed));
    assert.equal(next.requests.upstream.reserved, 2);
    assert.equal(next.productionRequestAccounting.priorReserved, 1);
    assert.equal(next.productionRequestAccounting.totalReserved, 3);
    assert.equal(next.remainingRequestBudget, 0);
    assert.deepEqual(next.notAttempted, []);
    assert.equal(next.localControlsReused, true);
    assert.equal(next.cleanup.sessionSnapshotRemoved, true);
    assert.equal(next.cleanup.listenerClosed, true);
    for (const [file, content] of Object.entries(before))
      assert.equal(await readFile(path.join(output, file), 'utf8'), content);
    await assert.rejects(
      runQualification(
        {
          output: path.join(root, 'fork'),
          proxyRoot,
          sessionFile,
          continueFrom: path.join(output, 'receipt.json'),
        },
        {
          upstreamFetch: async () => {
            throw new Error('fork must never dispatch');
          },
        },
      ),
      { code: 'continuation_output_must_be_deterministic' },
    );
    await assert.rejects(
      runQualification(
        {
          output: `${output}-continuation`,
          proxyRoot,
          sessionFile,
          continueFrom: path.join(output, 'receipt.json'),
        },
        {
          upstreamFetch: async () => {
            throw new Error('duplicate must never dispatch');
          },
        },
      ),
      { code: 'EEXIST' },
    );
  },
);

test(
  'continuation refuses unfinished or changed predecessor evidence before loading credentials',
  { skip: !hasProxy && 'Sibling proxy required for this optional loopback integration check' },
  async (t) => {
    const root = await directory(t),
      output = path.join(root, 'run'),
      sessionFile = await sessionFixture(root);
    const first = await runQualification(
      { output, proxyRoot, sessionFile },
      { upstreamFetch: async () => rawFindingsSse() },
    );
    const receiptPath = path.join(output, 'receipt.json');
    const original = await readFile(receiptPath);
    const unfinished = { ...first, finishedAt: undefined };
    await writeFile(receiptPath, JSON.stringify(unfinished));
    const options = {
      output: `${output}-continuation`,
      proxyRoot,
      sessionFile: path.join(root, 'absent-private-session'),
      continueFrom: receiptPath,
    };
    const transport = {
      upstreamFetch: async () => {
        throw new Error('must not dispatch');
      },
    };
    await assert.rejects(runQualification(options, transport), {
      code: 'predecessor_not_reconciled',
    });
    await writeFile(receiptPath, original);
    await writeFile(path.join(output, 'case-01-dispatch.json'), '{}');
    await assert.rejects(runQualification(options, transport), {
      code: 'predecessor_artifact_changed',
    });
  },
);

test(
  'shape-only diagnostics distinguish actual proxy parser inputs without retaining content or arbitrary keys',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const secret = 'never-retain-this-response-value';
    const native = [
      {
        id: secret,
        type: 'function',
        function: { name: 'return_findings', arguments: JSON.stringify(clean) },
      },
    ];
    const examples = [
      {
        classification: 'no_output',
        content: '',
        reason: 'empty_tool_response',
        parserState: 'not_exercised',
      },
      {
        classification: 'prose_or_non_json',
        content: `An ordinary prose answer: ${secret}`,
        reason: 'required_tool_missing',
      },
      {
        classification: 'native_tool_call',
        content: null,
        native,
        reason: 'empty_tool_response',
        parserState: 'not_exercised',
      },
      {
        classification: 'direct_findings_json',
        content: JSON.stringify(clean),
        reason: 'required_tool_missing',
      },
      {
        classification: 'invalid_tool_envelope',
        content: JSON.stringify({
          tool_calls: [{ name: 'return_findings', arguments: [] }],
          [secret]: secret,
        }),
        reason: 'invalid_tool_arguments_type',
      },
      {
        classification: 'valid_tool_envelope',
        content: JSON.stringify({ tool_calls: [{ name: 'return_findings', arguments: clean }] }),
      },
    ];
    for (const example of examples) {
      const wire = Buffer.from(
        `data: ${JSON.stringify({
          [secret]: secret,
          choices: [
            {
              message: {
                role: 'assistant',
                content: example.content,
                ...(example.native ? { tool_calls: example.native } : {}),
              },
              finish_reason: example.native ? 'tool_calls' : 'stop',
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
      let offset = 0;
      const observer = observeUpstreamResponse(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (offset >= wire.length) {
                controller.close();
                return;
              }
              controller.enqueue(wire.subarray(offset, offset + 11));
              offset += 11;
            },
          }),
        ),
      );
      assert.deepEqual(
        Buffer.from(await observer.response.arrayBuffer()),
        wire,
        'observation must not modify proxy-consumed bytes',
      );
      const shape = await inspectUpstreamShape(observer.take(), {
        proxy,
        request,
        fixture,
        validateFindings,
      });
      assert.equal(shape.classification, example.classification, example.classification);
      assert.equal(shape.doneSeen, true);
      assert.equal(shape.aggregation.state, 'completed');
      assert.equal(
        shape.parser.state,
        example.parserState ?? (example.reason ? 'rejected' : 'accepted'),
      );
      if (example.reason) assert.equal(shape.parser.reason, example.reason);
      if (example.classification === 'direct_findings_json')
        assert.equal(shape.directFindingsSchemaValid, true);
      if (example.native) {
        assert.equal(shape.aggregation.nativeCallCount, 1);
        assert.equal(shape.aggregation.nativeCalls[0].expectedNameMatches, true);
      }
      assert.equal(JSON.stringify(shape).includes(secret), false);
      assert.equal(Object.hasOwn(shape.transport, 'bytes'), false);
      assert.deepEqual(shape.frameShapes[0].keys, ['choices']);
      assert.equal(shape.frameShapes[0].otherKeys, 1);
    }
  },
);

test(
  'shape capture bounds memory and forwards bytes even when diagnostics exceed the limit',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const wire = Buffer.alloc(1024 * 1024 + 1, 65);
    const observer = observeUpstreamResponse(new Response(wire));
    assert.deepEqual(Buffer.from(await observer.response.arrayBuffer()), wire);
    const shape = await inspectUpstreamShape(observer.take(), {
      proxy,
      request,
      fixture,
      validateFindings,
    });
    assert.equal(shape.state, 'bounded_out');
    assert.equal(shape.transport.observedBytes, wire.length);
    assert.equal(shape.transport.exceeded, true);
    assert.equal(shape.transport.sha256, null);
    assert.equal(JSON.stringify(shape).includes('AAAA'), false);
  },
);

test('shape observation propagates cancellation without consuming the remaining upstream stream', async () => {
  let cancelled = false,
    pulls = 0;
  const observer = observeUpstreamResponse(
    new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('data: partial\n'));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  const reader = observer.response.body.getReader();
  await reader.read();
  await reader.cancel();
  reader.releaseLock();
  assert.equal(cancelled, true);
  assert.equal(pulls, 1);
  assert.equal(observer.take().cancelled, true);
});

test(
  'diagnostic record exhaustion is not reported as a proxy aggregation failure',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const wire = Buffer.from(
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'.repeat(5000) +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    const observer = observeUpstreamResponse(new Response(wire));
    assert.deepEqual(Buffer.from(await observer.response.arrayBuffer()), wire);
    const shape = await inspectUpstreamShape(observer.take(), {
      proxy,
      request,
      fixture,
      validateFindings,
    });
    assert.equal(shape.state, 'bounded_out');
    assert.equal(shape.reason, 'record_limit');
    assert.equal(shape.aggregation, null);
    assert.equal(shape.parser, null);
  },
);

test(
  'HTTP failure bodies do not exercise the proxy success-path aggregation diagnostic',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const wire = Buffer.from('private upstream error text');
    const observer = observeUpstreamResponse(new Response(wire, { status: 503 }));
    assert.deepEqual(Buffer.from(await observer.response.arrayBuffer()), wire);
    const shape = await inspectUpstreamShape(observer.take(), {
      proxy,
      request,
      fixture,
      validateFindings,
    });
    assert.equal(shape.classification, 'http_error_body');
    assert.equal(shape.state, 'not_applicable');
    assert.equal(shape.aggregation, null);
    assert.equal(shape.parser, null);
    assert.equal(shape.records, 0);
    assert.equal(JSON.stringify(shape).includes('private upstream error text'), false);
  },
);

test(
  'cancelled or failed response prefixes cannot certify final output even with a finish marker',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const prefix = Buffer.from(
      `data: ${JSON.stringify({ choices: [{ message: { content: JSON.stringify(clean) }, finish_reason: 'stop' }] })}\n\n`,
    );
    for (const fail of [false, true]) {
      let read = false;
      const observer = observeUpstreamResponse(
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (!read) {
                  read = true;
                  controller.enqueue(prefix);
                } else if (fail) controller.error(new Error('private transport failure'));
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      );
      const reader = observer.response.body.getReader();
      await reader.read();
      if (fail) await assert.rejects(reader.read(), /private transport failure/);
      else await reader.cancel();
      reader.releaseLock();
      const shape = await inspectUpstreamShape(observer.take(), {
        proxy,
        request,
        fixture,
        validateFindings,
      });
      assert.equal(shape.state, 'partial');
      assert.equal(shape.classification, 'partial_response');
      assert.equal(shape.coverage, fail ? 'transport_error' : 'cancelled');
      assert.equal(shape.parser, null);
      assert.equal(JSON.stringify(shape).includes('private transport failure'), false);
    }
  },
);

test(
  'production DONE cancellation is complete and final empty snapshots clear prior output',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const wire = Buffer.from(
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(clean) } }] })}\n\n` +
        'data: {"choices":[{"message":{"content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    let cancelled = false,
      pulls = 0;
    const observer = observeUpstreamResponse(
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(wire);
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const aggregate = await proxy.aggregateSse(proxy.readSse(observer.response));
    assert.equal(aggregate.text, '');
    assert.equal(cancelled, true);
    assert.equal(pulls, 1);
    const shape = await inspectUpstreamShape(observer.take(), {
      proxy,
      request,
      fixture,
      validateFindings,
    });
    assert.equal(shape.coverage, 'complete');
    assert.equal(shape.classification, 'no_output');
    assert.equal(shape.parser.state, 'not_exercised');
    assert.equal(shape.parser.reason, 'empty_tool_response');
  },
);

test(
  'findings in fences are distinguished from plain text without being accepted as a result tool',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const text = 'Prose around findings.\n```json\n' + JSON.stringify(clean) + '\n```';
    const wire = Buffer.from(
      `data: ${JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    const observer = observeUpstreamResponse(new Response(wire));
    await observer.response.arrayBuffer();
    const shape = await inspectUpstreamShape(observer.take(), {
      proxy,
      request,
      fixture,
      validateFindings,
    });
    assert.equal(shape.classification, 'findings_object_in_text');
    assert.equal(shape.findingsObjectPresent, true);
    assert.equal(shape.findingsObjectSchemaValid, true);
    assert.equal(shape.parser.reason, 'required_tool_missing');
    assert.equal(JSON.stringify(shape).includes(text), false);
  },
);

test(
  'captured SSE error facts survive production cancellation without certifying final output',
  { skip: !hasProxy && 'Sibling proxy required for parser characterization' },
  async () => {
    const proxy = await loadProxy(),
      fixture = fixtures.live[0],
      request = await outgoing(fixture);
    const secret = 'private-error-detail-not-for-retention';
    const errorFrame = Buffer.from(
      `data: ${JSON.stringify({ error: { status: 503, message: secret } })}\n\n`,
    );
    let pulls = 0,
      cancelled = false;
    const observer = observeUpstreamResponse(
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(pulls === 1 ? errorFrame : Buffer.from('data: [DONE]\n\n'));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    await assert.rejects(proxy.aggregateSse(proxy.readSse(observer.response)), {
      code: 'upstream_error',
    });
    assert.equal(cancelled, true);
    assert.equal(pulls, 1);
    const shape = await inspectUpstreamShape(observer.take(), {
      proxy,
      request,
      fixture,
      validateFindings,
    });
    assert.equal(shape.coverage, 'cancelled');
    assert.equal(shape.state, 'partial');
    assert.equal(shape.classification, 'partial_response');
    assert.equal(shape.doneSeen, false);
    assert.equal(shape.parser, null);
    assert.deepEqual(shape.observedErrorFrame, {
      record: 1,
      code: 'upstream_error',
      status: 502,
      upstreamStatus: 503,
      param: null,
      retryable: false,
    });
    assert.equal(JSON.stringify(shape).includes(secret), false);
  },
);

test(
  'final continuation inherits two failures and allows only the third cell with lineage hash checks',
  { skip: !hasProxy && 'Sibling proxy required for loopback continuation' },
  async (t) => {
    const root = await directory(t),
      firstOutput = path.join(root, 'run'),
      sessionFile = await sessionFixture(root);
    const first = await runQualification(
      { output: firstOutput, proxyRoot, sessionFile },
      { upstreamFetch: async () => rawFindingsSse() },
    );
    assert.equal(first.requests.upstream.reserved, 1);
    const secondOutput = `${firstOutput}-continuation`;
    const second = await runQualification(
      {
        output: secondOutput,
        proxyRoot,
        sessionFile,
        continueFrom: path.join(firstOutput, 'receipt.json'),
      },
      { upstreamFetch: async () => rawFindingsSse() },
    );
    assert.equal(second.productionRequestAccounting.totalReserved, 2);
    assert.deepEqual(second.productionRequestAccounting.reservedCaseIds, ['case-01', 'case-02']);
    const secondReceipt = path.join(secondOutput, 'receipt.json');
    const receiptBytes = await readFile(secondReceipt);
    await writeFile(
      secondReceipt,
      JSON.stringify({ ...second, continuation: { ...second.continuation, sha256: 'wrong' } }),
    );
    const finalOptions = {
      output: `${secondOutput}-continuation`,
      proxyRoot,
      sessionFile,
      continueFrom: secondReceipt,
    };
    await assert.rejects(
      runQualification(finalOptions, {
        upstreamFetch: async () => {
          throw new Error('must never dispatch');
        },
      }),
      { code: 'predecessor_lineage_changed' },
    );
    await writeFile(secondReceipt, receiptBytes);
    let calls = 0;
    const final = await runQualification(finalOptions, {
      upstreamFetch: async (_url, init) => {
        calls++;
        const content = JSON.parse(init.body).config.modules.prompt_templating.prompt.template[0]
          .content;
        assert.equal(content.length, 5);
        return sse(issue('Amber Mug', JSON.parse(content[3].text).evidenceId));
      },
    });
    assert.equal(calls, 1);
    assert.equal(final.state, 'partial');
    assert.equal(final.reason, 'prior_qualification_failure');
    assert.deepEqual(
      final.cases.map((cell) => cell.id),
      ['case-03'],
    );
    assert.equal(final.cases[0].checks.passed, true);
    assert.equal(final.cases[0].responseShape.classification, 'valid_tool_envelope');
    assert.equal(final.productionRequestAccounting.totalReserved, 3);
    assert.deepEqual(final.productionRequestAccounting.reservedCaseIds, [
      'case-01',
      'case-02',
      'case-03',
    ]);
    assert.equal(final.remainingRequestBudget, 0);
    assert.equal(final.cleanup.sessionSnapshotRemoved, true);
    assert.equal(final.localControlsReused, true);
    await assert.rejects(
      runQualification(
        {
          ...finalOptions,
          output: `${finalOptions.output}-continuation`,
          continueFrom: path.join(finalOptions.output, 'receipt.json'),
        },
        {
          upstreamFetch: async () => {
            calls++;
          },
        },
      ),
      { code: 'predecessor_dispatch_unaccounted' },
    );
    assert.equal(calls, 1);
  },
);
