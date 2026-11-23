import type { ConnectionSettings, ConnectionState } from './contracts.ts';
import { CaptureQueue, isAcknowledgement } from './queue.ts';
import { validateSettings } from './settings.ts';
import { comparisonObservation } from './comparison.ts';
import type { CaptureEnvironment, ComparisonObservation } from './comparison.ts';

export interface ConnectionResult {
  connection: ConnectionState;
  connectionMessage: string;
  checkedAt?: string;
}

async function boundedJson(response: Response, maxBytes = 16384): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('Response too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(buffer));
}

export function retryAfter(header: string | null, now: number): number {
  if (header && /^\d+$/.test(header)) {
    const seconds = Number(header);
    const deadline = now + Math.max(1000, seconds * 1000);
    return Number.isSafeInteger(seconds) &&
      Number.isSafeInteger(deadline) &&
      deadline <= 8_640_000_000_000_000
      ? deadline
      : Infinity;
  }
  const date = header ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(now + 1000, date) : now + 60_000;
}

export class WorkerTransport {
  private readonly queue: CaptureQueue;
  private readonly settings: () => Promise<ConnectionSettings>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private running?: Promise<ConnectionResult | undefined>;

  constructor(
    queue: CaptureQueue,
    settings: () => Promise<ConnectionSettings>,
    options: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.queue = queue;
    this.settings = settings;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private result(connection: ConnectionState, connectionMessage: string): ConnectionResult {
    return { connection, connectionMessage, checkedAt: new Date(this.now()).toISOString() };
  }

  private async request<T>(
    settings: ConnectionSettings,
    path: '/api/health' | '/api/state' | '/api/captures',
    consume: (response: Response) => Promise<T>,
    body?: string,
    timeoutMs = 8000,
  ): Promise<T> {
    const validated = validateSettings(settings);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${validated.endpoint}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${validated.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body,
        signal: abort.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      try {
        return await consume(response);
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async check(): Promise<ConnectionResult> {
    const settings = validateSettings(await this.settings());
    if (!settings.token)
      return this.result('unconfigured', 'Add your local worker token in connection settings.');
    try {
      return await this.request(settings, '/api/health', async (response) => {
        if (response.status === 401 || response.status === 403)
          return this.result(
            'unauthorized',
            'Worker rejected the token. Update connection settings.',
          );
        if (response.status !== 200)
          return this.result('error', `Worker health check returned HTTP ${response.status}.`);
        let health: unknown;
        try {
          health = await boundedJson(response);
        } catch {
          return this.result('error', 'Worker returned an invalid health response.');
        }
        if (
          !health ||
          typeof health !== 'object' ||
          Array.isArray(health) ||
          (health as Record<string, unknown>).ok !== true ||
          typeof (health as Record<string, unknown>).version !== 'string'
        ) {
          return this.result('error', 'Worker returned an invalid health response.');
        }
        return this.result(
          'online',
          'Local worker is reachable. Capture delivery is separate from analysis and reporting.',
        );
      });
    } catch {
      return this.result(
        'offline',
        'Cannot reach the local worker. Start it and check the endpoint; queued captures stay on this device.',
      );
    }
  }

  async captureEnvironment(
    signal?: AbortSignal,
    pinnedSettings?: ConnectionSettings,
  ): Promise<CaptureEnvironment> {
    signal?.throwIfAborted();
    const settings = validateSettings(pinnedSettings ?? (await this.settings()));
    let activity: ComparisonObservation = { state: 'unknown' };
    if (settings.token) {
      try {
        activity = await this.request(
          settings,
          '/api/state',
          async (response) => {
            if (response.status !== 200) return { state: 'unknown' as const };
            return comparisonObservation(await boundedJson(response, 4 * 1024 * 1024));
          },
          undefined,
          900,
        );
      } catch {
        /* Offline capture is allowed only when no unresolved comparison was observed. */
      }
    }
    signal?.throwIfAborted();
    if (activity.state === 'busy') {
      await this.queue.recordComparisonBlocked(true, settings.endpoint, signal);
      throw new Error(
        'A worker comparison or pending restoration owns the browser profile. Wait for restoration and capture again.',
      );
    }
    if (activity.state === 'idle') {
      await this.queue.recordComparisonBlocked(false, settings.endpoint, signal);
      if (await this.queue.comparisonBlocked()) {
        throw new Error(
          'A previously observed comparison belongs to another worker. Reconnect that worker and verify restoration before capturing.',
        );
      }
      return {
        revision: activity.revision,
        limitations: [
          'Worker activity was checked before and after capture; these reads do not acquire an exclusive profile lock.',
        ],
      };
    }
    if (await this.queue.comparisonBlocked()) {
      throw new Error(
        'A previously observed comparison or restoration has not been verified finished. Reconnect the worker before capturing.',
      );
    }
    return {
      limitations: [
        'Worker comparison activity could not be verified; captured blocker state and installed-state condition are unknown.',
      ],
    };
  }

  drain(): Promise<ConnectionResult | undefined> {
    if (this.running) return this.running;
    const operation = this.deliverNext();
    this.running = operation;
    void operation
      .finally(() => {
        if (this.running === operation) this.running = undefined;
      })
      .catch(() => {});
    return operation;
  }

  private async deliverNext(): Promise<ConnectionResult | undefined> {
    const settings = validateSettings(await this.settings());
    if (!settings.token)
      return this.result(
        'unconfigured',
        'Add your local worker token; captured evidence remains queued.',
      );
    const entry = await this.queue.claimNext(this.now());
    if (!entry) return undefined;
    let outcome: {
      result: ConnectionResult;
      ack?: unknown;
      blocked?: boolean;
      retryAt?: number;
      pause?: number;
    };
    try {
      outcome = await this.request(
        settings,
        '/api/captures',
        async (response) => {
          if (response.status === 200 || response.status === 201) {
            let ack: unknown;
            try {
              ack = await boundedJson(response);
            } catch {
              /* A success without a receipt is still retriable. */
            }
            if (isAcknowledgement(ack, entry.id))
              return {
                result: this.result(
                  'online',
                  'Worker acknowledged the captured evidence. Analysis and reporting have their own status.',
                ),
                ack,
              };
            return {
              result: this.result(
                'error',
                'Worker did not acknowledge this capture ID. The original evidence is retained for retry.',
              ),
            };
          }
          if (response.status === 401 || response.status === 403) {
            return {
              result: this.result(
                'unauthorized',
                'Worker rejected the token. Update connection settings; evidence is retained.',
              ),
              retryAt: this.now() + 300_000,
            };
          }
          if (
            response.status === 429 ||
            (response.status === 503 && response.headers.has('Retry-After'))
          ) {
            const pause = retryAfter(response.headers.get('Retry-After'), this.now());
            return {
              result: this.result(
                'error',
                Number.isFinite(pause)
                  ? `${response.status === 503 ? 'Worker is temporarily unavailable.' : 'Worker rate limit reached.'} Captures will retry after the worker pause.`
                  : 'Worker returned a retry deadline outside the supported date range. Automatic delivery is paused; evidence is retained.',
              ),
              retryAt: pause,
              pause,
            };
          }
          if (response.status === 409) {
            return {
              result: this.result(
                'error',
                'Worker reports a capture ID conflict. Original evidence is retained; inspect the worker before retrying.',
              ),
              blocked: true,
            };
          }
          const permanent =
            response.status >= 400 && response.status < 500 && response.status !== 408;
          return {
            result: this.result(
              'error',
              `Worker returned HTTP ${response.status}. Evidence is retained${permanent ? '; correct the worker configuration and retry' : ' for automatic retry'}.`,
            ),
            blocked: permanent,
          };
        },
        entry.body,
      );
    } catch {
      outcome = {
        result: this.result(
          'offline',
          'Worker delivery was interrupted. The same capture ID and bytes will retry automatically.',
        ),
      };
    }
    if (outcome.ack) {
      // Failure to commit this acknowledgement leaves the original body retriable with its existing ID.
      await this.queue.acknowledge(entry.id, outcome.ack);
    } else {
      if (outcome.pause) await this.queue.pauseUntil(outcome.pause);
      await this.queue.fail(entry.id, outcome.result.connectionMessage, {
        blocked: outcome.blocked,
        retryAt: outcome.retryAt,
      });
    }
    return outcome.result;
  }
}
