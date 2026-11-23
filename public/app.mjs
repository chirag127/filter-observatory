const $ = (id) => document.getElementById(id);
let connection = null;
let generation = 0;
let snapshot = null;
let selectedCapture = null;
let activeInspector = null;
let refreshTimer;
let messageOwner = '';
let fileVersion = 0;
let submittedCorpus = '';
let captureOrder = [];
let captureTotal = 0;
let nextCursor = null;
let historyAnchor = null;
let historyVersion = 0;
let captureVersion = 0;
let catalogTable = null;
const captures = new Map();
const runs = new Map();
const catalogRows = new Map();
const reports = new Map();
const operationRows = new Map();
const importRows = new Map();
const downloads = new Map();

const current = (owner) =>
  Boolean(
    owner &&
    owner === connection &&
    owner.generation === generation &&
    !owner.controller.signal.aborted,
  );
const obsolete = () => Object.assign(new Error('This connection has ended.'), { obsolete: true });
const label = (value) => String(value ?? 'unknown').replace(/[-_]/g, ' ');
const json = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function text(node, value) {
  const next = String(value ?? '');
  if (node.textContent !== next) node.textContent = next;
}
function message(value, kind = 'error', owner = '') {
  text($('message'), value);
  $('message').dataset.kind = kind;
  $('message').hidden = !value;
  messageOwner = owner;
}
function timestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString();
}
function updateBadge(node, value) {
  text(node, label(value));
  node.dataset.tone = [
    'accepted',
    'created',
    'appended',
    'completed',
    'reachable',
    'restored',
  ].includes(value)
    ? 'good'
    : ['failed', 'error', 'interrupted'].includes(value)
      ? 'bad'
      : 'warn';
}
function badge(value) {
  const node = element('span', '', 'badge');
  updateBadge(node, value);
  return node;
}
function link(value, urlValue) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return element('span', value);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return element('span', value);
  const node = element('a', value);
  node.href = url.href;
  node.target = '_blank';
  node.rel = 'noreferrer noopener';
  return node;
}
function detail(title, value) {
  const node = element('details');
  node.append(element('summary', title), element('pre', json(value)));
  return node;
}
function updateDetail(node, value) {
  text(node.querySelector('pre'), json(value));
}
function empty(parent, value) {
  parent.replaceChildren(element('p', value, 'empty'));
}
function place(parent, nodes) {
  // Do not reinsert an unchanged node: that drops native focus, selection and details state.
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
  const retained = new Set(nodes);
  for (const node of [...parent.childNodes]) if (!retained.has(node)) node.remove();
}

async function api(path, body, owner = connection, { image = false, signal } = {}) {
  if (!current(owner)) throw obsolete();
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([
      owner.controller.signal,
      AbortSignal.timeout(image ? 15000 : 30000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!current(owner)) throw obsolete();
  if (image && response.ok) {
    const blob = await response.blob();
    if (!current(owner)) throw obsolete();
    return blob;
  }
  const result = await response.json();
  if (!current(owner)) throw obsolete();
  if (!response.ok)
    throw Object.assign(
      new Error(result.error?.message || `Worker returned HTTP ${response.status}.`),
      { status: response.status, code: result.error?.code },
    );
  return result;
}
function showError(error, owner) {
  if (!current(owner) || error.obsolete) return;
  if (error.status === 401) {
    disconnect();
    text($('connection-state'), 'Authentication required');
    message(`${error.message} Connect again with the current worker token.`);
  } else message(error.message);
}
function operationRunning(name) {
  return [...(connection?.operations.values() ?? [])].some(
    (operation) => operation.name === name && operation.state === 'running',
  );
}
function buttonLabel(button, value) {
  button.dataset.text = value;
  text(button, value);
}
function controls() {
  const ready = current(connection) && connection.verified;
  if (snapshot && current(connection)) renderRecovery();
  document.querySelectorAll('[data-needs-connection]').forEach((button) => {
    const busy = connection?.busy.has(button.dataset.task);
    button.disabled = !ready || busy || button.dataset.blocked === 'true';
    if (button.dataset.text) text(button, busy ? 'Working…' : button.dataset.text);
  });
  $('refresh').disabled = !ready || Boolean(connection?.refreshPromise);
  $('connect-form').querySelector('button').disabled = Boolean(connection);
  $('worker-token').disabled = Boolean(connection && !connection.verified);
  $('workspace').setAttribute('aria-busy', String(Boolean(connection?.refreshPromise)));
}
async function guarded(key, callback) {
  const owner = connection;
  if (!current(owner) || !owner.verified || owner.busy.has(key)) return;
  owner.busy.add(key);
  controls();
  try {
    return await callback(owner);
  } catch (error) {
    showError(error, owner);
  } finally {
    if (current(owner)) {
      owner.busy.delete(key);
      controls();
    }
  }
}
function bindButton(button, key, callback) {
  button.dataset.needsConnection = '';
  button.dataset.task = key;
  buttonLabel(button, button.textContent);
  button.addEventListener('click', () => {
    if (!button.disabled) void guarded(key, callback);
  });
  return button;
}
function action(value, key, callback, secondary = false) {
  const button = element('button', value, secondary ? 'secondary' : '');
  button.type = 'button';
  return bindButton(button, key, callback);
}
function bindForm(form, key, callback) {
  const button = form.querySelector('[type=submit]');
  button.dataset.needsConnection = '';
  button.dataset.task = key;
  buttonLabel(button, button.textContent);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void guarded(key, callback);
  });
}
async function operation(path, body = {}, owner = connection) {
  const result = await api(path, body, owner);
  if (!current(owner)) throw obsolete();
  if (result.id && result.name && result.state) {
    owner.operations.set(result.name, result);
    message(
      `${label(result.name)} ${result.state === 'running' ? 'started. Progress appears in Worker operations.' : label(result.state) + '.'}`,
      'info',
      `operation:${result.id}`,
    );
    renderOperations();
  } else
    message(
      path === 'corpora'
        ? 'Run created. Its source and per-site outcomes are recorded below.'
        : 'Worker updated.',
      'info',
    );
  await refreshAfterMutation(owner);
  return result;
}

async function refreshAfterMutation(owner) {
  const acknowledgement = $('message').textContent;
  try {
    await refresh(owner);
  } catch (error) {
    if (!current(owner) || error.obsolete) return;
    if (error.status === 401) showError(error, owner);
    else {
      // A failed readback must not turn an acknowledged write into a retryable failure.
      error.refreshFeedback = true;
      message(
        `${acknowledgement} Refresh failed; showing last loaded observations. ${error.message}`,
        'warning',
        'refresh',
      );
    }
  }
}

function refresh(owner = connection) {
  if (!current(owner)) return Promise.resolve(false);
  if (owner.refreshPromise) {
    owner.refreshQueued = true;
    return owner.refreshPromise;
  }
  const work = (async () => {
    let failure;
    do {
      owner.refreshQueued = false;
      try {
        const value = await api('state', undefined, owner);
        if (!current(owner)) return false;
        if (!owner.refreshQueued) {
          acceptState(value);
          owner.stale = false;
          render();
          await refreshSelectedCapture(owner);
          if (messageOwner === 'refresh') message('');
        }
        failure = null;
      } catch (error) {
        if (!current(owner) || error.obsolete) return false;
        failure = error;
        if (error.status === 401) break;
      }
    } while (current(owner) && owner.refreshQueued);
    if (failure) {
      if (owner.verified) {
        owner.stale = true;
        renderStatus();
      }
      throw failure;
    }
    return true;
  })();
  owner.refreshPromise = work.finally(() => {
    owner.refreshPromise = null;
    if (current(owner)) {
      controls();
      scheduleRefresh();
    }
  });
  controls();
  return owner.refreshPromise;
}
function requestRefresh() {
  const owner = connection;
  if (!current(owner) || !owner.verified) return;
  refresh(owner).catch((error) => {
    if (error.refreshFeedback) return;
    showError(error, owner);
    if (current(owner)) messageOwner = 'refresh';
  });
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const owner = connection;
  if (!current(owner) || !owner.verified || document.hidden) return;
  if (
    snapshot?.worker.processing ||
    snapshot?.worker.runId ||
    [...owner.operations.values()].some((item) => item.state === 'running')
  ) {
    refreshTimer = setTimeout(() => {
      if (current(owner) && !document.hidden) requestRefresh();
    }, 5000);
  }
}
function acceptState(value) {
  const first = !snapshot;
  const overlap = value.captures.some((capture) => captures.has(capture.id));
  const recentIds = new Set(value.captures.map((capture) => capture.id));
  for (const capture of value.captures) rememberCapture(capture);
  captureOrder = [...recentIds, ...captureOrder.filter((id) => !recentIds.has(id))];
  captureTotal = value.capturePage?.total ?? value.totals.captures;
  // A wholly new window may hide a gap above retained history. Start filling at its cursor.
  if (first || (!overlap && value.captures.length)) {
    nextCursor = value.capturePage?.nextCursor ?? null;
    historyAnchor = value.captures.at(-1)?.id ?? null;
    historyVersion++;
  }
  snapshot = value;
  const incoming = new Set((value.operations ?? []).map((item) => item.name));
  for (const [name, old] of connection.operations) {
    if (old.state === 'running' && !incoming.has(name))
      connection.operations.set(name, {
        ...old,
        state: 'unknown',
        reason: 'Worker no longer reports this operation; refresh or inspect worker activity.',
      });
  }
  for (const item of value.operations ?? []) connection.operations.set(item.name, item);
}
async function refreshSelectedCapture(owner) {
  const record = captures.get(selectedCapture);
  if (!owner.verified || !record || snapshot.captures.some((item) => item.id === record.data.id))
    return;
  const version = record.version,
    id = encodeURIComponent(record.data.id);
  const [status, annotations] = await Promise.allSettled([
    api(`captures/${id}`, undefined, owner),
    api(`captures/${id}/annotations`, undefined, owner),
  ]);
  if (!current(owner)) return;
  const failures = [status, annotations]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  const unauthorized = failures.find((error) => error.status === 401);
  if (unauthorized) throw unauthorized;
  if (owner.refreshQueued || captures.get(record.data.id) !== record || record.version !== version)
    return;
  const data = { ...record.data };
  if (status.status === 'fulfilled') {
    data.state = status.value.state;
    data.analysis = status.value.result;
    if (Object.hasOwn(status.value, 'reassessment')) data.reassessment = status.value.reassessment;
  }
  if (annotations.status === 'fulfilled') data.annotations = annotations.value.annotations;
  rememberCapture(data);
  renderCaptures();
  controls();
  if (failures.length) throw failures[0];
}
function rememberCapture(data) {
  let view = captures.get(data.id);
  if (!view) {
    const row = element('article');
    const button = element('button', '', 'capture-select');
    button.type = 'button';
    button.dataset.id = data.id;
    const stateBadge = badge(data.state),
      title = element('strong'),
      host = element('small'),
      time = element('small');
    button.append(stateBadge, title, host, time);
    row.append(button);
    view = { data, row, button, stateBadge, title, host, time, inspector: null };
    button.addEventListener('click', () => selectCapture(data.id));
    captures.set(data.id, view);
  }
  view.data = data;
  view.version = ++captureVersion;
  return view;
}
async function loadOlder(owner) {
  if (!nextCursor) return;
  const cursor = nextCursor,
    anchor = historyAnchor,
    frontier = historyVersion,
    version = captureVersion;
  const query = new URLSearchParams({ limit: '200', before: cursor });
  const page = await api(`captures?${query}`, undefined, owner);
  if (!current(owner)) throw obsolete();
  for (const capture of page.captures) {
    const old = captures.get(capture.id);
    if (!old || old.version <= version) rememberCapture(capture);
  }
  const boundary = captureOrder.indexOf(anchor) + 1;
  const prefix = captureOrder.slice(0, boundary),
    seen = new Set(prefix);
  const pageIds = [];
  for (const capture of page.captures) {
    if (!seen.has(capture.id)) {
      pageIds.push(capture.id);
      seen.add(capture.id);
    }
  }
  captureOrder = [
    ...prefix,
    ...pageIds,
    ...captureOrder.slice(boundary).filter((id) => !seen.has(id)),
  ];
  captureTotal = Math.max(captureTotal, page.total);
  if (frontier === historyVersion) {
    nextCursor = page.nextCursor;
    historyAnchor = pageIds.at(-1) ?? anchor;
  }
  renderCaptures();
  controls();
}

function annotationText(capture) {
  const value = capture.annotations
    ? { ...capture.annotations }
    : {
        source: '',
        observedAt: new Date().toISOString(),
        context: {},
        images: capture.images.map((image) => ({
          id: image.id,
          sensitivity: 'unknown',
          sanitized: false,
          redactions: [],
        })),
      };
  delete value.revision;
  return JSON.stringify(value, null, 2);
}
function releaseImages(view) {
  if (!view) return;
  view.imageGeneration++;
  view.imageController?.abort();
  view.imageController = null;
  for (const url of view.imageUrls) URL.revokeObjectURL(url);
  view.imageUrls = [];
  view.imageLoaded = false;
  view.imageLoading = false;
  view.images.replaceChildren();
}
async function loadImages(view) {
  const owner = connection;
  if (
    !current(owner) ||
    !owner.verified ||
    activeInspector !== view ||
    !view.evidence.open ||
    view.imageLoaded ||
    view.imageLoading
  )
    return;
  view.imageLoading = true;
  view.imageController = new AbortController();
  const version = view.imageGeneration;
  text(view.images, 'Loading local evidence…');
  try {
    const nodes = [];
    for (const image of view.record.data.images) {
      const blob = await api(
        `images/${encodeURIComponent(view.record.data.id)}/${encodeURIComponent(image.id)}`,
        undefined,
        owner,
        { image: true, signal: view.imageController.signal },
      );
      if (!current(owner) || version !== view.imageGeneration || activeInspector !== view) return;
      const url = URL.createObjectURL(blob);
      view.imageUrls.push(url);
      const node = document.createElement('img');
      node.src = url;
      node.alt = `Captured ${image.id} from ${view.record.data.title || view.record.data.url}`;
      node.width = image.width;
      node.height = image.height;
      nodes.push(node);
    }
    if (current(owner) && version === view.imageGeneration) {
      view.images.replaceChildren(
        ...(nodes.length ? nodes : [element('p', 'No screenshot evidence was supplied.')]),
      );
      view.imageLoaded = true;
    }
  } catch (error) {
    if (!current(owner) || version !== view.imageGeneration) return;
    for (const url of view.imageUrls) URL.revokeObjectURL(url);
    view.imageUrls = [];
    const retry = action(
      'Retry image loading',
      `images:${view.record.data.id}`,
      () => loadImages(view),
      true,
    );
    view.images.replaceChildren(element('p', error.message), retry);
    controls();
    if (error.status === 401) showError(error, owner);
  } finally {
    if (version === view.imageGeneration) view.imageLoading = false;
  }
}
function draftStatus(view) {
  const dirty = view.input.value !== view.baseText;
  text(
    view.draftStatus,
    view.conflict
      ? 'Saved context changed on the worker. Your unsaved draft is retained; compare the recorded context before saving.'
      : dirty
        ? 'Unsaved context notes. Draft retained in this page until you save or disconnect.'
        : 'Context notes match the loaded version.',
  );
  view.draftStatus.dataset.dirty = String(dirty || view.conflict);
}
function makeInspector(record) {
  const root = element('div', '', 'inspector-content');
  const heading = element('h3'),
    stateBadge = badge(record.data.state),
    location = element('p', '', 'evidence-url'),
    time = element('p', '', 'form-note');
  location.append(link(record.data.url, record.data.url));
  const evidence = element('details');
  evidence.append(element('summary', `Screenshot evidence (${record.data.images.length})`));
  const images = element('div', '', 'evidence-images');
  evidence.append(images);
  const limitations = element('div');
  const context = detail('Recorded browser and blocker context', {});
  const editor = element('details');
  editor.append(element('summary', 'Add measured context or redaction notes'));
  editor.append(
    element(
      'p',
      'Record observed settings, source and time. Leave unverified prerequisites absent. Redaction boxes use original image pixels; the original capture stays local.',
      'form-note',
    ),
  );
  const form = element('form'),
    input = element('textarea'),
    inputLabel = element('label', 'Context and image notes (JSON)');
  input.id = 'capture-annotations';
  input.name = 'annotations';
  input.rows = 12;
  input.spellcheck = false;
  input.autocomplete = 'off';
  inputLabel.htmlFor = input.id;
  input.value = annotationText(record.data);
  const error = element('p', '', 'inline-error');
  error.id = 'annotation-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const status = element('p', '', 'draft-status form-note');
  status.id = 'annotation-status';
  status.setAttribute('role', 'status');
  input.setAttribute('aria-describedby', 'annotation-error annotation-status');
  const save = element('button', 'Save context');
  save.type = 'submit';
  form.append(inputLabel, input, error, status, save);
  editor.append(form);
  const pageText = detail('Captured page text', ''),
    analysis = detail('Analysis result', {});
  const retry = action('Retry analysis', `retry:${record.data.id}`, (owner) =>
    operation(`captures/${encodeURIComponent(record.data.id)}/retry`, {}, owner),
  );
  root.append(
    heading,
    stateBadge,
    location,
    time,
    evidence,
    limitations,
    context,
    editor,
    pageText,
    analysis,
    retry,
  );
  const view = {
    record,
    root,
    heading,
    stateBadge,
    time,
    evidence,
    images,
    limitations,
    context,
    editor,
    form,
    input,
    error,
    draftStatus: status,
    pageText,
    analysis,
    retry,
    baseText: input.value,
    revision: record.data.annotations?.revision ?? '',
    conflict: false,
    imageGeneration: 0,
    imageUrls: [],
    imageLoaded: false,
    imageLoading: false,
  };
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    draftStatus(view);
  });
  evidence.addEventListener('toggle', () => {
    if (evidence.open) void loadImages(view);
  });
  bindForm(form, `annotations:${record.data.id}`, async (owner) => {
    const submitted = input.value;
    let value;
    try {
      value = JSON.parse(submitted);
    } catch {
      text(
        error,
        'Context notes must be valid JSON. Correct the highlighted field and save again.',
      );
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    try {
      const receipt = await api(
        `captures/${encodeURIComponent(record.data.id)}/annotations`,
        value,
        owner,
      );
      if (!current(owner)) throw obsolete();
      view.baseText = submitted;
      view.revision = receipt.revision;
      view.conflict = false;
      record.data = { ...record.data, annotations: { ...value, revision: receipt.revision } };
      record.version = ++captureVersion;
      error.hidden = true;
      draftStatus(view);
      message(
        input.value === submitted ? 'Context saved.' : 'Context saved. Newer edits remain unsaved.',
        'info',
      );
      await refreshAfterMutation(owner);
    } catch (cause) {
      if (current(owner) && !cause.obsolete && cause.status !== 401) {
        text(error, cause.message);
        error.hidden = false;
        if (cause.status === 400) {
          input.setAttribute('aria-invalid', 'true');
          if (input.isConnected) input.focus();
        }
      }
      throw cause;
    }
  });
  return view;
}
function updateInspector(view) {
  const capture = view.record.data;
  text(view.heading, capture.title || new URL(capture.url).hostname);
  updateBadge(view.stateBadge, capture.state);
  text(view.time, timestamp(capture.capturedAt));
  const notes = capture.limitations ?? [];
  if (JSON.stringify(notes) !== view.limitations.dataset.value) {
    view.limitations.dataset.value = JSON.stringify(notes);
    const list = element('ul');
    notes.forEach((note) => list.append(element('li', note)));
    view.limitations.replaceChildren(element('p', 'Evidence limitations'), list);
    view.limitations.hidden = !notes.length;
  }
  updateDetail(view.context, {
    browser: capture.browser,
    tab: capture.tab,
    ...capture.context,
    ...(capture.annotations ? { annotations: capture.annotations } : {}),
  });
  const revision = capture.annotations?.revision ?? '';
  if (revision !== view.revision) {
    if (view.input.value === view.baseText && !connection.busy.has(`annotations:${capture.id}`)) {
      view.input.value = annotationText(capture);
      view.baseText = view.input.value;
      view.revision = revision;
      view.conflict = false;
    } else view.conflict = true;
  }
  draftStatus(view);
  view.pageText.hidden = !capture.text;
  updateDetail(view.pageText, capture.text ?? '');
  view.analysis.hidden = !capture.analysis;
  updateDetail(view.analysis, capture.analysis ?? {});
  view.retry.hidden = !['failed', 'cancelled', 'interrupted', 'abstained'].includes(capture.state);
}
function selectCapture(id) {
  const record = captures.get(id);
  if (!record || !connection?.verified) return;
  selectedCapture = id;
  record.inspector ??= makeInspector(record);
  if (activeInspector !== record.inspector) {
    releaseImages(activeInspector);
    activeInspector = record.inspector;
    $('capture-inspector').replaceChildren(activeInspector.root);
  }
  updateInspector(activeInspector);
  for (const view of captures.values())
    view.button.setAttribute('aria-pressed', String(view.data.id === id));
  controls();
  if (activeInspector.evidence.open) void loadImages(activeInspector);
}
function renderCaptures() {
  text($('capture-count'), captureTotal);
  text(
    $('capture-scope'),
    `Showing ${captureOrder.length} of ${captureTotal} captures loaded.${captureOrder.length < captureTotal ? ' Load older history to inspect earlier observations.' : ''}`,
  );
  $('load-older').hidden = !nextCursor || captureOrder.length >= captureTotal;
  $('load-older').dataset.blocked = String(!nextCursor || captureOrder.length >= captureTotal);
  if (!captureOrder.length) {
    empty($('captures-list'), 'No captures yet. Use Ctrl+Q in Chrome after pairing the companion.');
    empty($('capture-inspector'), 'Your original screenshot and browser context will appear here.');
    return;
  }
  for (const id of captureOrder) {
    const view = captures.get(id),
      capture = view.data;
    updateBadge(view.stateBadge, capture.state);
    text(view.title, capture.title || capture.url);
    text(view.host, new URL(capture.url).hostname);
    text(view.time, timestamp(capture.capturedAt));
    view.button.setAttribute('aria-pressed', String(id === selectedCapture));
  }
  place(
    $('captures-list'),
    captureOrder.map((id) => captures.get(id).row),
  );
  if (connection.verified) selectCapture(selectedCapture ?? captureOrder[0]);
}

function makeRun(data) {
  const root = element('article', '', 'record'),
    heading = element('div', '', 'record-heading');
  const title = element('h3'),
    stateBadge = badge(data.state),
    description = element('p', '', 'form-note'),
    counts = element('p');
  heading.append(title, stateBadge);
  const settings = detail('Corpus and comparison settings', {}),
    actions = element('div', '', 'actions');
  const start = action('Start remaining sites', `run-start:${data.id}`, (owner) =>
    operation(`runs/${encodeURIComponent(data.id)}/start`, {}, owner),
  );
  const stop = action(
    'Stop run',
    `run-stop:${data.id}`,
    (owner) => operation(`runs/${encodeURIComponent(data.id)}/cancel`, {}, owner),
    true,
  );
  actions.append(start, stop);
  const results = detail('Per-site outcomes', 'Open to load the recorded outcomes.');
  const view = {
    data,
    root,
    title,
    stateBadge,
    description,
    counts,
    settings,
    start,
    stop,
    results,
    version: '',
    resultVersion: null,
    resultTask: null,
  };
  results.addEventListener('toggle', () => {
    if (results.open) void loadRunResults(view);
  });
  root.append(heading, description, counts, settings, actions, results);
  return view;
}
async function loadRunResults(view) {
  const owner = connection;
  if (
    !current(owner) ||
    !owner.verified ||
    !view.results.open ||
    view.resultTask ||
    view.resultVersion === view.version
  )
    return;
  view.resultTask = (async () => {
    try {
      do {
        const version = view.version;
        const value = await api(`runs/${encodeURIComponent(view.data.id)}`, undefined, owner);
        if (!current(owner) || runs.get(view.data.id) !== view) return;
        if (version === view.version) {
          updateDetail(view.results, value.entries);
          view.resultVersion = version;
        }
      } while (current(owner) && view.results.open && view.resultVersion !== view.version);
    } catch (error) {
      if (current(owner)) {
        updateDetail(view.results, `${error.message} Close and reopen to retry.`);
        showError(error, owner);
      }
    } finally {
      view.resultTask = null;
    }
  })();
  await view.resultTask;
}
function renderRuns() {
  const values = snapshot.runs ?? [];
  if (!values.length)
    return empty($('runs-list'), 'Import a CSV or JSON manifest to create your first site run.');
  const nodes = values.map((data) => {
    let view = runs.get(data.id);
    if (!view) {
      view = makeRun(data);
      runs.set(data.id, view);
    }
    view.data = data;
    view.version = JSON.stringify([data.updatedAt, data.state, data.counts]);
    text(view.title, `${data.corpus.source || 'Imported'} site run`);
    updateBadge(view.stateBadge, data.state);
    text(
      view.description,
      `${data.corpus.entries.length} eligible entries; ${data.corpus.errors?.filter((error) => error.excluded).length || 0} excluded inputs.`,
    );
    text(
      view.counts,
      Object.entries(data.counts)
        .filter(([, count]) => count)
        .map(([state, count]) => `${count} ${label(state)}`)
        .join(' · ') || 'No entries',
    );
    updateDetail(view.settings, {
      id: data.id,
      snapshot: data.corpus.snapshot,
      options: data.options,
      errors: data.corpus.errors,
    });
    buttonLabel(view.start, data.state === 'interrupted' ? 'Resume run' : 'Start remaining sites');
    view.start.dataset.blocked = String(
      snapshot.worker.runId === data.id || operationRunning(`run:${data.id}`),
    );
    view.stop.dataset.blocked = String(!data.counts.running && !data.counts.pending);
    if (view.results.open) void loadRunResults(view);
    return view.root;
  });
  place($('runs-list'), nodes);
}
function makeCatalogTable() {
  const wrapper = element('div', '', 'table-wrap'),
    table = element('table'),
    head = element('thead'),
    row = element('tr'),
    body = element('tbody');
  for (const title of ['Official list', 'Source', 'Observed health']) {
    const cell = element('th', title);
    cell.scope = 'col';
    row.append(cell);
  }
  head.append(row);
  table.append(head, body);
  wrapper.append(table);
  return { wrapper, body };
}
function renderCatalog() {
  const query = $('catalog-search').value.toLocaleLowerCase(),
    all = snapshot?.catalog ?? [];
  const filtered = all.filter((record) =>
    [record.name, record.id, record.owner, record.family].some((value) =>
      String(value ?? '')
        .toLocaleLowerCase()
        .includes(query),
    ),
  );
  const values = filtered.slice(0, 250);
  text(
    $('catalog-scope'),
    `Showing ${values.length} of ${filtered.length} matching records (${all.length} loaded). Source variants retain their original names.`,
  );
  if (!values.length)
    return empty(
      $('catalog-list'),
      all.length
        ? 'No lists match this search.'
        : 'Import a catalog to see its official list names and source records.',
    );
  catalogTable ??= makeCatalogTable();
  place($('catalog-list'), [catalogTable.wrapper]);
  place(
    catalogTable.body,
    values.map((record) => {
      let view = catalogRows.get(record.id);
      if (!view) {
        const root = element('tr'),
          name = element('td'),
          sourceCell = element('td'),
          health = element('td');
        const title = element('strong'),
          id = element('small', record.id),
          source = element('span'),
          owner = element('small'),
          stateBadge = badge('not-tested');
        const info = detail('Inspect source and health evidence', {});
        name.append(title, id);
        sourceCell.append(source, owner);
        health.append(
          stateBadge,
          info,
          action(
            'Check this list',
            `health:${record.id}`,
            (session) => operation('catalog/check', { id: record.id }, session),
            true,
          ),
        );
        root.append(name, sourceCell, health);
        view = { root, title, source, owner, stateBadge, info };
        catalogRows.set(record.id, view);
      }
      text(view.title, record.name);
      text(view.source, record.source);
      text(view.owner, record.owner ?? '');
      updateBadge(view.stateBadge, record.health ? 'recorded' : 'not-tested');
      updateDetail(view.info, record);
      return view.root;
    }),
  );
}
function makeReport(data) {
  const root = element('article', '', 'record'),
    heading = element('div', '', 'record-heading'),
    title = element('h3'),
    stateBadge = badge(data.state);
  heading.append(title, stateBadge);
  const destination = element('p', '', 'form-note'),
    reasons = element('ul'),
    markdown = detail('Report Markdown', ''),
    receiptLink = element('p');
  const receipt = detail('Delivery receipt', {}),
    followUp = detail('Upstream follow-up and fix evidence', {});
  const view = {
    data,
    root,
    title,
    stateBadge,
    destination,
    reasons,
    markdown,
    receiptLink,
    receipt,
    followUp,
    receiptUrl: null,
  };
  const save = action(
    'Save Markdown',
    `download:${data.id}`,
    () => {
      const url = URL.createObjectURL(new Blob([view.data.body], { type: 'text/markdown' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `report-${String(data.id).replace(/[^a-z0-9_-]/gi, '')}.md`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      downloads.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url);
          downloads.delete(url);
        }, 1000),
      );
    },
    true,
  );
  view.save = save;
  root.append(heading, destination, reasons, markdown, save, receiptLink, receipt, followUp);
  return view;
}
function renderReports() {
  const values = snapshot.reports ?? [];
  if (!values.length)
    return empty(
      $('reports-list'),
      'No reports prepared yet. Analyze a capture to produce findings and see their reporting requirements.',
    );
  place(
    $('reports-list'),
    values.map((data) => {
      let view = reports.get(data.id);
      if (!view) {
        view = makeReport(data);
        reports.set(data.id, view);
      }
      view.data = data;
      text(view.title, data.title || 'Report pending attribution');
      updateBadge(view.stateBadge, data.state);
      text(
        view.destination,
        data.destination ? `${data.destination.repo} (${label(data.destination.kind)})` : '',
      );
      view.destination.hidden = !data.destination;
      const reasons = data.reasons?.length ? data.reasons : data.reason ? [data.reason] : [];
      if (view.reasons.dataset.value !== JSON.stringify(reasons)) {
        view.reasons.replaceChildren(...reasons.map((reason) => element('li', label(reason))));
        view.reasons.dataset.value = JSON.stringify(reasons);
      }
      view.reasons.hidden = !reasons.length;
      view.markdown.hidden = view.save.hidden = !data.body;
      updateDetail(view.markdown, data.body ?? '');
      if (view.receiptUrl !== data.receipt?.url) {
        view.receiptUrl = data.receipt?.url;
        view.receiptLink.replaceChildren(
          ...(view.receiptUrl ? [link('Open upstream receipt', view.receiptUrl)] : []),
        );
      }
      view.receipt.hidden = !data.receipt;
      updateDetail(view.receipt, data.receipt ?? {});
      view.followUp.hidden = !data.followUp;
      updateDetail(view.followUp, data.followUp ?? {});
      return view.root;
    }),
  );
}

function issues(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((item) => issues(item, depth + 1));
  const found = [];
  if (value.complete === false) found.push('Incomplete source coverage');
  for (const error of value.errors ?? [])
    found.push(typeof error === 'string' ? error : error.message || label(error.code));
  if (
    [
      'failed',
      'error',
      'cancelled',
      'inconclusive',
      'uncertain',
      'deferred',
      'unsupported',
      'disabled',
    ].includes(value.state)
  )
    found.push(`${label(value.state)}${value.reason ? ': ' + label(value.reason) : ''}`);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'errors') continue;
    if (
      ['failed', 'interrupted', 'cancelled', 'inconclusive'].includes(key) &&
      typeof child === 'number' &&
      child > 0
    )
      found.push(`${child} ${label(key)}`);
    else if (child && typeof child === 'object') found.push(...issues(child, depth + 1));
  }
  return [...new Set(found)];
}
function operationOutcome(operation) {
  const notes = issues(operation.result);
  if (operation.reason) notes.unshift(label(operation.reason));
  const state = operation.state === 'completed' && notes.length ? 'partial' : operation.state;
  return {
    state,
    notes,
    title: state === 'partial' ? 'Completed with incomplete results' : label(state),
  };
}
function outcomeRow(title) {
  const root = element('li'),
    heading = element('p'),
    name = element('strong', title),
    stateBadge = badge('unknown'),
    notes = element('ul'),
    details = detail('Outcome evidence', {});
  heading.append(name, document.createTextNode(' '), stateBadge);
  root.append(heading, notes, details);
  return { root, name, stateBadge, notes, details, signature: null };
}
function updateOutcomeRow(view, title, state, notes, evidence) {
  text(view.name, title);
  updateBadge(view.stateBadge, state);
  if (view.notes.dataset.value !== JSON.stringify(notes)) {
    view.notes.replaceChildren(...notes.slice(0, 5).map((note) => element('li', note)));
    view.notes.dataset.value = JSON.stringify(notes);
  }
  view.notes.hidden = !notes.length;
  updateDetail(view.details, evidence);
}
function renderOperations() {
  if (!connection) return;
  const values = [...connection.operations.values()];
  $('operations-panel').hidden = !values.length;
  place(
    $('operations-list'),
    values.map((operation) => {
      let view = operationRows.get(operation.id);
      if (!view) {
        view = outcomeRow(label(operation.name));
        operationRows.set(operation.id, view);
      }
      const outcome = operationOutcome(operation);
      updateOutcomeRow(view, label(operation.name), outcome.state, outcome.notes, operation);
      const signature = JSON.stringify([outcome.state, outcome.notes]);
      if (
        view.signature !== signature &&
        operation.state !== 'running' &&
        (messageOwner === `operation:${operation.id}` || !messageOwner)
      ) {
        message(
          `${label(operation.name)}: ${outcome.title}.${outcome.notes.length ? ' ' + outcome.notes[0] : ''}`,
          outcome.state === 'failed' ? 'error' : outcome.state === 'partial' ? 'warning' : 'info',
          `operation:${operation.id}`,
        );
      }
      view.signature = signature;
      return view.root;
    }),
  );
}
function renderImports() {
  const values = snapshot.catalogImports ?? [];
  place(
    $('catalog-imports'),
    values.map((value) => {
      let view = importRows.get(value.source);
      if (!view) {
        view = outcomeRow(value.source);
        view.root = element('div', '', 'record import-outcome');
        const heading = element('p');
        heading.append(view.name, document.createTextNode(' '), view.stateBadge);
        view.root.append(heading, view.notes, view.details);
        importRows.set(value.source, view);
      }
      const notes = issues(value),
        state = notes.length ? 'partial' : 'completed';
      updateOutcomeRow(
        view,
        `${label(value.source)} import · ${timestamp(value.at)}`,
        state,
        notes,
        value,
      );
      return view.root;
    }),
  );
}
function renderStatus() {
  if (!snapshot || !connection) return;
  text(
    $('connection-state'),
    connection.stale
      ? 'Worker unavailable — showing last loaded observations'
      : snapshot.worker.stopped
        ? 'Worker stopped'
        : snapshot.worker.runId
          ? 'Site run active'
          : snapshot.worker.processing
            ? 'Processing evidence'
            : snapshot.worker.lastError
              ? `Worker error: ${label(snapshot.worker.lastError)}`
              : 'Worker connected',
  );
}
function renderRecovery() {
  const startingRun =
    [...connection.busy].some((key) => key.startsWith('run-start:')) ||
    [...connection.operations.values()].some(
      (item) => item.name.startsWith('run:') && item.state === 'running',
    );
  const inactive = Boolean(snapshot.journals?.length) && !snapshot.worker.runId && !startingRun;
  const restoring = operationRunning('recovery') || connection.busy.has('recovery');
  $('recovery').hidden = !inactive;
  $('recover').dataset.blocked = String(!inactive || restoring);
  text(
    $('recovery-message'),
    restoring
      ? 'Recovery in progress. Restoring and checking the saved blocker state.'
      : 'An inactive comparison needs recovery. Its original blocker state is saved.',
  );
}
function render() {
  text($('catalog-count'), snapshot.totals.catalog);
  text($('report-count'), snapshot.totals.reports);
  text($('run-count'), snapshot.runs.length);
  text(
    $('analysis-mode'),
    snapshot.configuration.providerEnabled
      ? snapshot.configuration.providerModel
      : 'Disabled in configuration',
  );
  text(
    $('publication-mode'),
    snapshot.configuration.publicationEnabled ? 'Automatic eligible reports' : 'Dry-run',
  );
  text($('browser-name'), snapshot.configuration.browser || 'Not configured');
  renderStatus();
  renderCaptures();
  renderRuns();
  renderCatalog();
  renderReports();
  renderOperations();
  renderImports();
  renderRecovery();
  for (const id of ['process', 'refresh-reports'])
    $(id).dataset.blocked = String(operationRunning('process'));
  const events = snapshot.events ?? [];
  $('events-list').replaceChildren(
    ...(events.length
      ? events.map((event) => {
          const item = element('li'),
            time = element('time', timestamp(event.at));
          time.dateTime = event.at;
          item.append(time, element('span', event.message));
          return item;
        })
      : [element('li', 'No recorded activity yet.')]),
  );
  controls();
}
function showView(name) {
  document.querySelectorAll('[data-view]').forEach((button) => {
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
}
function disconnect() {
  connection?.controller.abort();
  connection = null;
  generation++;
  snapshot = null;
  selectedCapture = null;
  clearTimeout(refreshTimer);
  for (const view of captures.values()) releaseImages(view.inspector);
  for (const [url, timer] of downloads) {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
  downloads.clear();
  activeInspector = null;
  captureOrder = [];
  captureTotal = 0;
  nextCursor = null;
  historyAnchor = null;
  historyVersion++;
  captureVersion = 0;
  for (const map of [captures, runs, catalogRows, reports, operationRows, importRows]) map.clear();
  catalogTable = null;
  fileVersion++;
  submittedCorpus = '';
  for (const id of ['connect-form', 'corpus-form', 'discover-form']) $(id).reset();
  $('corpus-input').value = '';
  $('catalog-search').value = '';
  $('worker-token').value = '';
  for (const id of ['capture-count', 'run-count', 'catalog-count', 'report-count'])
    text($(id), '0');
  for (const id of ['analysis-mode', 'publication-mode', 'browser-name'])
    text($(id), 'Not connected');
  for (const id of [
    'captures-list',
    'capture-inspector',
    'runs-list',
    'catalog-list',
    'reports-list',
  ])
    empty($(id), 'Connect to load this worker’s observations.');
  $('operations-list').replaceChildren();
  $('operations-panel').hidden = true;
  $('catalog-imports').replaceChildren();
  $('events-list').replaceChildren(element('li', 'No activity loaded.'));
  text($('capture-scope'), 'Connect to load capture history.');
  text($('catalog-scope'), 'Catalog membership is not proof that a list works in your blocker.');
  $('load-older').hidden = true;
  $('recovery').hidden = true;
  $('recover').dataset.blocked = 'true';
  document.querySelectorAll('details').forEach((node) => {
    node.open = false;
  });
  $('connection-panel').hidden = false;
  $('disconnect').hidden = true;
  text($('disconnect'), 'Disconnect');
  text($('connection-state'), 'Worker disconnected');
  showView('captures');
  controls();
  message('');
  $('worker-token').focus();
}

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connection) return;
  const token = $('worker-token').value.trim();
  if (!token) {
    message('Enter the worker token.');
    $('worker-token').focus();
    return;
  }
  $('worker-token').value = '';
  message('');
  const owner = {
    token,
    generation: ++generation,
    controller: new AbortController(),
    verified: false,
    busy: new Set(),
    operations: new Map(),
    refreshPromise: null,
    refreshQueued: false,
    stale: false,
  };
  connection = owner;
  $('disconnect').hidden = false;
  text($('disconnect'), 'Cancel connection');
  text($('connection-state'), 'Connecting…');
  controls();
  try {
    await refresh(owner);
    if (!current(owner)) return;
    owner.verified = true;
    $('connection-panel').hidden = true;
    text($('disconnect'), 'Disconnect');
    renderCaptures();
    controls();
    scheduleRefresh();
    $('workspace').focus({ preventScroll: true });
  } catch (error) {
    if (!current(owner)) return;
    disconnect();
    text($('connection-state'), 'Connection failed');
    message(error.message);
  }
});
$('disconnect').addEventListener('click', disconnect);
$('refresh').addEventListener('click', requestRefresh);
for (const id of ['process', 'refresh-reports'])
  bindButton($(id), 'process', (owner) => operation('process', {}, owner));
bindButton($('recover'), 'recovery', (owner) => operation('recover', {}, owner));
bindButton($('load-older'), 'history', loadOlder);
bindButton($('check-feeds'), 'catalog-health', (owner) => operation('catalog/check', {}, owner));
document
  .querySelectorAll('[data-view]')
  .forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('corpus-input').addEventListener('input', () => {
  fileVersion++;
});
$('corpus-format').addEventListener('change', () => {
  fileVersion++;
});
$('corpus-file').addEventListener('change', async () => {
  const file = $('corpus-file').files[0];
  if (!file) return;
  const version = ++fileVersion,
    owner = connection,
    epoch = generation;
  if (file.size > 2 * 1024 * 1024) {
    message('Choose a manifest smaller than 2 MiB.');
    return;
  }
  try {
    const value = await file.text();
    if (version !== fileVersion || epoch !== generation || owner !== connection) return;
    $('corpus-input').value = value;
    $('corpus-format').value = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
  } catch (error) {
    if (version === fileVersion && epoch === generation)
      message(`Could not read the manifest: ${error.message}`);
  }
});
function corpusBody() {
  const source = $('corpus-source').value.trim(),
    snapshot = $('corpus-snapshot').value.trim();
  return {
    input: $('corpus-input').value,
    format: $('corpus-format').value,
    compare: $('corpus-compare').checked,
    ...(source ? { source } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}
bindForm($('corpus-form'), 'corpus', async (owner) => {
  const body = corpusBody();
  await operation('corpora', body, owner);
  if (current(owner)) submittedCorpus = JSON.stringify(body);
});
bindForm($('discover-form'), 'discover', (owner) =>
  operation('catalog/discover', { source: $('catalog-source').value }, owner),
);
$('catalog-search').addEventListener('input', () => {
  if (snapshot) {
    renderCatalog();
    controls();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestRefresh();
  else clearTimeout(refreshTimer);
});
window.addEventListener('beforeunload', (event) => {
  const annotationDraft = [...captures.values()].some(
    (record) => record.inspector && record.inspector.input.value !== record.inspector.baseText,
  );
  const corpusDraft = $('corpus-input').value && JSON.stringify(corpusBody()) !== submittedCorpus;
  if (annotationDraft || corpusDraft) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('pagehide', () => {
  for (const view of captures.values()) releaseImages(view.inspector);
});
window.addEventListener('pageshow', () => {
  if (activeInspector?.evidence.open) void loadImages(activeInspector);
});
