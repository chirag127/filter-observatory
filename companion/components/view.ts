import type { CompanionStatus, ConnectionState } from '../utils/contracts.ts';

export function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(document: Document, text: string, className = 'button'): HTMLButtonElement {
  const node = element(document, 'button', className, text);
  node.type = 'button';
  return node;
}

export function contactFooter(document: Document): HTMLElement {
  const footer = element(document, 'footer', 'hire-me');
  footer.append(
    element(document, 'h3', '', 'Hire me'),
    element(document, 'p', '', 'Chirag Singhal — building free, open APIs and tools.'),
  );
  const links = element(document, 'p', 'contact-links');
  const destinations = [
    ['chirag@oriz.in', 'mailto:chirag@oriz.in'],
    ['GitHub', 'https://github.com/chirag127'],
    ['LinkedIn', 'https://www.linkedin.com/in/chirag127/'],
    ['X', 'https://x.com/singhal127'],
    ['YouTube', 'https://www.youtube.com/@ChiragSinghal127'],
    ['Instagram', 'https://www.instagram.com/chiragsinghal127/'],
    ['Reddit', 'https://www.reddit.com/user/Far_Macaron_9910/'],
    ['Buy me a coffee', 'https://buymeacoffee.com/chirag127'],
  ] as const;
  for (const [label, href] of destinations) {
    if (links.childNodes.length) links.append(document.createTextNode(' · '));
    const link = element(document, 'a', '', label);
    link.href = href;
    if (href.startsWith('https:')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    links.append(link);
  }
  footer.append(links);
  return footer;
}

const connectionLabels: Record<ConnectionState, string> = {
  unconfigured: 'Not configured',
  checking: 'Checking',
  online: 'Online',
  offline: 'Offline',
  unauthorized: 'Token not accepted',
  error: 'Connection error',
};

const captureLabels: Record<CompanionStatus['capture']['state'], string> = {
  idle: 'Idle',
  capturing: 'Capturing',
  saved: 'Saved locally',
  error: 'Capture failed',
};

function time(document: Document, value: string): HTMLElement {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return element(document, 'span', '', 'Time unavailable');
  const node = element(document, 'time');
  node.dateTime = date.toISOString();
  node.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return node;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function createStatusView(document: Document, mode: 'popup' | 'options') {
  const container = element(document, 'div', 'status-stack');
  const fields: Record<string, HTMLElement> = {};
  function field(tag: 'p' | 'span' | 'dd' | 'kbd', name: string, text: string, className = '') {
    const node = element(document, tag, className, text);
    node.dataset.field = name;
    fields[name] = node;
    return node;
  }
  function section(title: string, id: string, className = 'status-section') {
    const node = element(document, 'section', className);
    const heading = element(document, 'h2', '', title);
    heading.id = id;
    node.setAttribute('aria-labelledby', id);
    node.append(heading);
    container.append(node);
    return node;
  }
  function detail(list: HTMLDListElement, label: string, name: string) {
    const row = element(document, 'div');
    row.append(element(document, 'dt', '', label), field('dd', name, '—'));
    list.append(row);
  }
  const stale = element(
    document,
    'p',
    'stale-notice',
    'Showing the last received status. Refresh to try again.',
  );
  stale.hidden = true;
  container.append(stale);

  const shortcut = section('Capture from the page', 'shortcut-heading', 'shortcut-panel');
  shortcut.append(
    field('kbd', 'shortcut', 'Reading shortcut…', 'shortcut-key'),
    field('p', 'shortcut-guide', 'Reading the browser’s assigned command.', 'detail'),
  );

  const connection = section('Local worker', 'connection-heading');
  connection.append(
    field('p', 'connection', 'Status unavailable', 'state-label'),
    field('p', 'connection-message', 'Waiting for the companion.', 'detail'),
    field('p', 'endpoint', 'Worker address not yet read', 'endpoint'),
    field('p', 'checked-at', '', 'timestamp'),
  );

  const capture = section('Capture', 'capture-heading');
  capture.append(
    field('p', 'capture-state', 'Status unavailable', 'state-label'),
    field('p', 'capture-message', 'Waiting for the companion.', 'detail'),
    field('p', 'capture-at', '', 'timestamp'),
  );

  const delivery = section('Delivery', 'delivery-heading');
  const queue = element(document, 'dl', 'queue-summary');
  detail(queue, 'Pending', 'pending');
  detail(queue, 'Blocked', 'blocked');
  detail(queue, 'Stored', 'bytes');
  const queueError = field('p', 'queue-error', '', 'inline-error');
  queueError.hidden = true;
  const blockedHelp = field(
    'p',
    'blocked-help',
    'Blocked captures are retained locally. Review the delivery error.',
    'detail',
  );
  blockedHelp.hidden = true;
  const retryTime = field('p', 'next-retry', '', 'timestamp');
  retryTime.hidden = true;
  delivery.append(
    queue,
    field('p', 'queue-empty', 'Queue not yet read.', 'detail'),
    queueError,
    blockedHelp,
    retryTime,
    field('p', 'last-delivery', 'Worker receipt not yet read.', 'detail'),
  );
  const metadata = element(document, 'details', 'delivery-details');
  const metadataList = element(document, 'dl', 'metadata');
  detail(metadataList, 'Oldest queued capture', 'oldest-at');
  detail(metadataList, 'Last receipt ID', 'delivery-id');
  metadata.append(element(document, 'summary', '', 'Delivery details'), metadataList);
  delivery.append(
    metadata,
    element(document, 'p', 'footnote', 'Worker delivery does not confirm analysis or a report.'),
  );

  function set(name: string, value: string) {
    fields[name]!.textContent = value;
  }
  function dated(name: string, prefix: string, value?: string) {
    const node = fields[name]!;
    node.replaceChildren();
    node.hidden = !value;
    if (value) node.append(document.createTextNode(prefix), time(document, value));
  }
  return {
    element: container,
    setBusy(busy: boolean) {
      container.setAttribute('aria-busy', String(busy));
    },
    setStale(value: boolean) {
      stale.hidden = !value;
    },
    update(status: CompanionStatus) {
      stale.hidden = true;
      const assigned = status.shortcut.trim();
      set('shortcut', assigned || 'No shortcut assigned');
      fields.shortcut!.dataset.assigned = String(Boolean(assigned));
      set(
        'shortcut-guide',
        assigned
          ? mode === 'popup'
            ? 'Close this popup, then use this shortcut on the page. The screenshot is taken before any capture UI opens.'
            : 'Return to the page and use this shortcut. The screenshot is taken before any capture UI opens.'
          : status.browser === 'firefox'
            ? 'In Firefox, open Add-ons and themes, then Manage extension shortcuts. Assign “Capture this viewport for Filter Observatory”.'
            : 'Open chrome://extensions/shortcuts and assign “Capture this viewport for Filter Observatory”. Chrome on Windows suggests Ctrl+Q.',
      );
      set('connection', connectionLabels[status.connection] ?? 'Unknown connection state');
      fields.connection!.dataset.state = status.connection;
      set('connection-message', status.connectionMessage);
      set('endpoint', status.endpoint || 'No worker address configured');
      dated('checked-at', 'Last checked: ', status.checkedAt);
      set('capture-state', captureLabels[status.capture.state] ?? 'Unknown capture state');
      fields['capture-state']!.dataset.state = status.capture.state;
      set('capture-message', status.capture.message);
      dated(
        'capture-at',
        status.capture.state === 'error'
          ? 'Failed: '
          : status.capture.state === 'saved'
            ? 'Saved: '
            : status.capture.state === 'capturing'
              ? 'Started: '
              : 'Updated: ',
        status.capture.at,
      );
      set('pending', String(status.queue.pending));
      set('blocked', String(status.queue.blocked));
      set('bytes', bytes(status.queue.bytes));
      set(
        'queue-empty',
        status.queue.pending === 0 && status.queue.blocked === 0
          ? 'No captures waiting for delivery.'
          : 'Queued evidence remains on this device until the worker acknowledges it.',
      );
      set('queue-error', status.queue.lastError ?? '');
      queueError.hidden = !status.queue.lastError;
      blockedHelp.hidden = status.queue.blocked === 0;
      dated('next-retry', 'Next delivery retry: ', status.queue.nextRetryAt);
      if (status.queue.retryPaused) {
        set(
          'next-retry',
          'Automatic delivery is paused by an unsupported worker retry deadline. Evidence stays on this device.',
        );
        retryTime.hidden = false;
      }
      dated('oldest-at', '', status.queue.oldestAt);
      if (!status.queue.oldestAt) {
        fields['oldest-at']!.hidden = false;
        set('oldest-at', 'Not reported');
      }
      if (status.lastDelivery) {
        dated('last-delivery', 'Last worker receipt: ', status.lastDelivery.at);
        set('delivery-id', status.lastDelivery.id);
      } else {
        fields['last-delivery']!.hidden = false;
        set('last-delivery', 'No worker receipt recorded.');
        set('delivery-id', 'None recorded');
      }
    },
  };
}
