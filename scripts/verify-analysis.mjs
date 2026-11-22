import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { PNG } from 'pngjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const exists = file => access(file).then(() => true, () => false);
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const silent = { info() {}, warn() {}, error() {} };
const requireThat = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const safeCode = error => /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'qualification_failed';

export const budget = Object.freeze({ model: 'gpt-4.1', version: '2025-04-14',
  upstreamPosts: 3, postsPerCase: 1, maxOutputTokens: 1536, totalRequestedOutputTokens: 4608,
  requestBytes: 1024 * 1024, idleMs: 45000, attemptMs: 65000, clientMs: 85000, runMs: 270000 });

const glyphs = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
};

function fixturePng(brand) {
  const image = new PNG({ width: 960, height: 640 });
  image.data.fill(255);
  const rect = (x, y, w, h, rgb) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const at = (yy * image.width + xx) * 4;
      image.data[at] = rgb[0]; image.data[at + 1] = rgb[1]; image.data[at + 2] = rgb[2];
    }
  };
  const text = (value, x, y, scale = 3, rgb = [25, 42, 55]) => {
    [...value].forEach((letter, index) => {
      if (letter === ' ') return;
      requireThat(Boolean(glyphs[letter]), 'unsupported_fixture_glyph');
      glyphs[letter].forEach((row, yy) => [...row].forEach((pixel, xx) => {
        if (pixel === '1') rect(x + index * 6 * scale + xx * scale, y + yy * scale, scale, scale, rgb);
      }));
    });
  };
  if (brand !== null) {
    rect(0, 0, 960, 90, [229, 238, 241]);
    text('THE DAILY JOURNAL', 36, 26, 5);
    text('HOME AND FOOD', 40, 123, 3);
    text('WARM DRINKS AT HOME', 40, 181, 4);
    text('A SIMPLE GINGER TEA RECIPE', 40, 234, 3);
    text('SLICE FRESH GINGER', 40, 291);
    text('ADD WATER AND SIMMER', 40, 339);
    text('POUR INTO A CUP', 40, 387);
    text('ENJOY A QUIET MOMENT', 40, 435);
    rect(40, 500, 480, 6, [210, 222, 225]);
    text('RECIPES FROM OUR EDITORS', 40, 535, 3);
    if (brand) {
      rect(580, 160, 348, 346, [255, 228, 193]);
      text('ADVERTISEMENT', 598, 181, 3);
      text(brand.toUpperCase().split(' ')[0], 608, 243, 5);
      text(brand.toUpperCase().split(' ')[1], 608, 296, 5);
      text('SPECIAL OFFER', 608, 359, 3);
      rect(608, 410, 292, 65, [27, 65, 100]);
      text('SHOP NOW', 641, 429, 4, [255, 255, 255]);
    } else {
      rect(580, 160, 348, 346, [230, 242, 229]);
      text('EDITORIAL NOTE', 598, 193, 3);
      text('FRESH GINGER', 608, 272, 3);
      text('HOT WATER', 608, 333, 3);
      text('A WARM CUP', 608, 394, 3);
    }
  }
  return PNG.sync.write(image, { colorType: 2, inputColorType: 6, filterType: 0 });
}

export function buildFixtures({ capturedAt = new Date().toISOString() } = {}) {
  const images = [fixturePng('Cobalt Kettle'), fixturePng(''), fixturePng('Amber Mug'), fixturePng(null)];
  const capture = indexes => ({ schemaVersion: 1, id: randomUUID(), source: 'audit',
    url: 'https://fixture.invalid/article', title: 'Sample journal', capturedAt,
    browser: { name: 'Synthetic PNG fixture', version: '1' }, tab: { id: 0, windowId: 0 },
    images: indexes.map(index => ({ id: randomUUID(), mimeType: 'image/png', width: 960, height: 640,
      dataBase64: images[index].toString('base64') })), text: '',
    context: { pageState: 'usable', sensitivity: 'ordinary', lists: [], blockers: [] },
    limitations: ['Synthetic ordinary capture; no browser, blocker, filter or network activity was measured.'] });
  const first = capture([0]), clean = capture([1]), pair = capture([1, 2]);
  return { images, local: [
    { id: 'local-01', capture: capture([]), reason: 'missing_images' },
    { id: 'local-02', capture: capture([3]), reason: 'blank_images' },
  ], live: [
    { id: 'case-01', capture: first, expected: { assessment: 'observed_issue', brand: 'Cobalt Kettle', imageId: first.images[0].id } },
    { id: 'case-02', capture: clean, expected: { assessment: 'no_issue_observed' } },
    { id: 'case-03', capture: pair, expected: { assessment: 'observed_issue', brand: 'Amber Mug', imageId: pair.images[1].id } },
  ] };
}

export function evaluateCase(fixture, result, validateFindings) {
  if (result.state !== 'accepted') return { passed: false, semanticEvaluated: false,
    schemaRevalidated: false, problems: ['adapter_not_accepted'],
    proseReview: 'No accepted findings were available for semantic assessment.' };
  const problems = [];
  const check = (value, reason) => { if (!value) problems.push(reason); };
  check(result.state === 'accepted', 'not_accepted');
  check(result.provenance?.assessment === fixture.expected.assessment, 'wrong_assessment');
  let valid = false;
  try {
    validateFindings({ schemaVersion: 1, assessment: result.provenance.assessment,
      findings: result.findings, limitations: result.provenance.limitations }, fixture.capture);
    valid = true;
  } catch { problems.push('invalid_production_findings'); }
  if (valid) {
    const positive = fixture.expected.assessment === 'observed_issue';
    check(result.findings.length === (positive ? 1 : 0), 'wrong_finding_count');
    for (const finding of result.findings) {
      check(finding.category === 'missed-ads', 'unexpected_category');
      check(finding.sensitivity === 'ordinary', 'unexpected_sensitivity');
      check(finding.suggestedListIds.length === 0, 'invented_list_attribution');
      check(!finding.evidenceIds.includes('text'), 'unsupplied_text_citation');
      if (positive) {
        check(finding.observation.toLowerCase().replace(/\s+/g, ' ').includes(fixture.expected.brand.toLowerCase()), 'wrong_visual_brand');
        check(finding.evidenceIds.includes(fixture.expected.imageId), 'ad_image_not_cited');
        check(/ad|sponsor|advert/i.test(finding.observation), 'ad_not_identified');
        check(/block|hide|hidden|remove|suppress|filter|prevent|not.*(?:visible|displayed|shown)/i.test(finding.expectedBehavior), 'missing_expected_ad_suppression');
      }
      const prose = [finding.observation, finding.expectedBehavior, ...finding.reproduction].join('\n');
      const inferredBlocking = /\b(?:ad(?:vertisement)?s?\s+(?:was|were|is|are)\s+(?:not\s+)?blocked|without\s+(?:content|ad)[ -]blocking)\b/i.test(prose);
      check(!inferredBlocking && !/(?:we|I)\s+(?:verified|tested|disabled|restored)|(?:blocker|filter|protection)\s+(?:was|has been)\s+(?:disabled|restored)|(?:network|request)\s+(?:log|trace)\s+(?:shows|confirms)/i.test(prose), 'unsupported_experiment_claim');
    }
  }
  return { passed: problems.length === 0, semanticEvaluated: valid, schemaRevalidated: valid, problems,
    proseReview: 'Review retained synthetic observations and reproduction steps for unsupported claims; keyword checks are bounded.' };
}

export async function claimEvidence(output) {
  await mkdir(output);
  const artifacts = [];
  return { artifacts, async write(name, value, binary = false) {
    requireThat(/^[a-z0-9][a-z0-9_.-]*$/.test(name), 'invalid_artifact_name');
    const bytes = binary ? value : jsonBytes(value);
    const file = await open(path.join(output, name), 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const entry = { file: name, sha256: sha256(bytes), bytes: bytes.length };
    artifacts.push(entry);
    return entry;
  } };
}

function inspectContent(content, fixture) {
  const { images, text, ...metadata } = fixture.capture;
  requireThat(Array.isArray(content) && content.length === 1 + images.length * 2, 'content_shape_changed');
  const first = JSON.parse(content[0]?.text ?? 'null');
  requireThat(content[0].type === 'text' && isDeepStrictEqual(first, {
    capture: { ...metadata, images: images.map(({ dataBase64, ...image }) => image) },
    text, evidenceIds: images.map(image => image.id),
  }), 'capture_metadata_changed');
  return images.map((image, index) => {
    const label = content[1 + index * 2], part = content[2 + index * 2];
    requireThat(label?.type === 'text' && isDeepStrictEqual(JSON.parse(label.text), { evidenceId: image.id }), 'image_label_changed');
    requireThat(part?.type === 'image_url' && part.image_url?.url === `data:image/png;base64,${image.dataBase64}`, 'image_bytes_changed');
    const bytes = Buffer.from(image.dataBase64, 'base64');
    return { id: image.id, sha256: sha256(bytes), bytes: bytes.length, width: image.width, height: image.height };
  });
}

export function inspectClientRequest(body, fixture, findingsSchema) {
  requireThat(typeof body === 'string' && Buffer.byteLength(body) <= budget.requestBytes, 'client_request_too_large');
  const request = JSON.parse(body);
  requireThat(request.model === budget.model && request.max_completion_tokens === budget.maxOutputTokens
    && request.stream === false && request.store === false && request.parallel_tool_calls === false
    && !Object.hasOwn(request, 'response_format'), 'client_parameters_changed');
  requireThat(Array.isArray(request.tools) && request.tools.length === 1
    && request.tools[0]?.type === 'function' && request.tools[0].function?.name === 'return_findings'
    && request.tools[0].function.strict === true
    && isDeepStrictEqual(request.tools[0].function.parameters, findingsSchema)
    && isDeepStrictEqual(request.tool_choice, { type: 'function', function: { name: 'return_findings' } }), 'production_schema_changed');
  requireThat(request.messages?.length === 2 && request.messages[0]?.role === 'system'
    && typeof request.messages[0].content === 'string' && request.messages[1]?.role === 'user', 'client_roles_changed');
  const images = inspectContent(request.messages[1].content, fixture);
  return { request, summary: { model: request.model, outputMode: 'tool', tool: 'return_findings',
    schemaSha256: sha256(JSON.stringify(findingsSchema)), promptSha256: sha256(request.messages[0].content),
    requestBytes: Buffer.byteLength(body), maxCompletionTokens: request.max_completion_tokens, images } };
}

async function settleWithin(tasks, ms = 3000) {
  if (!tasks.length) return true;
  let timer;
  try {
    return await Promise.race([Promise.allSettled(tasks).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
}

async function cancelResponse(response) {
  try { await settleWithin([Promise.resolve(response?.body?.cancel())], 1000); } catch {}
}

const diagnosticCodes = new Set(['invalid_tool_call', 'tool_call_truncated', 'tool_protocol_error',
  'upstream_incomplete', 'upstream_error', 'upstream_redirect', 'upstream_idle_timeout',
  'upstream_duration_exceeded', 'request_cancelled', 'upstream_session_expired', 'upstream_rate_limited',
  'unsupported_parameter', 'invalid_parameter', 'unsupported_reasoning_effort', 'upstream_invalid_request',
  'invalid_api_key', 'model_not_available', 'model_chat_unsupported', 'config_error', 'proxy_error']);
const diagnosticParams = new Set(['reasoning_effort', 'max_completion_tokens', 'max_tokens', 'temperature',
  'top_p', 'top_k', 'presence_penalty', 'frequency_penalty', 'seed', 'stop', 'stop_sequences', 'n',
  'tools', 'tool_choice', 'functions', 'function_call', 'response_format']);
const diagnosticMessages = new Map([
  ['a tool call is required', 'required_tool_missing'],
  ['tool invocation must be complete, valid JSON', 'invalid_tool_json'],
  ['tool arguments are missing required properties', 'required_tool_properties_missing'],
  ['tool arguments must be valid JSON', 'invalid_tool_arguments_json'],
  ['tool arguments must be a JSON object', 'invalid_tool_arguments_type'],
  ['tool name is unknown or not allowed by tool_choice', 'unexpected_tool_name'],
  ['upstream tool output did not complete', 'incomplete_tool_finish'],
]);

export async function inspectProxyError(response, signal) {
  const diagnostic = { httpStatus: response.status, code: null, type: null, param: null,
    retryable: null, partialOutput: null, requestedModelMatches: null,
    classification: 'unclassified_proxy_failure', readState: 'unreadable' };
  if (!response.body?.getReader) return diagnostic;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(stop, 2000);
  const reader = response.body.getReader();
  let finished = false, rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  stopped.catch(() => {});
  const onStop = () => rejectStop(Object.assign(new Error('diagnostic_cancelled'), { code: 'diagnostic_cancelled' }));
  controller.signal.addEventListener('abort', onStop, { once: true });
  try {
    const chunks = [];
    let bytes = 0, records = 0;
    while (!finished) {
      requireThat(!controller.signal.aborted, 'diagnostic_cancelled');
      const item = await Promise.race([reader.read(), stopped]);
      if (item.done) { finished = true; break; }
      requireThat(item.value instanceof Uint8Array, 'diagnostic_unreadable');
      bytes += item.value.byteLength;
      requireThat(++records <= 128 && bytes <= 8192, 'diagnostic_too_large');
      chunks.push(Buffer.from(item.value));
    }
    const error = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))?.error;
    requireThat(error && typeof error === 'object' && !Array.isArray(error), 'diagnostic_unreadable');
    diagnostic.code = diagnosticCodes.has(error.code) ? error.code : null;
    diagnostic.type = diagnosticCodes.has(error.type) ? error.type : null;
    diagnostic.param = diagnosticParams.has(error.param) ? error.param : null;
    diagnostic.retryable = typeof error.retryable === 'boolean' ? error.retryable : null;
    diagnostic.partialOutput = typeof error.partial_output === 'boolean' ? error.partial_output : null;
    diagnostic.requestedModelMatches = typeof error.model === 'string' ? error.model === budget.model : null;
    if (diagnostic.code === 'invalid_tool_call') diagnostic.classification = diagnosticMessages.get(error.message) ?? 'tool_envelope_rejected';
    else if (diagnostic.code === 'tool_call_truncated') diagnostic.classification = 'tool_output_truncated';
    else if (diagnostic.code === 'upstream_incomplete') diagnostic.classification = 'upstream_stream_incomplete';
    else if (diagnostic.code === 'upstream_error') diagnostic.classification = 'upstream_failure';
    diagnostic.readState = 'complete';
  } catch (error) {
    diagnostic.readState = error?.code === 'diagnostic_too_large' ? 'too_large'
      : controller.signal.aborted ? 'cancelled' : 'unreadable';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    controller.signal.removeEventListener('abort', onStop);
    if (!finished) {
      try { await settleWithin([Promise.resolve(reader.cancel())], 1000); } catch {}
    }
    reader.releaseLock();
  }
  return diagnostic;
}

const shapeLimits = Object.freeze({ bytes: 1024 * 1024, chunks: 8192, records: 4096, shapes: 64 });
const shapeKeys = new Set(['final_result', 'intermediate_results', 'llm', 'choices', 'message', 'delta',
  'content', 'text', 'output', 'error', 'usage', 'finish_reason', 'role', 'tool_calls', 'tool_call',
  'id', 'index', 'type', 'function', 'name', 'arguments', 'schemaVersion', 'assessment', 'findings',
  'limitations', 'category', 'observation', 'expectedBehavior', 'reproduction', 'evidenceIds',
  'confidence', 'sensitivity', 'suggestedListIds', 'reasoning_content']);

function valueShape(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'string') return { type: 'string', bytes: Buffer.byteLength(value), sha256: sha256(value) };
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return { type: 'object', keys: keys.filter(key => shapeKeys.has(key)).sort(), otherKeys: keys.filter(key => !shapeKeys.has(key)).length };
  }
  return { type: typeof value };
}

function parserFailure(error) {
  const code = diagnosticCodes.has(error?.code) ? error.code : null;
  return { state: 'rejected', code, reason: diagnosticMessages.get(error?.message)
    ?? (code === 'tool_call_truncated' ? 'tool_output_truncated' : 'unclassified_parser_failure') };
}

// Observe only bytes consumed by the actual proxy. The bounded copy is never persisted.
export function observeUpstreamResponse(response) {
  const chunks = [];
  let observedBytes = 0, observedChunks = 0, exceeded = false, ended = false, cancelled = false, readFailed = false;
  const reader = response.body?.getReader();
  let released = false;
  const release = () => { if (!released) { released = true; reader?.releaseLock(); } };
  const body = reader ? new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) { ended = true; release(); controller.close(); return; }
        if (item.value instanceof Uint8Array) {
          observedBytes += item.value.byteLength;
          observedChunks++;
          if (observedBytes > shapeLimits.bytes || observedChunks > shapeLimits.chunks) { exceeded = true; chunks.length = 0; }
          else if (!exceeded) chunks.push(Buffer.from(item.value));
        } else { exceeded = true; chunks.length = 0; }
        controller.enqueue(item.value);
      } catch (error) { readFailed = true; release(); controller.error(error); }
    },
    async cancel(reason) {
      cancelled = true;
      try { await reader.cancel(reason); } finally { release(); }
    },
  }, { highWaterMark: 0 }) : null;
  return {
    response: new Response(body, { status: response.status, headers: response.headers }),
    take() {
      const bytes = exceeded ? null : Buffer.concat(chunks);
      chunks.length = 0;
      return { bytes, httpStatus: response.status, observedBytes, observedChunks, exceeded, ended, cancelled, readFailed };
    },
  };
}

export async function inspectUpstreamShape(observed, { proxy, request, fixture, validateFindings }) {
  const { bytes, ...transport } = observed;
  const summary = { transport: { ...transport, sha256: bytes ? sha256(bytes) : null },
    state: 'unavailable', classification: 'unobserved', coverage: 'unknown', records: 0, doneSeen: false,
    frameShapes: [], candidateShapes: [], shapesOmitted: false, aggregation: null, parser: null };
  if (observed.httpStatus < 200 || observed.httpStatus >= 300) {
    return { ...summary, state: 'not_applicable', classification: 'http_error_body',
      coverage: 'not_applicable', reason: 'success_path_not_exercised' };
  }
  if (!bytes || observed.exceeded) return { ...summary, state: 'bounded_out',
    coverage: 'capped', reason: 'byte_or_chunk_limit' };
  const coverage = () => observed.readFailed ? 'transport_error'
    : summary.doneSeen || observed.ended ? 'complete' : observed.cancelled ? 'cancelled' : 'incomplete';
  const uniqueShapes = new Set();
  const addShape = (list, value) => {
    const key = JSON.stringify(value);
    if (uniqueShapes.has(key)) return;
    if (uniqueShapes.size >= shapeLimits.shapes) { summary.shapesOmitted = true; return; }
    uniqueShapes.add(key); list.push(value);
  };
  const candidatePaths = [...new Set([...proxy.TEXT_CANDIDATES, ...proxy.TOOL_CALL_CANDIDATES])];
  const records = proxy.readSse(new Response(bytes));
  const inspected = (async function* () {
    for await (const raw of records) {
      requireThat(++summary.records <= shapeLimits.records, 'diagnostic_too_many_records');
      if (raw === '[DONE]') summary.doneSeen = true;
      else {
        let payload;
        try { payload = JSON.parse(raw); } catch { payload = raw; }
        const error = proxy.frameError(payload);
        if (error && !summary.observedErrorFrame) {
          const status = value => Number.isInteger(value) && value >= 400 && value <= 599 ? value : null;
          summary.observedErrorFrame = { record: summary.records,
            code: diagnosticCodes.has(error.code) ? error.code : null,
            status: status(error.status), upstreamStatus: status(error.upstreamStatus),
            param: diagnosticParams.has(error.param) ? error.param : null,
            retryable: typeof error.retryable === 'boolean' ? error.retryable : null };
        }
        addShape(summary.frameShapes, valueShape(payload));
        for (const field of candidatePaths) {
          const value = proxy.getPath(payload, field);
          if (value !== undefined) addShape(summary.candidateShapes, { field, ...valueShape(value) });
        }
      }
      yield raw;
    }
  })();
  try {
    const aggregate = await proxy.aggregateSse(inspected);
    summary.coverage = coverage();
    // A captured prefix can contain a finish marker before a later snapshot or error.
    if (summary.coverage !== 'complete') return { ...summary, state: 'partial', classification: 'partial_response' };
    const text = aggregate.text;
    const normalized = proxy.stripProtocolMarkup(text);
    const calls = aggregate.nativeCalls ?? [];
    const finishReasons = new Set(['stop', 'tool_calls', 'length', 'max_tokens', 'content_filter', 'incomplete', 'model_context_window_exceeded']);
    summary.aggregation = { state: 'completed', text: { ...valueShape(text), nonWhitespace: Boolean(text.trim()) },
      normalizedText: { ...valueShape(normalized), nonWhitespace: Boolean(normalized.trim()) },
      finishReason: finishReasons.has(aggregate.finishReason) ? aggregate.finishReason : null,
      truncated: aggregate.truncated === true, reasoningPresent: Boolean(aggregate.reasoning), nativeCallCount: calls.length,
      nativeCalls: calls.slice(0, 4).map(call => ({ type: call.type === 'function' ? 'function' : 'other',
        expectedNameMatches: call.function?.name === 'return_findings', arguments: valueShape(call.function?.arguments) })) };
    let json;
    try { json = JSON.parse(normalized); } catch {}
    summary.json = valueShape(json);
    const findingsObject = value => value && !Array.isArray(value) && typeof value === 'object'
      && ['schemaVersion', 'assessment', 'findings', 'limitations'].every(key => Object.hasOwn(value, key));
    const directFindings = Boolean(findingsObject(json));
    const candidates = proxy.extractJsonObjects(normalized).filter(findingsObject).slice(0, 32);
    summary.findingsObjectPresent = candidates.length > 0;
    summary.findingsObjectSchemaValid = candidates.some(value => {
      try { validateFindings(value, fixture.capture); return true; } catch { return false; }
    });
    if (directFindings) {
      try { validateFindings(json, fixture.capture); summary.directFindingsSchemaValid = true; }
      catch { summary.directFindingsSchemaValid = false; }
    }
    try {
      proxy.assertToolOutputSize(text);
      if (!normalized.trim()) {
        // Native mode is disabled; server.mjs rejects an empty answer before prompt parsing.
        const reasoning = aggregate.usage?.completion_tokens_details?.reasoning_tokens;
        summary.parser = { state: 'not_exercised', reason: 'empty_tool_response',
          code: Number.isFinite(reasoning) && reasoning > 0 ? 'reasoning_budget_exceeded' : 'invalid_tool_call' };
      } else {
        const parsed = proxy.parseToolCalls(text, request.tools, request.tool_choice, { truncated: aggregate.truncated });
        summary.parser = { state: 'accepted', callCount: parsed?.length ?? 0,
          expectedNamesOnly: Boolean(parsed?.length && parsed.every(call => call.function.name === 'return_findings')),
          finishAllowed: ['stop', 'tool_calls'].includes(aggregate.finishReason) };
      }
    } catch (error) { summary.parser = parserFailure(error); }
    const invocation = proxy.looksLikeToolInvocation(text);
    summary.classification = calls.length ? 'native_tool_call'
      : !normalized.trim() ? 'no_output'
      : summary.parser.state === 'accepted' && summary.parser.callCount ? 'valid_tool_envelope'
      : directFindings ? 'direct_findings_json'
      : invocation ? 'invalid_tool_envelope'
      : summary.findingsObjectPresent ? 'findings_object_in_text'
      : json === undefined ? 'prose_or_non_json' : 'other_json';
    summary.state = 'inspected';
  } catch (error) {
    summary.coverage = coverage();
    if (error?.code === 'diagnostic_too_many_records') {
      Object.assign(summary, { state: 'bounded_out', coverage: 'capped', reason: 'record_limit', aggregation: null, parser: null });
    } else if (summary.coverage !== 'complete') {
      Object.assign(summary, { state: 'partial', classification: 'partial_response', parser: null });
    } else {
      summary.state = 'inspected';
      summary.classification = 'aggregation_failed';
      summary.aggregation = parserFailure(error);
    }
  } finally { await records.return(); }
  return summary;
}

export function createUpstreamGuard({ endpoint, remoteFetch, write, signal, priorSpent = [], observeResponse }) {
  requireThat(Array.isArray(priorSpent) && new Set(priorSpent).size === priorSpent.length
    && priorSpent.length <= budget.upstreamPosts
    && priorSpent.every(id => /^case-0[123]$/.test(id)), 'invalid_prior_reservations');
  let current;
  let reservations = 0, started = 0, blocked = 0;
  const cases = new Set(priorSpent);
  const pending = new Set();
  const block = code => { blocked++; requireThat(false, code); };
  return {
    select(fixture, clientRequest) { current = { fixture, clientRequest }; },
    counts() { return { reserved: reservations, started, blocked, pendingHeaders: pending.size }; },
    reservedCaseIds() { return [...cases]; },
    async settle() { return settleWithin([...pending]); },
    async fetch(input, init = {}) {
      const selected = current;
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.href !== endpoint || init.method !== 'POST' || init.redirect !== 'manual') return block('non_completion_operation_blocked');
      if (!selected || signal?.aborted || cases.has(selected.fixture.id)
        || reservations + priorSpent.length >= budget.upstreamPosts) return block('upstream_request_budget_exhausted');
      let summary;
      try {
        requireThat(typeof init.body === 'string' && Buffer.byteLength(init.body) <= budget.requestBytes, 'upstream_request_too_large');
        const payload = JSON.parse(init.body);
        const module = payload.config?.modules?.prompt_templating;
        requireThat(module?.model?.name === budget.model && module.model.version === budget.version
          && module.model.params?.max_completion_tokens === budget.maxOutputTokens, 'upstream_model_or_budget_changed');
        requireThat(!Object.hasOwn(module.model.params, 'n') || module.model.params.n === 1, 'upstream_choice_count_changed');
        requireThat(payload.config.stream?.enabled === true && module.prompt?.tools === undefined
          && module.prompt?.template?.length === 1 && module.prompt.template[0].role === 'user', 'upstream_mode_changed');
        requireThat(payload.messages_history?.length === 2 && payload.messages_history.every(message => message.role === 'system'
          && message.content?.length === 1 && message.content[0].type === 'text'), 'upstream_history_changed');
        requireThat(payload.messages_history[1].content[0].text === selected.clientRequest.messages[0].content
          && payload.messages_history[0].content[0].text.includes('return_findings')
          && payload.messages_history[0].content[0].text.includes(JSON.stringify(selected.clientRequest.tools[0].function.parameters)), 'upstream_instructions_changed');
        const images = inspectContent(module.prompt.template[0].content, selected.fixture);
        summary = { model: module.model.name, version: module.model.version, maxCompletionTokens: module.model.params.max_completion_tokens,
          requestedChoiceCount: module.model.params.n ?? null,
          requestBytes: Buffer.byteLength(init.body), historyRoles: ['system', 'system'],
          historyTextSha256: payload.messages_history.map(message => sha256(message.content[0].text)), images,
          pathname: '/aic/llm/api/v1/completionV2', redirect: 'manual' };
      } catch (error) { return block(safeCode(error)); }
      // Reserve before any await; an interrupted dispatch remains spent and is never replayed.
      cases.add(selected.fixture.id);
      reservations++;
      const ordinal = priorSpent.length + reservations;
      const task = (async () => {
        let response;
        try {
          await write(`${selected.fixture.id}-dispatch.json`, { at: new Date().toISOString(), state: 'reserved_before_send', ordinal, ...summary });
          requireThat(!signal?.aborted && !init.signal?.aborted, 'run_cancelled_before_dispatch');
          started++;
          response = await remoteFetch(input, { ...init, signal: AbortSignal.any([signal, init.signal].filter(Boolean)) });
          await write(`${selected.fixture.id}-upstream-status.json`, { at: new Date().toISOString(), httpStatus: response.status });
          requireThat(!signal?.aborted && !init.signal?.aborted, 'run_cancelled_after_headers');
          if (observeResponse) response = observeResponse(response, selected);
          return response;
        } catch (error) { await cancelResponse(response); throw error; }
      })();
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    },
  };
}

async function sourceState(root, files) {
  const hashes = {};
  for (const file of files) hashes[file] = sha256(await readFile(path.join(root, file)));
  return { root, head: null, dirtyState: null, hashes };
}

async function metadataCommand(root, operation, args, { signal, execFileImpl }) {
  const startedAt = new Date().toISOString(), began = performance.now();
  const controller = new AbortController();
  let child, closed = false, stopReason = null, reply;
  let resolveReply, resolveClose, resolveStop;
  const replied = new Promise(resolve => { resolveReply = resolve; });
  const closure = new Promise(resolve => { resolveClose = resolve; });
  const stopped = new Promise(resolve => { resolveStop = resolve; });
  const stop = reason => {
    if (stopReason) return;
    stopReason = reason;
    controller.abort();
    resolveStop();
  };
  const abort = () => stop('cancelled');
  const timer = setTimeout(() => stop('timeout'), 10000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) stop('cancelled');
    if (!stopReason) {
      try {
        child = execFileImpl('git', args, { cwd: root, encoding: 'utf8', shell: false,
          windowsHide: true, maxBuffer: 1024 * 1024, signal: controller.signal },
        (error, stdout, stderr) => {
          reply = { error, stdout, stderr };
          resolveReply();
        });
        child.once('close', () => { closed = true; resolveClose(); });
        child.stdin?.end();
      } catch (error) {
        reply = { error };
        closed = !child;
        resolveReply();
        if (closed) resolveClose();
      }
      await Promise.race([replied, stopped]);
    } else { closed = true; resolveClose(); }
    // Abort callbacks can precede process termination. Late output must never resume setup.
    const cleanupConfirmed = closed || await settleWithin([closure], 2000);
    const error = reply?.error;
    let outcome = stopReason;
    if (!outcome) {
      outcome = !reply ? 'failed' : !error ? 'completed'
        : error.code === 'ETIMEDOUT' ? 'timeout'
        : error.code === 'ABORT_ERR' ? 'cancelled'
        : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOBUFS' ? 'output_limit'
        : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'spawn_failed'
        : Number.isInteger(error.code) ? 'exited_nonzero'
        : error.signal ? 'terminated' : 'failed';
    }
    if (outcome === 'completed' && !cleanupConfirmed) outcome = 'cleanup_unconfirmed';
    const value = typeof reply?.stdout === 'string' ? reply.stdout.trim() : null;
    if (outcome === 'completed' && (value === null || operation === 'head'
      && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))) outcome = 'invalid_output';
    return { value: outcome === 'completed' ? value : null, evidence: {
      operation, outcome, startedAt, finishedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - began), timeoutMs: 10000, cleanupConfirmed,
      pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
      exitCode: Number.isInteger(error?.code) ? error.code : !error && reply ? 0 : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(error?.signal) ? error.signal : null,
    } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function readRepositoryMetadata(root, { signal, execFileImpl = execFile } = {}) {
  const result = { head: null, dirtyState: null, metadata: {
    source: execFileImpl === execFile ? 'git' : 'injected-offline', state: 'pending', operations: [],
  } };
  for (const [operation, field, args] of [
    ['head', 'head', ['rev-parse', 'HEAD']],
    ['dirty-state', 'dirtyState', ['--no-optional-locks', 'status', '--short']],
  ]) {
    const { value, evidence } = await metadataCommand(root, operation, args, { signal, execFileImpl });
    result.metadata.operations.push(evidence);
    if (evidence.outcome !== 'completed') { result.metadata.state = 'failed'; return result; }
    result[field] = value;
  }
  result.metadata.state = 'completed';
  return result;
}

async function loadPredecessor(receiptFile, output, live, ancestors = new Set()) {
  const file = await realpath(path.resolve(receiptFile));
  const directory = path.dirname(file);
  requireThat(path.basename(file) === 'receipt.json', 'invalid_predecessor_path');
  requireThat(!ancestors.has(file) && ancestors.size < budget.upstreamPosts, 'invalid_predecessor_lineage');
  ancestors.add(file);
  // One deterministic sibling is the exclusive continuation claim; alternate spellings cannot fork it.
  requireThat(path.relative(`${directory}-continuation`, output) === '', 'continuation_output_must_be_deterministic');
  const bytes = await readFile(file);
  const receipt = JSON.parse(bytes);
  requireThat(receipt.finishedAt && receipt.mode === (live ? 'live' : 'offline-transport-double')
    && receipt.cleanup?.listenerClosed === true && receipt.cleanup?.activeLocalResponses === 0
    && receipt.cleanup?.sessionSnapshotRemoved === true && receipt.requests?.upstream?.pendingHeaders === 0
    && receipt.cleanup?.instrumentationSettled !== false && path.relative(receipt.output, directory) === ''
    && !(await exists(path.join(directory, 'session.private.json'))), 'predecessor_not_reconciled');
  requireThat(isDeepStrictEqual(receipt.budget, budget), 'predecessor_budget_changed');
  const previous = receipt.continuation
    ? await loadPredecessor(receipt.continuation.receipt, directory, live, ancestors) : null;
  const earlierSpent = previous?.spent ?? [];
  if (previous) requireThat(receipt.continuation.sha256 === previous.sha256
    && receipt.continuation.runId === previous.receipt.runId
    && isDeepStrictEqual(receipt.continuation.spentCaseIds, earlierSpent), 'predecessor_lineage_changed');
  requireThat(Array.isArray(receipt.artifacts) && receipt.artifacts.length <= 100, 'invalid_predecessor_manifest');
  const artifacts = new Map();
  for (const artifact of receipt.artifacts) {
    requireThat(/^[a-z0-9][a-z0-9_.-]*$/.test(artifact.file) && !artifact.file.includes('private')
      && !artifacts.has(artifact.file), 'invalid_predecessor_manifest');
    const content = await readFile(path.join(directory, artifact.file));
    requireThat(content.length === artifact.bytes && sha256(content) === artifact.sha256, 'predecessor_artifact_changed');
    artifacts.set(artifact.file, content);
  }
  const dispatchFiles = (await readdir(directory)).filter(name => name.endsWith('-dispatch.json')).sort();
  const currentSpent = dispatchFiles.map((name, index) => {
    requireThat(/^case-0[123]-dispatch\.json$/.test(name) && artifacts.has(name), 'predecessor_dispatch_unaccounted');
    const dispatch = JSON.parse(artifacts.get(name));
    requireThat(dispatch.ordinal === earlierSpent.length + index + 1 && dispatch.model === budget.model
      && dispatch.version === budget.version && dispatch.maxCompletionTokens === budget.maxOutputTokens,
    'predecessor_dispatch_unaccounted');
    return name.slice(0, -'-dispatch.json'.length);
  });
  const spent = [...earlierSpent, ...currentSpent];
  requireThat(new Set(spent).size === spent.length && currentSpent.length === receipt.requests.upstream.reserved
    && spent.length < budget.upstreamPosts && Number.isInteger(receipt.requests.upstream.started)
    && receipt.requests.upstream.started >= 0 && receipt.requests.upstream.started <= currentSpent.length,
  'predecessor_dispatch_unaccounted');
  if (previous) requireThat(receipt.productionRequestAccounting?.priorReserved === earlierSpent.length
    && receipt.productionRequestAccounting?.currentReserved === currentSpent.length
    && receipt.productionRequestAccounting?.totalReserved === spent.length
    && isDeepStrictEqual(receipt.productionRequestAccounting?.reservedCaseIds, spent), 'predecessor_dispatch_unaccounted');
  if (previous) for (const name of ['fixtures.json', 'local-controls.json']) requireThat(
    artifacts.get(name)?.equals(previous.artifacts.get(name)), 'predecessor_fixture_lineage_changed');
  const manifest = JSON.parse(artifacts.get('fixtures.json') ?? 'null');
  requireThat(isDeepStrictEqual(manifest?.live?.map(fixture => fixture.id), ['case-01', 'case-02', 'case-03']), 'invalid_predecessor_fixtures');
  const images = ['image-01.png', 'image-02.png', 'image-03.png', 'image-04.png'].map(name => {
    requireThat(artifacts.has(name), 'invalid_predecessor_fixtures');
    return artifacts.get(name);
  });
  const byHash = new Map(images.map(image => [sha256(image), image]));
  const hydrate = fixture => ({ ...fixture, reason: fixture.expected.reason,
    capture: { ...fixture.capture, images: fixture.capture.images.map(({ sha256: hash, bytes: size, ...image }) => {
      const content = byHash.get(hash);
      requireThat(content?.length === size, 'invalid_predecessor_fixtures');
      return { ...image, dataBase64: content.toString('base64') };
    }) } });
  const localControls = JSON.parse(artifacts.get('local-controls.json') ?? 'null');
  requireThat(Array.isArray(localControls) && localControls.length === 2 && localControls.every((control, index) =>
    control.id === `local-0${index + 1}` && control.passed === true && control.result?.state === 'abstained'
    && control.result.reason === ['missing_images', 'blank_images'][index] && control.result.findings.length === 0
    && control.result.provenance.attempts === 0 && control.outboundAdapterFetches === 0
    && control.proxyRequests === 0 && control.upstreamPosts === 0 && control.credentialsLoaded === false),
  'predecessor_local_controls_failed');
  return { file, sha256: sha256(bytes), receipt, spent, localControls, artifacts,
    cases: [...(previous?.cases ?? []), ...receipt.cases],
    fixtures: { images, local: manifest.local.map(hydrate), live: manifest.live.map(hydrate) } };
}

export async function runQualification({ output, proxyRoot, sessionFile, live = false, continueFrom, signal }, { upstreamFetch, metadataExecFile } = {}) {
  requireThat(!(live && metadataExecFile !== undefined), 'live_run_cannot_inject_metadata');
  requireThat(metadataExecFile === undefined || typeof metadataExecFile === 'function', 'invalid_metadata_dependency');
  requireThat(live || typeof upstreamFetch === 'function', 'explicit_live_flag_required');
  requireThat(!(live && upstreamFetch), 'live_run_cannot_inject_provider');
  output = path.resolve(output); proxyRoot = path.resolve(proxyRoot);
  const predecessor = continueFrom ? await loadPredecessor(continueFrom, output, live) : null;
  const priorSpent = predecessor?.spent ?? [];
  const recorder = await claimEvidence(output);
  const write = recorder.write.bind(recorder);
  const snapshot = path.join(output, 'session.private.json');
  const originalFetch = globalThis.fetch;
  const debug = { requests: process.env.SAP_PROXY_DEBUG_REQUESTS, tools: process.env.SAP_PROXY_DEBUG_TOOLS };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, budget.runMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const report = { runId: randomUUID(), startedAt: new Date().toISOString(), pid: process.pid,
    sessionId: /^ses[A-Za-z0-9_-]+$/.test(process.env.OPENCODE_SESSION_ID ?? '') ? process.env.OPENCODE_SESSION_ID : null,
    cwd: process.cwd(), mode: live ? 'live' : 'offline-transport-double', node: process.version, output,
    command: ['node', 'scripts/verify-analysis.mjs', ...(live ? ['--live'] : []), '--proxy-root', proxyRoot, '--output', output,
      ...(predecessor ? ['--continue-from', predecessor.file] : [])],
    ...(predecessor ? { continuation: { receipt: predecessor.file, sha256: predecessor.sha256,
      runId: predecessor.receipt.runId, spentCaseIds: priorSpent } } : {}),
    historicalRequests: 16, budget, cases: [], cleanup: {}, state: 'failed' };
  let originalSession, cfg, server, guard, fixtureSet, analysis, proxy;
  let adapterCalls = 0, proxyRequests = 0;
  const responses = new Set();
  const responseObservers = new Map();
  const appFiles = ['src/analysis.mjs', 'src/capture.mjs', 'package.json', 'package-lock.json', 'scripts/verify-analysis.mjs'];
  const proxyFiles = ['config', 'errors', 'mapper', 'model-notes', 'refresh', 'server', 'tools', 'upstream'].map(name => `src/${name}.mjs`);
  try {
    await write('intent.json', { ...report, authorization: 'Parent-owned initial-delivery ledger: bounded production return_findings qualification.',
      scope: 'Synthetic ordinary fixtures only; no browser changes, catalogue refresh, shared restart or publication.' });
    report.sources = {};
    report.sources.application = await sourceState(project, appFiles);
    report.sources.proxy = await sourceState(proxyRoot, proxyFiles);
    await write('source-hashes.json', report.sources);
    for (const [scope, source] of Object.entries(report.sources)) {
      Object.assign(source, await readRepositoryMetadata(source.root, {
        signal: controller.signal, execFileImpl: metadataExecFile ?? execFile,
      }));
      if (source.metadata.state !== 'completed') {
        report.sourceMetadataFailure = { scope, ...source.metadata.operations.at(-1) };
        await write('source-metadata-failure.json', report.sourceMetadataFailure);
        requireThat(false, `source_metadata_${report.sourceMetadataFailure.outcome}`);
      }
    }
    report.dependencies = {};
    for (const name of ['ajv', 'pngjs']) report.dependencies[name] = JSON.parse(await readFile(path.join(project, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (predecessor) {
      for (const [scope, source] of Object.entries(report.sources)) {
        const previous = predecessor.receipt.sources?.[scope];
        requireThat(previous && path.relative(previous.root, source.root) === '', 'predecessor_source_changed');
        for (const [name, hash] of Object.entries(source.hashes)) {
          if (name.startsWith('src/')) requireThat(previous.hashes[name] === hash, 'predecessor_source_changed');
        }
      }
      requireThat(isDeepStrictEqual(predecessor.receipt.dependencies, report.dependencies), 'predecessor_dependencies_changed');
    }
    await write('sources.json', { ...report.sources, dependencies: report.dependencies });
    analysis = await import('../src/analysis.mjs');
    fixtureSet = predecessor?.fixtures ?? buildFixtures();
    for (const [index, bytes] of fixtureSet.images.entries()) await write(`image-0${index + 1}.png`, bytes, true);
    const fixtureSummary = fixture => ({ id: fixture.id, expected: fixture.expected ?? { state: 'abstained', reason: fixture.reason },
      capture: { ...fixture.capture, images: fixture.capture.images.map(({ dataBase64, ...image }) => ({ ...image,
        sha256: sha256(Buffer.from(dataBase64, 'base64')), bytes: Buffer.from(dataBase64, 'base64').length })) } });
    await write('fixtures.json', { local: fixtureSet.local.map(fixtureSummary), live: fixtureSet.live.map(fixtureSummary),
      semantics: 'One Cobalt Kettle ad; editorial-only; editorial first and one Amber Mug ad second. Answers exist only in pixels and this local oracle.' });
    const local = predecessor?.localControls ?? [];
    for (const fixture of predecessor ? [] : fixtureSet.local) {
      let outbound = 0;
      const result = await analysis.analyzeEvidence(fixture.capture, { baseUrl: 'http://127.0.0.1:1/v1', model: budget.model,
        vision: true, outputMode: 'tool', timeoutMs: budget.clientMs, maxOutputTokens: budget.maxOutputTokens }, {
        signal: controller.signal, fetchImpl: async () => { outbound++; requireThat(false, 'local_control_dispatched'); },
      });
      const passed = result.state === 'abstained' && result.reason === fixture.reason
        && result.findings.length === 0 && result.provenance.attempts === 0 && outbound === 0;
      local.push({ id: fixture.id, result, passed, outboundAdapterFetches: outbound, proxyRequests: 0, upstreamPosts: 0,
        credentialsLoaded: false });
    }
    report.localControls = local;
    report.localControlsReused = Boolean(predecessor);
    await write('local-controls.json', local);
    requireThat(local.every(control => control.passed), 'local_preflight_control_failed');
    requireThat(!controller.signal.aborted, 'run_cancelled_before_session');
    sessionFile = path.resolve(proxyRoot, sessionFile || 'session.json');
    originalSession = await readFile(sessionFile);
    await writeFile(snapshot, originalSession, { mode: 0o600, flag: 'wx' });
    process.env.SAP_PROXY_DEBUG_REQUESTS = '0'; process.env.SAP_PROXY_DEBUG_TOOLS = '0';
    const { ConfigStore, resolveOptions } = await import(pathToFileURL(path.join(proxyRoot, 'src/config.mjs')));
    const { createServer } = await import(pathToFileURL(path.join(proxyRoot, 'src/server.mjs')));
    proxy = Object.assign({}, ...await Promise.all(['mapper', 'tools', 'upstream'].map(name =>
      import(pathToFileURL(path.join(proxyRoot, `src/${name}.mjs`))))));
    const configStore = new ConfigStore(snapshot, { logger: silent });
    cfg = await configStore.load();
    const selected = cfg.models.find(model => model.id === budget.model);
    requireThat(selected?.enabled && (selected.upstreamName || selected.id) === budget.model
      && selected.version === budget.version, 'configured_model_version_unavailable');
    requireThat(Boolean(cfg.cookie) && Boolean(cfg.csrf), 'session_credentials_missing');
    const endpoint = new URL('/aic/llm/api/v1/completionV2', cfg.baseUrl);
    requireThat(endpoint.protocol === 'https:', 'upstream_requires_https');
    endpoint.searchParams.set('workspace', cfg.workspace); endpoint.searchParams.set('resourceGroupId', cfg.resourceGroupId);
    guard = createUpstreamGuard({ endpoint: endpoint.href, remoteFetch: upstreamFetch ?? originalFetch.bind(globalThis),
      write, signal: controller.signal, priorSpent, observeResponse(response, selected) {
        const observer = observeUpstreamResponse(response);
        responseObservers.set(selected.fixture.id, { observer, request: selected.clientRequest });
        return observer.response;
      } });
    globalThis.fetch = guard.fetch;
    const clientKey = randomBytes(32).toString('hex');
    server = createServer({ configStore, logger: silent, options: { ...resolveOptions({}), host: '127.0.0.1', port: 0,
      sessionPath: snapshot, apiKey: clientKey, autoRefresh: false, nativeTools: false, maxRetries: 0, maxConcurrency: 1,
      upstreamTimeoutMs: budget.idleMs, upstreamMaxDurationMs: budget.attemptMs } });
    server.on('request', (request, response) => {
      proxyRequests++;
      responses.add(response);
      const done = () => responses.delete(response);
      response.once('finish', done); response.once('close', done);
    });
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await write('proxy-start.json', { at: new Date().toISOString(), pid: process.pid, baseUrl, autoRefresh: false,
      nativeTools: false, internalRetries: 0, concurrency: 1, model: budget.model, version: budget.version,
      sharedListenerTouched: false, catalogueRefreshed: false });
    let promptHash;
    const remainingCases = fixtureSet.live.filter(fixture => !priorSpent.includes(fixture.id));
    for (const fixture of remainingCases) {
      requireThat(!controller.signal.aborted, 'run_deadline_exceeded');
      for (const name of ['src/analysis.mjs', 'src/capture.mjs']) requireThat(
        sha256(await readFile(path.join(project, name))) === report.sources.application.hashes[name], 'application_source_changed');
      await write(`${fixture.id}-intent.json`, { at: new Date().toISOString(), caseId: fixture.id,
        expected: fixture.expected, remainingUpstreamReservations: budget.upstreamPosts - priorSpent.length - guard.counts().reserved });
      let called = false, proxyDiagnostic = null;
      const result = await analysis.analyzeEvidence(fixture.capture, { baseUrl, apiKey: clientKey, model: budget.model,
        outputMode: 'tool', vision: true, timeoutMs: budget.clientMs, maxOutputTokens: budget.maxOutputTokens }, {
        signal: controller.signal, fetchImpl: async (url, init) => {
          requireThat(url === `${baseUrl}/chat/completions` && init.method === 'POST'
            && init.redirect === 'error' && !called, 'adapter_dispatch_not_allowed');
          const inspected = inspectClientRequest(init.body, fixture, analysis.findingsSchema);
          requireThat(!promptHash || inspected.summary.promptSha256 === promptHash, 'production_prompt_changed');
          promptHash = inspected.summary.promptSha256;
          called = true; adapterCalls++;
          guard.select(fixture, inspected.request);
          await write(`${fixture.id}-adapter-request.json`, { at: new Date().toISOString(), ...inspected.summary });
          const response = await originalFetch(url, init);
          try {
            if (!response.ok) {
              proxyDiagnostic = await inspectProxyError(response, init.signal);
              await write(`${fixture.id}-proxy-error.json`, proxyDiagnostic);
            }
            return response;
          } catch (error) { await cancelResponse(response); throw error; }
        },
      });
      // Provider messages can echo headers in errors; refuse to retain any known secret.
      const encoded = JSON.stringify(result);
      requireThat(![cfg.cookie, cfg.csrf, clientKey].some(secret => secret && encoded.includes(secret)), 'sensitive_response_withheld');
      const checks = evaluateCase(fixture, result, analysis.validateFindings);
      const observed = responseObservers.get(fixture.id);
      let responseShape = null;
      if (observed) {
        responseShape = await inspectUpstreamShape(observed.observer.take(), {
          proxy, request: observed.request, fixture, validateFindings: analysis.validateFindings,
        });
        responseObservers.delete(fixture.id);
        await write(`${fixture.id}-response-shape.json`, responseShape);
      }
      const cell = { id: fixture.id, result, checks, proxyDiagnostic, responseShape, countsAfter: guard.counts() };
      report.cases.push(cell);
      await write(`${fixture.id}-result.json`, cell);
      if (result.state === 'failed' || result.state === 'cancelled' || guard.counts().blocked) break;
    }
    requireThat(!report.cases.some(cell => ['failed', 'cancelled'].includes(cell.result.state)), 'production_adapter_failed');
    requireThat(report.cases.length === remainingCases.length && report.cases.every(cell => cell.checks.passed), 'production_semantic_qualification_failed');
    requireThat(guard.counts().reserved === remainingCases.length && guard.counts().started === remainingCases.length
      && guard.counts().blocked === 0 && adapterCalls === remainingCases.length && proxyRequests === remainingCases.length,
    'dispatch_accounting_mismatch');
    const priorPassed = priorSpent.every(id => predecessor.cases.some(cell => cell.id === id
      && cell.result?.state === 'accepted' && cell.checks?.passed === true));
    report.state = priorPassed ? 'passed' : 'partial';
    if (!priorPassed) report.reason = 'prior_qualification_failure';
  } catch (error) {
    report.reason = safeCode(error);
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    if (server?.listening) {
      try { await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }); }
      catch { report.cleanup.listenerCloseFailed = true; report.state = 'failed'; }
    }
    report.cleanup.instrumentationSettled = guard ? await guard.settle() : true;
    globalThis.fetch = originalFetch;
    for (const [key, value] of [['SAP_PROXY_DEBUG_REQUESTS', debug.requests], ['SAP_PROXY_DEBUG_TOOLS', debug.tools]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    report.cleanup.listenerClosed = !server?.listening;
    report.cleanup.activeLocalResponses = responses.size;
    report.cleanup.fetchRestored = globalThis.fetch === originalFetch;
    report.cleanup.sharedListenerTouched = false;
    report.cleanup.browserRefreshPerformed = false;
    if (originalSession) {
      try { report.cleanup.originalSessionUnchanged = originalSession.equals(await readFile(sessionFile)); }
      catch { report.cleanup.originalSessionUnchanged = null; }
      originalSession.fill(0);
    }
    try { await rm(snapshot, { force: true }); report.cleanup.sessionSnapshotRemoved = !(await exists(snapshot)); }
    catch { report.cleanup.sessionSnapshotRemoved = false; report.state = 'failed'; }
    report.requests = { adapterFetches: adapterCalls, proxyRequests, upstream: guard?.counts() ?? { reserved: 0, started: 0, blocked: 0, pendingHeaders: 0 } };
    const reservedCases = guard?.reservedCaseIds() ?? priorSpent;
    report.productionRequestAccounting = { priorReserved: priorSpent.length, currentReserved: report.requests.upstream.reserved,
      totalReserved: priorSpent.length + report.requests.upstream.reserved, reservedCaseIds: reservedCases,
      requestedOutputTokenAllowance: (priorSpent.length + report.requests.upstream.reserved) * budget.maxOutputTokens };
    report.remainingRequestBudget = budget.upstreamPosts - report.productionRequestAccounting.totalReserved;
    report.notAttempted = ['case-01', 'case-02', 'case-03'].filter(id => !reservedCases.includes(id));
    report.reportedUsage = report.cases.reduce((total, cell) => {
      const usage = cell.result.provenance.usage;
      for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) {
        if (typeof usage?.[key] !== 'number') total.complete = false;
        else total[key] += usage[key];
      }
      return total;
    }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, complete: report.cases.length === report.requests.upstream.started });
    report.coverage = { productionAdapter: 'analyzeEvidence', resultTool: 'return_findings',
      syntheticOnly: true, realPages: false, actualBlockerFailure: false, publicationEligibility: false,
      backendIdentity: 'requested configured route/version, not independent backend attestation',
      billing: 'provider-reported tokens only; input cost and remote cancellation are not capped or verified' };
    if (report.sources) {
      try {
        report.sourceMatchesAfter = {};
        for (const [scope, source] of Object.entries(report.sources)) {
          const matches = {};
          for (const [file, hash] of Object.entries(source.hashes)) matches[file] = sha256(await readFile(path.join(source.root, file))) === hash;
          report.sourceMatchesAfter[scope] = matches;
          if (!Object.values(matches).every(Boolean)) { report.state = 'failed'; report.reason = 'qualification_source_changed'; }
        }
      } catch { report.state = 'failed'; report.reason = 'source_reconciliation_failed'; }
    }
    if (!report.cleanup.listenerClosed || report.cleanup.activeLocalResponses || !report.cleanup.sessionSnapshotRemoved
      || !report.cleanup.instrumentationSettled) report.state = 'failed';
    report.finishedAt = new Date().toISOString();
    report.artifacts = [...recorder.artifacts];
    await write('receipt.json', report);
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean', default: false },
    'proxy-root': { type: 'string' }, output: { type: 'string' }, 'session-file': { type: 'string' },
    'continue-from': { type: 'string' } } });
  requireThat(values.live && values['proxy-root'] && values.output, 'usage_requires_live_proxy_root_and_new_output');
  const relative = path.relative(path.join(tmpdir(), 'opencode'), path.resolve(values.output));
  requireThat(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'output_must_be_in_opencode_temp');
  const result = await runQualification({ live: true, proxyRoot: values['proxy-root'], output: values.output,
    sessionFile: values['session-file'], continueFrom: values['continue-from'] });
  console.log(JSON.stringify({ state: result.state, reason: result.reason, output: result.output, pid: result.pid,
    requests: result.requests, accounting: result.productionRequestAccounting, remainingRequestBudget: result.remainingRequestBudget,
    localControls: result.localControls?.map(({ id, passed }) => ({ id, passed })),
    cases: result.cases.map(cell => ({ id: cell.id, passed: cell.checks.passed, problems: cell.checks.problems })),
    reportedUsage: result.reportedUsage, cleanup: result.cleanup }));
  if (result.state !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ state: 'failed', reason: error?.code === 'EEXIST' ? 'output_already_exists_do_not_replay' : safeCode(error) })); process.exitCode = 1; });
}
