import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  connect,
  capture,
  run,
  state,
  settle,
  deferred,
  findDetail,
} from './helpers/ui-fixtures.mjs';

test('reconnecting authenticates the new token while an old refresh is pending', async (t) => {
  const h = fixture(t);
  await connect(h, state({ captures: [capture()] }));
  h.$('refresh').click();
  const old = h.request('/api/state');
  h.$('disconnect').click();
  h.$('worker-token').value = 'replacement-fixture-token';
  h.submit('connect-form');
  const replacement = h.requests.at(-1);
  assert.notEqual(replacement, old);
  assert.equal(replacement.init.headers.Authorization, 'Bearer replacement-fixture-token');
  assert.equal(h.$('connection-panel').hidden, false);
  assert.equal(h.$('process').disabled, true);
  assert.equal(old.init.signal.aborted, true);
  old.json(state({ captures: [capture({ title: 'Obsolete worker' })] }));
  await settle();
  assert.doesNotMatch(h.$('captures-list').textContent, /Obsolete worker/);
  replacement.json(state({ captures: [capture({ title: 'Replacement worker' })] }));
  await settle();
  assert.equal(h.$('connection-panel').hidden, true);
  assert.equal(h.$('process').disabled, false);
  assert.match(h.$('captures-list').textContent, /Replacement worker/);
});

test('a cancelled connection failure cannot clear a verified replacement session', async (t) => {
  const h = fixture(t);
  h.$('worker-token').value = 'old-fixture-token';
  h.submit('connect-form');
  const old = h.request('/api/state');
  assert.equal(h.$('disconnect').hidden, false, 'Connecting can be cancelled');
  h.$('disconnect').click();
  await connect(h, state(), 'new-fixture-token');
  old.json({ error: { message: 'Old token rejected' } }, 401);
  await settle();
  assert.equal(h.$('connection-panel').hidden, true);
  assert.doesNotMatch(h.$('message').textContent, /Old token/);
  h.$('process').click();
  assert.equal(h.request('/api/process').init.headers.Authorization, 'Bearer new-fixture-token');
});

test('post-mutation refreshes coalesce into one trailing fresh state request', async (t) => {
  const h = fixture(t);
  await connect(h);
  h.$('refresh').click();
  const stale = h.request('/api/state');
  h.$('process').click();
  h.request('/api/process').json({ id: 'op-process', name: 'process', state: 'running' }, 202);
  await settle();
  h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  stale.json(state());
  await settle();
  assert.equal(h.requests.filter((item) => item.path === '/api/state').length, 3);
  h.request('/api/state').json(
    state({
      worker: { processing: true, runId: null },
      operations: [{ id: 'op-process', name: 'process', state: 'running' }],
    }),
  );
  await settle();
  assert.match(h.$('connection-state').textContent, /Processing/);
  assert.ok([...h.timers.values()].some((timer) => timer.ms === 5000));
});

test('late mutation replies cannot write messages or refresh a disconnected page', async (t) => {
  const h = fixture(t);
  await connect(h);
  h.$('process').click();
  const post = h.request('/api/process');
  h.$('disconnect').click();
  post.json({ id: 'old-operation', name: 'process', state: 'running' }, 202);
  await settle();
  assert.equal(h.$('message').hidden, true);
  assert.equal(h.$('connection-state').textContent, 'Worker disconnected');
  assert.equal(h.requests.filter((item) => item.path === '/api/state').length, 1);
});

test('refresh errors retain last data with an explicit stale status and rejected tokens reset it', async (t) => {
  const h = fixture(t);
  await connect(h, state({ captures: [capture({ title: 'Last known observation' })] }));
  h.$('refresh').click();
  h.request('/api/state').fail();
  await settle();
  assert.match(h.$('captures-list').textContent, /Last known observation/);
  assert.match(h.$('connection-state').textContent, /unavailable|stale|last|failed/i);
  assert.equal(h.$('refresh').disabled, false);
  h.$('refresh').click();
  h.request('/api/state').json({ error: { message: 'Token expired' } }, 401);
  await settle();
  assert.equal(h.$('connection-panel').hidden, false);
  assert.equal(h.$('process').disabled, true);
  assert.doesNotMatch(h.$('captures-list').textContent, /Last known observation/);
  assert.equal(h.document.activeElement, h.$('worker-token'));
});

test('analysis transitions preserve an unsaved editor, expansion, selection range and focus', async (t) => {
  const h = fixture(t);
  await connect(h, state({ captures: [capture()], worker: { processing: true, runId: null } }));
  const input = h.$('capture-annotations');
  h.open(input.closest('details'));
  const draft = JSON.stringify(
    { ...JSON.parse(input.value), source: 'Unsaved measured context' },
    null,
    2,
  );
  h.edit(input, draft);
  input.focus();
  input.setSelectionRange(7, 21);
  h.tick();
  h.request('/api/state').json(
    state({
      captures: [capture({ state: 'accepted', analysis: { state: 'accepted', findings: [] } })],
    }),
  );
  await settle();
  assert.equal(h.$('capture-annotations'), input);
  assert.equal(input.value, draft);
  assert.equal(input.closest('details').open, true);
  assert.equal(h.document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [7, 21]);
  assert.match(h.$('capture-inspector').textContent, /accepted/);
  const unload = new h.window.Event('beforeunload', { cancelable: true });
  h.window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
});

test('drafts survive capture selection changes and remote annotation revisions', async (t) => {
  const h = fixture(t);
  const first = capture(),
    second = capture({ id: 'capture_ui_02', title: 'Second capture' });
  await connect(h, state({ captures: [first, second] }));
  const input = h.$('capture-annotations');
  h.edit(input, 'UNSAVED DRAFT');
  h.open(input.closest('details'));
  h.document.querySelector('[data-id="capture_ui_02"]').click();
  h.document.querySelector('[data-id="capture_ui_01"]').click();
  assert.equal(h.$('capture-annotations').value, 'UNSAVED DRAFT');
  h.$('refresh').click();
  h.request('/api/state').json(
    state({
      captures: [
        capture({
          annotations: {
            revision: 'remote-revision',
            source: 'Saved elsewhere',
            observedAt: first.capturedAt,
            context: {},
            images: [],
          },
        }),
        second,
      ],
    }),
  );
  await settle();
  assert.equal(h.$('capture-annotations').value, 'UNSAVED DRAFT');
  assert.match(
    h.$('capture-inspector').textContent,
    /saved.*changed|worker.*changed|newer.*context|context.*changed/i,
  );
});

test('saving context is single-flight and does not overwrite typing made during the save', async (t) => {
  const h = fixture(t);
  await connect(h, state({ captures: [capture()] }));
  const input = h.$('capture-annotations'),
    form = input.closest('form');
  h.open(input.closest('details'));
  const note = {
    source: 'First measurement',
    observedAt: '2026-11-21T16:00:00.000Z',
    context: {},
    images: [],
  };
  h.edit(input, JSON.stringify(note));
  form.requestSubmit();
  form.requestSubmit();
  const post = h.request('/api/captures/capture_ui_01/annotations');
  assert.equal(form.querySelector('[type=submit]').disabled, true);
  const newerDraft = JSON.stringify({ ...note, source: 'New edits during save' });
  h.edit(input, newerDraft);
  post.json({ id: 'capture_ui_01', revision: 'saved-revision' });
  await settle();
  h.request('/api/state').json(
    state({ captures: [capture({ annotations: { ...note, revision: 'saved-revision' } })] }),
  );
  await settle();
  assert.equal(h.$('capture-annotations').value, newerDraft);
  assert.equal(form.querySelector('[type=submit]').disabled, false);
});

test('invalid annotation JSON stays editable and focuses its inline error', async (t) => {
  const h = fixture(t);
  await connect(h, state({ captures: [capture()] }));
  const input = h.$('capture-annotations');
  h.open(input.closest('details'));
  h.edit(input, '{invalid');
  input.closest('form').requestSubmit();
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.document.activeElement, input);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(input.closest('form').textContent, /valid JSON/i);
  assert.equal(input.value, '{invalid');
});

test('refresh updates run counts without detaching focused summaries or closing details', async (t) => {
  const h = fixture(t);
  const running = state({
    captures: [capture()],
    runs: [run()],
    worker: { processing: false, runId: 'run_ui_01' },
  });
  await connect(h, running);
  h.view('runs');
  const details = findDetail(h.$('runs-list'), 'Corpus and comparison');
  h.open(details);
  const summary = details.querySelector('summary');
  summary.focus();
  h.tick();
  h.request('/api/state').json(
    state({ ...running, runs: [run({ counts: { running: 1, pending: 0, completed: 1 } })] }),
  );
  await settle();
  assert.equal(summary.isConnected, true);
  assert.equal(h.document.activeElement, summary);
  assert.equal(details.open, true);
  assert.match(h.$('runs-list').textContent, /1 completed/);
  h.view('captures');
  const row = h.$('captures-list').querySelector('button');
  row.focus();
  h.$('refresh').click();
  h.request('/api/state').json(running);
  await settle();
  assert.equal(row.isConnected, true);
  assert.equal(h.document.activeElement, row);
});

test('per-site outcome requests preserve their summary and refresh an open result after progress', async (t) => {
  const h = fixture(t);
  await connect(h, state({ runs: [run()] }));
  h.view('runs');
  const details = findDetail(h.$('runs-list'), 'Per-site outcomes');
  h.open(details);
  const summary = details.querySelector('summary');
  summary.focus();
  h.request('/api/runs/run_ui_01').json({ entries: [{ id: 'entry_1', state: 'running' }] });
  await settle();
  assert.equal(h.document.activeElement, summary);
  assert.equal(summary.isConnected, true);
  h.$('refresh').click();
  h.request('/api/state').json(
    state({
      runs: [
        run({
          state: 'finished',
          counts: { running: 0, pending: 0, completed: 1 },
          updatedAt: '2026-11-21T16:01:00.000Z',
        }),
      ],
    }),
  );
  await settle();
  h.request('/api/runs/run_ui_01').json({ entries: [{ id: 'entry_1', state: 'completed' }] });
  await settle();
  assert.equal(details.open, true);
  assert.equal(h.document.activeElement, summary);
  assert.match(details.textContent, /completed/);
});

test('catalog and report detail panels retain focus and expansion when their evidence changes', async (t) => {
  const h = fixture(t);
  const catalog = [{ id: 'manual:one', name: 'Official list', source: 'manual', health: null }];
  const reports = [
    {
      id: 'report_1',
      title: 'Report fixture',
      state: 'deferred',
      reasons: ['missing-context'],
      body: 'Original Markdown',
    },
  ];
  await connect(h, state({ catalog, reports }));
  h.view('catalog');
  const listDetail = findDetail(h.$('catalog-list'), 'Inspect source');
  h.open(listDetail);
  h.view('reports');
  const reportDetail = findDetail(h.$('reports-list'), 'Report Markdown');
  h.open(reportDetail);
  const summary = reportDetail.querySelector('summary');
  summary.focus();
  h.$('refresh').click();
  h.request('/api/state').json(
    state({
      catalog: [{ ...catalog[0], health: { delivery: { state: 'unavailable' } } }],
      reports: [{ ...reports[0], body: 'Updated Markdown', state: 'ready' }],
    }),
  );
  await settle();
  assert.equal(reportDetail.open, true);
  assert.equal(listDetail.open, true);
  assert.equal(h.document.activeElement, summary);
  assert.match(reportDetail.textContent, /Updated Markdown/);
  assert.match(listDetail.textContent, /unavailable/);
});

test('corpus submission prevents duplicate native clicks and allows an explicit retry after failure', async (t) => {
  const h = fixture(t);
  await connect(h);
  h.view('runs');
  h.open(h.$('corpus-form').closest('details'));
  h.$('corpus-input').value = 'rank,domain\n1,example.com';
  h.$('corpus-snapshot').value = 'fixed-fixture';
  const submit = h.$('corpus-form').querySelector('[type=submit]');
  submit.click();
  submit.click();
  h.submit('corpus-form');
  const post = h.request('/api/corpora');
  assert.equal(submit.disabled, true);
  post.json({ error: { message: 'Correct the manifest' } }, 400);
  await settle();
  assert.equal(submit.disabled, false);
  assert.equal(h.$('corpus-input').value, 'rank,domain\n1,example.com');
  assert.match(h.$('message').textContent, /Correct the manifest/);
  submit.click();
  assert.equal(h.requests.filter((item) => item.path === '/api/corpora').length, 2);
});

test('terminal operation failures and partial import results replace the started message', async (t) => {
  const h = fixture(t);
  await connect(h);
  h.view('catalog');
  h.$('catalog-source').value = 'ubo';
  h.submit('discover-form');
  h.request('/api/catalog/discover').json(
    { id: 'discover_1', name: 'discover:ubo', state: 'running' },
    202,
  );
  await settle();
  h.request('/api/state').json(
    state({
      operations: [
        {
          id: 'discover_1',
          name: 'discover:ubo',
          state: 'completed',
          result: {
            counts: { complete: false, imported: 0 },
            errors: [{ code: 'source-unavailable', message: 'Source could not be retrieved' }],
          },
        },
      ],
    }),
  );
  await settle();
  assert.match(h.$('operations-list').textContent, /partial|incomplete/i);
  assert.match(h.$('operations-list').textContent, /Source could not be retrieved/);
  assert.doesNotMatch(h.$('message').textContent, /Operation started/);
  h.$('refresh').click();
  h.request('/api/state').json(
    state({
      operations: [
        { id: 'recover_1', name: 'recovery', state: 'failed', reason: 'restore_failed' },
      ],
    }),
  );
  await settle();
  assert.match(h.$('operations-list').textContent, /failed/i);
  assert.match(h.$('operations-list').textContent, /restore.failed/);
});

test('durable catalog import failures remain visible alongside last-known-good lists', async (t) => {
  const h = fixture(t);
  await connect(
    h,
    state({
      catalog: [{ id: 'ubo:old', name: 'Last successful list', source: 'ubo' }],
      catalogImports: [
        {
          source: 'ubo',
          at: '2026-11-21T16:00:00.000Z',
          counts: { complete: false, imported: 0 },
          errors: [{ code: 'download_failed', message: 'Failed to download source' }],
        },
      ],
    }),
  );
  h.view('catalog');
  assert.match(h.$('catalog-list').textContent, /Last successful list/);
  assert.match(h.$('catalog-imports').textContent, /Failed to download source/);
  assert.match(h.$('catalog-imports').textContent, /partial|incomplete/i);
});

test('a conflicting health selection reports the API error and does not claim the other job succeeded', async (t) => {
  const h = fixture(t);
  await connect(h, state({ catalog: [{ id: 'manual:b', name: 'List B', source: 'manual' }] }));
  h.view('catalog');
  [...h.$('catalog-list').querySelectorAll('button')]
    .find((button) => button.textContent.includes('Check'))
    .click();
  const post = h.request('/api/catalog/check');
  assert.equal(JSON.parse(post.init.body).id, 'manual:b');
  post.json(
    {
      error: {
        code: 'operation_busy',
        message: 'Another catalog selection is running. Retry after it finishes.',
      },
    },
    409,
  );
  await settle();
  assert.match(h.$('message').textContent, /Another catalog selection/);
  assert.doesNotMatch(h.$('message').textContent, /updated|completed/i);
});

test('recovery is offered only for an inactive journal and is guarded while restoring', async (t) => {
  const h = fixture(t);
  const journals = [{ name: 'fixture-browser', snapshot: { phase: 'comparison-in-progress' } }];
  await connect(
    h,
    state({ journals, runs: [run()], worker: { processing: false, runId: 'run_ui_01' } }),
  );
  assert.equal(h.$('recovery').hidden, true);
  assert.equal(h.$('recover').disabled, true);
  h.$('refresh').click();
  h.request('/api/state').json(state({ journals }));
  await settle();
  assert.equal(h.$('recovery').hidden, false);
  assert.equal(h.$('recover').disabled, false);
  h.$('recover').click();
  h.$('recover').click();
  h.request('/api/recover').json({ id: 'recover_1', name: 'recovery', state: 'running' }, 202);
  await settle();
  h.request('/api/state').json(
    state({ journals, operations: [{ id: 'recover_1', name: 'recovery', state: 'running' }] }),
  );
  await settle();
  assert.equal(h.$('recover').disabled, true);
  assert.match(h.$('recovery').textContent, /restoring|recovery.*progress/i);
});

test('disconnect clears worker-derived state, drafts, forms, progress and recovery controls', async (t) => {
  const h = fixture(t);
  await connect(
    h,
    state({
      captures: [capture()],
      journals: [{ name: 'fixture-browser', snapshot: {} }],
      events: [{ id: 1, at: '2026-11-21T16:00:00.000Z', message: 'Previous worker event' }],
      operations: [{ id: 'operation_1', name: 'process', state: 'running' }],
    }),
  );
  h.edit(h.$('capture-annotations'), 'Unsaved previous context');
  h.$('corpus-input').value = 'Previous manifest';
  h.$('catalog-search').value = 'Previous search';
  h.$('disconnect').click();
  for (const id of ['capture-count', 'run-count', 'catalog-count', 'report-count'])
    assert.equal(h.$(id).textContent, '0');
  for (const id of ['analysis-mode', 'publication-mode', 'browser-name'])
    assert.equal(h.$(id).textContent, 'Not connected');
  assert.equal(h.$('recovery').hidden, true);
  assert.equal(h.$('recover').disabled, true);
  assert.doesNotMatch(h.$('events-list').textContent, /Previous worker/);
  assert.equal(h.$('corpus-input').value, '');
  assert.equal(h.$('catalog-search').value, '');
  assert.equal(h.timers.size, 0);
  const unload = new h.window.Event('beforeunload', { cancelable: true });
  h.window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, false);
  await connect(h, state({ captures: [capture()] }));
  assert.doesNotMatch(h.$('capture-annotations').value, /Unsaved previous context/);
});

test('history loading uses the opaque cursor and retains older selection and drafts on refresh', async (t) => {
  const h = fixture(t);
  const recent = Array.from({ length: 200 }, (_, index) =>
    capture({ id: `capture_recent_${index}`, title: `Recent ${index}`, state: 'accepted' }),
  );
  const older = Array.from({ length: 100 }, (_, index) =>
    capture({ id: `capture_older_${index}`, title: `Older ${index}`, state: 'accepted' }),
  );
  await connect(
    h,
    state({
      captures: recent,
      totals: { captures: 300, catalog: 0, reports: 0, findings: 0 },
      capturePage: { total: 300, limit: 200, nextCursor: 'opaque+/cursor=' },
    }),
  );
  assert.match(h.$('capture-scope').textContent, /200.*300/);
  h.$('load-older').click();
  h.$('load-older').click();
  const page = h.request(/^\/api\/captures\?/);
  const url = new URL(page.path, 'http://127.0.0.1');
  assert.equal(url.searchParams.get('before'), 'opaque+/cursor=');
  assert.equal(url.searchParams.get('limit'), '200');
  page.json({ captures: older, total: 300, limit: 200, nextCursor: null });
  await settle();
  assert.equal(h.document.querySelectorAll('.capture-select').length, 300);
  assert.match(h.$('capture-scope').textContent, /300.*300/);
  h.document.querySelector('[data-id="capture_older_0"]').click();
  const input = h.$('capture-annotations');
  h.edit(input, 'Older unsaved notes');
  h.$('refresh').click();
  h.request('/api/state').json(
    state({
      captures: [capture({ id: 'capture_new', title: 'New arrival' }), ...recent.slice(0, 199)],
      totals: { captures: 301, catalog: 0, reports: 0, findings: 0 },
      capturePage: { total: 301, limit: 200, nextCursor: 'different-current-frontier' },
    }),
  );
  await settle();
  assert.equal(h.document.querySelectorAll('.capture-select').length, 301);
  assert.equal(h.$('capture-annotations'), input);
  assert.equal(input.value, 'Older unsaved notes');
  assert.match(h.$('capture-inspector').textContent, /Older 0/);
  assert.match(h.$('capture-scope').textContent, /301.*301/);
});

test('overlapping history pages deduplicate rows and do not regress fresher capture state', async (t) => {
  const h = fixture(t);
  await connect(
    h,
    state({
      captures: [capture()],
      totals: { captures: 2, catalog: 0, reports: 0, findings: 0 },
      capturePage: { total: 2, limit: 200, nextCursor: 'older-cursor' },
    }),
  );
  h.$('load-older').click();
  const page = h.request(/^\/api\/captures\?/);
  h.$('refresh').click();
  h.request('/api/state').json(
    state({
      captures: [capture({ state: 'accepted' })],
      totals: { captures: 2, catalog: 0, reports: 0, findings: 0 },
      capturePage: { total: 2, limit: 200, nextCursor: 'older-cursor' },
    }),
  );
  await settle();
  page.json({
    captures: [capture(), capture({ id: 'capture_old_02' })],
    total: 2,
    limit: 200,
    nextCursor: null,
  });
  await settle();
  assert.equal(h.document.querySelectorAll('.capture-select').length, 2);
  assert.match(h.document.querySelector('[data-id="capture_ui_01"]').textContent, /accepted/);
});

test('late history and image replies cannot repopulate disconnected observations', async (t) => {
  const h = fixture(t);
  await connect(
    h,
    state({
      captures: [capture({ images: [{ id: 'viewport', width: 3, height: 2 }] })],
      totals: { captures: 2, catalog: 0, reports: 0, findings: 0 },
      capturePage: { total: 2, limit: 200, nextCursor: 'older' },
    }),
  );
  h.open(findDetail(h.$('capture-inspector'), 'Screenshot evidence'));
  const image = h.request('/api/images/capture_ui_01/viewport');
  h.$('load-older').click();
  const page = h.request(/^\/api\/captures\?/);
  h.$('disconnect').click();
  image.image();
  page.json({
    captures: [capture({ title: 'Late history' })],
    total: 2,
    limit: 200,
    nextCursor: null,
  });
  await settle();
  assert.equal(h.created.length, 0);
  assert.doesNotMatch(h.$('captures-list').textContent, /Late history/);
  assert.equal(h.$('capture-count').textContent, '0');
});

test('file reading cannot replace later edits or restore a manifest after disconnect', async (t) => {
  const h = fixture(t);
  await connect(h);
  const first = deferred();
  Object.defineProperty(h.$('corpus-file'), 'files', {
    configurable: true,
    value: [{ name: 'first.csv', size: 10, text: () => first.promise }],
  });
  h.$('corpus-file').dispatchEvent(new h.window.Event('change'));
  h.edit(h.$('corpus-input'), 'Newer handwritten manifest');
  first.resolve('Old file contents');
  await settle();
  assert.equal(h.$('corpus-input').value, 'Newer handwritten manifest');
  const second = deferred();
  Object.defineProperty(h.$('corpus-file'), 'files', {
    configurable: true,
    value: [{ name: 'second.json', size: 10, text: () => second.promise }],
  });
  h.$('corpus-file').dispatchEvent(new h.window.Event('change'));
  h.$('disconnect').click();
  second.resolve('["late.example.com"]');
  await settle();
  assert.equal(h.$('corpus-input').value, '');
});

test('corpus source and snapshot are optional overrides rather than fabricated provenance', async (t) => {
  const h = fixture(t);
  await connect(h);
  h.view('runs');
  h.open(h.$('corpus-form').closest('details'));
  h.$('corpus-format').value = 'json';
  h.$('corpus-input').value = JSON.stringify({
    source: 'Embedded ranking',
    snapshot: { revision: 'fixed' },
    entries: ['example.com'],
  });
  h.$('corpus-source').value = '';
  h.$('corpus-snapshot').value = '';
  h.submit('corpus-form');
  const post = h.request('/api/corpora');
  const body = JSON.parse(post.init.body);
  assert.equal(Object.hasOwn(body, 'source'), false);
  assert.equal(Object.hasOwn(body, 'snapshot'), false);
  assert.equal(JSON.parse(body.input).source, 'Embedded ranking');
  post.json({ id: 'run_1', corpus: { entries: [], errors: [] } }, 201);
  await settle();
  h.request('/api/state').json(state());
  await settle();
  h.$('corpus-source').value = ' Explicit source ';
  h.$('corpus-snapshot').value = ' Fixed override ';
  h.submit('corpus-form');
  const override = JSON.parse(h.request('/api/corpora').init.body);
  assert.equal(override.source, 'Explicit source');
  assert.equal(override.snapshot, 'Fixed override');
});

test('untrusted capture text stays text and the connection token stays out of browser storage', async (t) => {
  const h = fixture(t);
  await connect(
    h,
    state({
      captures: [
        capture({ title: '<img src=x onerror="globalThis.uiInjection=true">', state: 'accepted' }),
      ],
    }),
  );
  assert.equal(h.$('worker-token').value, '');
  assert.equal(h.window.localStorage.length, 0);
  assert.equal(h.window.sessionStorage.length, 0);
  assert.equal(h.$('capture-inspector').querySelectorAll('img').length, 0);
  assert.match(h.$('capture-inspector').textContent, /<img src=x/);
  assert.equal(h.window.uiInjection, undefined);
});

test('acknowledged corpus creation remains saved when the following state refresh fails', async (t) => {
  const h = fixture(t);
  await connect(h);
  h.view('runs');
  h.open(h.$('corpus-form').closest('details'));
  h.$('corpus-input').value = 'rank,domain\n1,example.com';
  h.submit('corpus-form');
  h.request('/api/corpora').json({ id: 'run_created', corpus: { entries: [], errors: [] } }, 201);
  await settle();
  h.request('/api/state').fail();
  await settle();
  assert.match(h.$('message').textContent, /created/i);
  assert.match(h.$('message').textContent, /refresh|last loaded/i);
  assert.equal(h.$('corpus-form').querySelector('[type=submit]').disabled, false);
  const unload = new h.window.Event('beforeunload', { cancelable: true });
  h.window.dispatchEvent(unload);
  assert.equal(
    unload.defaultPrevented,
    false,
    'The acknowledged manifest is no longer an unsaved draft',
  );
});

test('acknowledged annotation saves do not become save failures when refreshing fails', async (t) => {
  const h = fixture(t);
  await connect(h, state({ captures: [capture()] }));
  const input = h.$('capture-annotations');
  h.open(input.closest('details'));
  const note = {
    source: 'Saved measurement',
    observedAt: '2026-11-21T16:00:00.000Z',
    context: {},
    images: [],
  };
  h.edit(input, JSON.stringify(note));
  input.closest('form').requestSubmit();
  h.request('/api/captures/capture_ui_01/annotations').json({
    id: 'capture_ui_01',
    revision: 'saved_revision',
  });
  await settle();
  h.request('/api/state').fail();
  await settle();
  assert.equal(h.$('annotation-error').hidden, true);
  assert.match(h.$('message').textContent, /saved/i);
  assert.match(h.$('message').textContent, /refresh|last loaded/i);
  assert.equal(input.value, JSON.stringify(note));
});

test('history fills a new capture-window gap in server order without dropping retained history', async (t) => {
  const h = fixture(t);
  const older = Array.from({ length: 200 }, (_, index) =>
    capture({ id: `capture_prior_${index}`, state: 'accepted' }),
  );
  const latest = Array.from({ length: 200 }, (_, index) =>
    capture({ id: `capture_fresh_${index}`, state: 'accepted' }),
  );
  const gap = Array.from({ length: 50 }, (_, index) =>
    capture({ id: `capture_gap_${index}`, state: 'accepted' }),
  );
  await connect(h, state({ captures: older }));
  h.$('refresh').click();
  h.request('/api/state').json(
    state({
      captures: latest,
      totals: { captures: 450, reports: 0, findings: 0, catalog: 0 },
      capturePage: { total: 450, limit: 200, nextCursor: 'fresh-frontier' },
    }),
  );
  await settle();
  h.$('load-older').click();
  h.request(/^\/api\/captures\?/).json({
    captures: [...gap, ...older.slice(0, 150)],
    total: 450,
    limit: 200,
    nextCursor: 'prior-150',
  });
  await settle();
  assert.deepEqual(
    [...h.document.querySelectorAll('.capture-select')].map((button) => button.dataset.id),
    [...latest, ...gap, ...older].map((item) => item.id),
  );
  assert.match(h.$('capture-scope').textContent, /450.*450/);
});

test('an older selected capture refreshes its analysis and annotations without discarding a draft', async (t) => {
  const h = fixture(t);
  const latest = Array.from({ length: 200 }, (_, index) =>
    capture({ id: `capture_current_${index}`, state: 'accepted' }),
  );
  const newestState = state({
    captures: latest,
    totals: { captures: 201, reports: 0, findings: 0, catalog: 0 },
    capturePage: { total: 201, limit: 200, nextCursor: 'older-selected' },
  });
  await connect(h, newestState);
  h.$('load-older').click();
  h.request(/^\/api\/captures\?/).json({
    captures: [capture({ id: 'capture_older_selected', state: 'analyzing' })],
    total: 201,
    limit: 200,
    nextCursor: null,
  });
  await settle();
  h.document.querySelector('[data-id="capture_older_selected"]').click();
  const input = h.$('capture-annotations');
  h.edit(input, 'Retain older draft');
  h.$('refresh').click();
  h.request('/api/state').json(newestState);
  await settle();
  h.request('/api/captures/capture_older_selected').json({
    id: 'capture_older_selected',
    state: 'accepted',
    result: { state: 'accepted', findings: [] },
  });
  h.request('/api/captures/capture_older_selected/annotations').json({
    id: 'capture_older_selected',
    annotations: {
      revision: 'remote_older',
      source: 'Another saved observation',
      observedAt: '2026-11-21T16:01:00.000Z',
      context: {},
      images: [],
    },
  });
  await settle();
  assert.match(h.$('capture-inspector').textContent, /accepted/);
  assert.match(h.$('capture-inspector').textContent, /Another saved observation/);
  assert.equal(h.$('capture-annotations'), input);
  assert.equal(input.value, 'Retain older draft');
});

test('a scheduled browser run does not offer recovery before its active run identifier appears', async (t) => {
  const h = fixture(t);
  await connect(
    h,
    state({
      journals: [{ name: 'fixture-browser', snapshot: {} }],
      operations: [{ id: 'scheduled_run', name: 'run:run_ui_01', state: 'running' }],
    }),
  );
  assert.equal(h.$('recovery').hidden, true);
  assert.equal(h.$('recover').disabled, true);
});
