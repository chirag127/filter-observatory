import type {
  CompanionStatus,
  ConnectionSettings,
  UiReply,
  UiRequest,
} from '../utils/contracts.ts';
import { button, contactFooter, createStatusView, element } from './view.ts';

export type RequestClient = (request: UiRequest) => Promise<UiReply>;

export interface MountedUi {
  ready: Promise<void>;
  refresh(): Promise<void>;
  whenIdle(): Promise<void>;
  destroy(): void;
}

const defaultEndpoint = 'http://127.0.0.1:4317';
const endpointHelp =
  'Use http://127.0.0.1 or http://localhost with the worker’s port. No paths, credentials, query strings or fragments.';

function readEndpoint(value: string): string | undefined {
  const match = /^http:\/\/(127\.0\.0\.1|localhost)(?::([1-9][0-9]{0,4}))?\/?$/.exec(value.trim());
  if (!match) return undefined;
  if (match[2] !== undefined && (Number(match[2]) < 1024 || Number(match[2]) > 65535))
    return undefined;
  return value.trim().replace(/\/$/, '');
}

function settingsForm(document: Document) {
  const form = element(document, 'form', 'connection-form');
  form.noValidate = true;
  form.setAttribute('aria-labelledby', 'settings-heading');
  const title = element(document, 'h2', '', 'Connection on this device');
  title.id = 'settings-heading';
  form.append(
    title,
    element(
      document,
      'p',
      'detail',
      'Connect this browser to the local Filter Observatory worker.',
    ),
  );

  const endpointLabel = element(document, 'label', '', 'Local worker address');
  endpointLabel.htmlFor = 'endpoint';
  const endpoint = element(document, 'input');
  endpoint.id = 'endpoint';
  endpoint.name = 'endpoint';
  endpoint.type = 'url';
  endpoint.required = true;
  endpoint.value = defaultEndpoint;
  endpoint.autocomplete = 'off';
  endpoint.spellcheck = false;
  endpoint.setAttribute('autocapitalize', 'none');
  endpoint.setAttribute('aria-describedby', 'endpoint-hint endpoint-error');
  const endpointHint = element(document, 'p', 'field-hint', endpointHelp);
  endpointHint.id = 'endpoint-hint';
  const endpointError = element(document, 'p', 'field-error');
  endpointError.id = 'endpoint-error';
  endpointError.hidden = true;
  endpointError.setAttribute('role', 'alert');

  const tokenLabel = element(document, 'label', '', 'Worker token');
  tokenLabel.htmlFor = 'token';
  const token = element(document, 'input');
  token.id = 'token';
  token.name = 'token';
  token.type = 'password';
  token.autocomplete = 'off';
  token.spellcheck = false;
  token.setAttribute('autocapitalize', 'none');
  token.setAttribute('aria-describedby', 'token-hint');
  const tokenHint = element(
    document,
    'p',
    'field-hint',
    'Stored in this extension’s local storage, never synced. Leave blank to disconnect. Provider credentials stay in the worker.',
  );
  tokenHint.id = 'token-hint';
  const save = button(document, 'Save connection', 'button button--primary');
  save.type = 'submit';
  const reload = button(document, 'Reload settings', 'button button--quiet');
  reload.hidden = true;
  const dirtyHint = element(
    document,
    'p',
    'field-hint',
    'Save changes before checking the connection or retrying delivery.',
  );
  dirtyHint.hidden = true;
  const actions = element(document, 'div', 'actions');
  actions.append(save, reload);
  form.append(
    endpointLabel,
    endpoint,
    endpointHint,
    endpointError,
    tokenLabel,
    token,
    tokenHint,
    actions,
    dirtyHint,
  );
  return { form, endpoint, token, endpointError, save, reload, dirtyHint };
}

function mount(
  root: HTMLElement,
  request: RequestClient,
  mode: 'popup' | 'options',
  openOptions?: () => Promise<void>,
): MountedUi {
  const document = root.ownerDocument;
  const cleanup: Array<() => void> = [];
  const page = element(document, 'div', `page page--${mode}`);
  const header = element(document, 'header', 'masthead');
  if (mode === 'options')
    header.append(element(document, 'p', 'product-name', 'Filter Observatory'));
  header.append(
    element(document, 'h1', '', mode === 'popup' ? 'Filter Observatory' : 'Connection settings'),
  );
  if (mode === 'popup') header.append(element(document, 'p', 'subtitle', 'Browser companion'));
  const main = element(document, 'main', 'content');
  const feedback = element(document, 'p', 'operation-status');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  feedback.setAttribute('aria-atomic', 'true');
  const error = element(document, 'p', 'operation-error');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const workspace = element(document, 'div', 'workspace');
  const form = mode === 'options' ? settingsForm(document) : undefined;
  const status = createStatusView(document, mode);
  if (form) workspace.append(form.form);
  const statusColumn = element(document, 'div', 'status-column');
  const actions = element(document, 'div', 'actions status-actions');
  const check = button(document, 'Check connection');
  const retry = button(document, 'Retry pending');
  const refresh = button(document, 'Refresh status', 'button button--quiet');
  actions.append(check, retry, refresh);
  statusColumn.append(status.element, actions);
  if (mode === 'popup') {
    const settingsLink = element(document, 'a', 'settings-link', 'Connection settings');
    settingsLink.href = '/options.html';
    listen(settingsLink, 'click', (event) => {
      if (!openOptions) return;
      event.preventDefault();
      void openOptions().catch((cause: unknown) => showError(cause));
    });
    statusColumn.append(settingsLink);
  }
  workspace.append(statusColumn);
  main.append(feedback, error, workspace);
  page.append(header, main, contactFooter(document));
  root.replaceChildren(page);

  let disposed = false;
  let busy = false;
  let settingsBusy = false;
  let settingsLoaded = false;
  let dirty = false;
  let lastStatus: CompanionStatus | undefined;
  let active: Promise<void> | undefined;
  let refreshQueued = false;

  function listen(target: EventTarget, event: string, listener: EventListener) {
    target.addEventListener(event, listener);
    cleanup.push(() => target.removeEventListener(event, listener));
  }
  function controls() {
    status.setBusy(busy);
    refresh.disabled = busy;
    check.disabled = busy || dirty || Boolean(form && !settingsLoaded);
    retry.disabled =
      busy || dirty || !lastStatus || lastStatus.queue.pending + lastStatus.queue.blocked === 0;
    if (form) {
      form.endpoint.disabled = settingsBusy || !settingsLoaded;
      form.token.disabled = settingsBusy || !settingsLoaded;
      form.save.disabled = busy || !settingsLoaded;
      form.reload.disabled = busy;
      form.reload.hidden = settingsLoaded || busy;
      form.dirtyHint.hidden = !dirty;
      form.form.setAttribute('aria-busy', String(settingsBusy));
    }
  }
  function showError(cause: unknown) {
    if (disposed) return;
    error.textContent =
      cause instanceof Error
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : 'The companion could not be reached. Refresh to try again.';
    error.hidden = false;
  }
  function acceptStatus(value: CompanionStatus) {
    lastStatus = value;
    status.update(value);
  }
  function successMessage(message: UiRequest): string {
    switch (message.type) {
      case 'settings:get':
        return 'Local connection settings loaded.';
      case 'settings:save':
        return 'Connection settings saved locally.';
      case 'retry':
        return 'Retry finished. Review the delivery status below.';
      case 'check':
        return 'Connection check finished.';
      default:
        return 'Status updated.';
    }
  }
  function run(message: UiRequest): Promise<void> {
    if (disposed) return Promise.resolve();
    if (active) {
      if (message.type === 'status') refreshQueued = true;
      return active;
    }
    busy = true;
    settingsBusy = message.type === 'settings:get' || message.type === 'settings:save';
    error.hidden = true;
    feedback.textContent =
      message.type === 'settings:save'
        ? 'Saving connection…'
        : message.type === 'settings:get'
          ? 'Loading local connection settings…'
          : message.type === 'check'
            ? 'Checking the local worker…'
            : message.type === 'retry'
              ? 'Retrying queued delivery…'
              : 'Reading companion status…';
    controls();
    let receivedStatus = false;
    let saved = false;
    const operation = (async () => {
      const reply = await request(message);
      if (disposed) return;
      if (!reply || typeof reply.ok !== 'boolean')
        throw new Error('The companion returned an invalid response. Refresh to try again.');
      if (reply.status) {
        acceptStatus(reply.status);
        receivedStatus = true;
      }
      if (!reply.ok)
        throw new Error(reply.error || 'The companion could not complete this request. Try again.');
      if (message.type === 'settings:get' && form) {
        if (!reply.settings)
          throw new Error('No connection settings were returned. Reload settings to try again.');
        form.endpoint.value = reply.settings.endpoint;
        form.token.value = reply.settings.token;
        settingsLoaded = true;
        dirty = false;
      }
      if (message.type === 'settings:save' && form) {
        saved = true;
        dirty = false;
        form.endpoint.value = message.settings.endpoint;
      }
      // Settings replies need not echo status, and save replies never need to echo the token.
      if (!reply.status) {
        if (message.type === 'status')
          throw new Error('No companion status was returned. Refresh to try again.');
        const snapshot = await request({ type: 'status' });
        if (disposed) return;
        if (snapshot?.status) {
          acceptStatus(snapshot.status);
          receivedStatus = true;
        }
        if (!snapshot?.ok || !snapshot.status)
          throw new Error(
            snapshot?.error || 'No companion status was returned. Refresh to try again.',
          );
      }
      feedback.textContent = successMessage(message);
    })().catch((cause: unknown) => {
      if (disposed) return;
      feedback.textContent = saved
        ? 'Connection settings saved locally; status could not be refreshed.'
        : '';
      if (!receivedStatus) status.setStale(Boolean(lastStatus));
      showError(cause);
    });
    active = operation.finally(() => {
      active = undefined;
      if (disposed) return;
      busy = false;
      settingsBusy = false;
      controls();
      if (refreshQueued) {
        refreshQueued = false;
        return run({ type: 'status' });
      }
    });
    return active;
  }

  listen(check, 'click', () => {
    void run({ type: 'check' });
  });
  listen(retry, 'click', () => {
    void run({ type: 'retry' });
  });
  listen(refresh, 'click', () => {
    void run({ type: 'status' });
  });
  if (form) {
    listen(form.reload, 'click', () => {
      void run({ type: 'settings:get' });
    });
    const changed = () => {
      dirty = true;
      form.endpoint.removeAttribute('aria-invalid');
      form.endpointError.hidden = true;
      controls();
    };
    listen(form.endpoint, 'input', changed);
    listen(form.token, 'input', changed);
    listen(form.form, 'submit', (event) => {
      event.preventDefault();
      if (busy || !settingsLoaded) return;
      const endpoint = readEndpoint(form.endpoint.value);
      if (endpoint === undefined) {
        form.endpoint.setAttribute('aria-invalid', 'true');
        form.endpointError.textContent = `Enter a local HTTP worker origin. An explicit port must be from 1024 to 65535. ${endpointHelp}`;
        form.endpointError.hidden = false;
        form.endpoint.focus();
        return;
      }
      form.endpoint.removeAttribute('aria-invalid');
      form.endpointError.hidden = true;
      const settings: ConnectionSettings = { endpoint, token: form.token.value };
      void run({ type: 'settings:save', settings });
    });
  }
  const ready = run(mode === 'options' ? { type: 'settings:get' } : { type: 'status' });
  return {
    ready,
    refresh: () => run({ type: 'status' }),
    whenIdle: () => active ?? Promise.resolve(),
    destroy() {
      disposed = true;
      refreshQueued = false;
      for (const remove of cleanup) remove();
      if (form) form.token.value = '';
    },
  };
}

export function mountPopup(
  root: HTMLElement,
  request: RequestClient,
  openOptions: () => Promise<void>,
): MountedUi {
  return mount(root, request, 'popup', openOptions);
}

export function mountOptions(root: HTMLElement, request: RequestClient): MountedUi {
  return mount(root, request, 'options');
}
