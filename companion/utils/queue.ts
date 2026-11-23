import type { CaptureEnvelope, CompanionStatus, QueueSummary } from './contracts.ts';

export interface QueueMetadata {
  id: string;
  bytes: number;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  blocked: boolean;
  lastError?: string;
}

export interface QueuedCapture extends QueueMetadata {
  body: string;
}

export interface CaptureAcknowledgement {
  id: string;
  state: 'queued' | 'stored';
  duplicate: boolean;
}

export function isAcknowledgement(value: unknown, id: string): value is CaptureAcknowledgement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.id === id &&
    (candidate.state === 'queued' || candidate.state === 'stored') &&
    typeof candidate.duplicate === 'boolean'
  );
}

export class CaptureQueue {
  private readonly factory: IDBFactory;
  private readonly name: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private database?: Promise<IDBDatabase>;

  constructor(
    options: {
      factory?: IDBFactory;
      name?: string;
      now?: () => number;
      maxBytes?: number;
      maxEntries?: number;
    } = {},
  ) {
    this.factory = options.factory ?? indexedDB;
    this.name = options.name ?? 'filter-observatory-captures-v1';
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 64;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = this.factory.open(this.name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('outbox', { keyPath: 'id' });
          request.result.createObjectStore('payloads');
          request.result.createObjectStore('meta');
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.database = undefined;
          };
          resolve(db);
        };
        request.onerror = () => {
          this.database = undefined;
          reject(request.error);
        };
        request.onblocked = () =>
          reject(
            new Error('Evidence storage is blocked by another extension page. Close it and retry.'),
          );
      });
    }
    return this.database;
  }

  private async transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    operation: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const opening = this.open();
    const db = signal
      ? await new Promise<IDBDatabase>((resolve, reject) => {
          const cancel = () =>
            reject(signal.reason ?? new Error('Evidence storage was cancelled.'));
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
          opening.then(
            (database) => {
              signal.removeEventListener('abort', cancel);
              resolve(database);
            },
            (error: unknown) => {
              signal.removeEventListener('abort', cancel);
              reject(error);
            },
          );
        })
      : await opening;
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(
        stores,
        mode,
        mode === 'readwrite' ? { durability: 'strict' } : undefined,
      );
      let value: T;
      let failure: Error | undefined;
      // Request success is not durability: only the transaction's commit acknowledges a write.
      const cancel = () => {
        failure =
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Evidence storage was cancelled.');
        try {
          tx.abort();
        } catch {
          /* An already committed transaction still reports its actual result. */
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      tx.oncomplete = () => {
        signal?.removeEventListener('abort', cancel);
        resolve(value);
      };
      tx.onabort = () => {
        signal?.removeEventListener('abort', cancel);
        reject(failure ?? tx.error ?? new Error('Evidence storage transaction was aborted.'));
      };
      tx.onerror = () => {
        failure ??= tx.error ?? new Error('Evidence storage failed.');
      };
      const fail = (error: Error) => {
        failure = error;
        tx.abort();
      };
      try {
        operation(
          tx,
          (result) => {
            value = result;
          },
          fail,
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Evidence storage failed.'));
      }
    });
  }

  async enqueue(capture: CaptureEnvelope, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const body = JSON.stringify(capture);
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > this.maxBytes)
      throw new Error('Capture exceeds the local evidence queue capacity.');
    await this.transaction<void>(
      ['outbox', 'payloads', 'meta'],
      'readwrite',
      (tx, done, fail) => {
        const outbox = tx.objectStore('outbox');
        const payloads = tx.objectStore('payloads');
        const existing = payloads.get(capture.id);
        existing.onsuccess = () => {
          if (existing.result !== undefined) {
            if (existing.result !== body)
              fail(new Error('Capture ID conflict. Original evidence was preserved.'));
            else done(undefined);
            return;
          }
          const all = outbox.getAll();
          all.onsuccess = () => {
            const entries = all.result as QueueMetadata[];
            if (
              entries.length >= this.maxEntries ||
              entries.reduce((sum, item) => sum + item.bytes, bytes) > this.maxBytes
            ) {
              fail(
                new Error(
                  'The local evidence queue is full. Connect the worker and retry; existing captures are preserved.',
                ),
              );
              return;
            }
            const metadata: QueueMetadata = {
              id: capture.id,
              bytes,
              enqueuedAt: this.now(),
              attempts: 0,
              nextAttemptAt: 0,
              blocked: false,
            };
            payloads.add(body, capture.id);
            outbox.add(metadata);
            tx.objectStore('meta').put(
              {
                state: 'saved',
                message: 'Viewport saved to the local delivery queue.',
                at: capture.capturedAt,
              },
              'lastCapture',
            );
            done(undefined);
          };
        };
      },
      signal,
    );
  }

  async read(id: string): Promise<QueuedCapture | undefined> {
    return this.transaction(['outbox', 'payloads'], 'readonly', (tx, done) => {
      const entry = tx.objectStore('outbox').get(id);
      entry.onsuccess = () => {
        if (!entry.result) {
          done(undefined);
          return;
        }
        const payload = tx.objectStore('payloads').get(id);
        payload.onsuccess = () => done({ ...entry.result, body: payload.result } as QueuedCapture);
      };
    });
  }

  async claimNext(now = this.now()): Promise<QueuedCapture | undefined> {
    return this.transaction(['outbox', 'payloads', 'meta'], 'readwrite', (tx, done, fail) => {
      const pause = tx.objectStore('meta').get('pauseUntil');
      pause.onsuccess = () => {
        if (Number(pause.result ?? 0) > now) {
          done(undefined);
          return;
        }
        const outbox = tx.objectStore('outbox');
        const all = outbox.getAll();
        all.onsuccess = () => {
          const next = (all.result as QueueMetadata[])
            .filter((entry) => !entry.blocked && entry.nextAttemptAt <= now)
            .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id))[0];
          if (!next) {
            done(undefined);
            return;
          }
          const payload = tx.objectStore('payloads').get(next.id);
          payload.onsuccess = () => {
            if (typeof payload.result !== 'string') {
              fail(new Error('Queued evidence payload is missing.'));
              return;
            }
            const claimed = {
              ...next,
              attempts: next.attempts + 1,
              nextAttemptAt: now + Math.min(300_000, 1000 * 2 ** Math.min(next.attempts, 9)),
            };
            outbox.put(claimed);
            tx.objectStore('meta').put(now + 1000, 'pauseUntil');
            done({ ...claimed, body: payload.result });
          };
        };
      };
    });
  }

  async acknowledge(id: string, acknowledgement: unknown): Promise<void> {
    if (!isAcknowledgement(acknowledgement, id))
      throw new Error('Worker acknowledgement does not match the capture.');
    await this.transaction<void>(['outbox', 'payloads', 'meta'], 'readwrite', (tx, done) => {
      tx.objectStore('outbox').delete(id);
      tx.objectStore('payloads').delete(id);
      tx.objectStore('meta').put({ id, at: new Date(this.now()).toISOString() }, 'lastDelivery');
      done(undefined);
    });
  }

  async fail(
    id: string,
    message: string,
    options: { blocked?: boolean; retryAt?: number } = {},
  ): Promise<void> {
    await this.transaction<void>(['outbox'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('outbox');
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) {
          const entry = request.result as QueueMetadata;
          store.put({
            ...entry,
            lastError: message.slice(0, 512),
            blocked: options.blocked ?? false,
            nextAttemptAt: options.retryAt ?? entry.nextAttemptAt,
          });
        }
        done(undefined);
      };
    });
  }

  async retryAll(): Promise<void> {
    await this.transaction<void>(['outbox', 'meta'], 'readwrite', (tx, done) => {
      const outbox = tx.objectStore('outbox');
      const request = outbox.getAll();
      request.onsuccess = () => {
        for (const entry of request.result as QueueMetadata[])
          outbox.put({ ...entry, blocked: false, nextAttemptAt: 0 });
        // A user retry may retry rejected evidence, but cannot override a server Retry-After pause.
        done(undefined);
      };
    });
  }

  async pauseUntil(until: number): Promise<void> {
    await this.transaction<void>(['meta'], 'readwrite', (tx, done) => {
      tx.objectStore('meta').put(until, 'pauseUntil');
      done(undefined);
    });
  }

  async lastDelivery(): Promise<{ id: string; at: string } | undefined> {
    return this.transaction(['meta'], 'readonly', (tx, done) => {
      const request = tx.objectStore('meta').get('lastDelivery');
      request.onsuccess = () => done(request.result);
    });
  }

  async lastCapture(): Promise<CompanionStatus['capture'] | undefined> {
    return this.transaction(['meta'], 'readonly', (tx, done) => {
      const request = tx.objectStore('meta').get('lastCapture');
      request.onsuccess = () => done(request.result);
    });
  }

  async recordCaptureError(
    message: string,
    at = new Date(this.now()).toISOString(),
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transaction<void>(
      ['meta'],
      'readwrite',
      (tx, done) => {
        tx.objectStore('meta').put(
          { state: 'error', message: message.slice(0, 512), at },
          'lastCapture',
        );
        done(undefined);
      },
      signal,
    );
  }

  async comparisonBlocked(): Promise<boolean> {
    return this.transaction(['meta'], 'readonly', (tx, done) => {
      const request = tx.objectStore('meta').get('comparisonBlocked');
      request.onsuccess = () =>
        done(
          request.result === true || (Array.isArray(request.result) && request.result.length > 0),
        );
    });
  }

  async recordComparisonBlocked(
    blocked: boolean,
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transaction<void>(
      ['meta'],
      'readwrite',
      (tx, done) => {
        const meta = tx.objectStore('meta');
        const request = meta.get('comparisonBlocked');
        request.onsuccess = () => {
          // An unscoped legacy block cannot be cleared by an unrelated worker's idle response.
          if (request.result === true) {
            done(undefined);
            return;
          }
          const endpoints = new Set<string>(Array.isArray(request.result) ? request.result : []);
          if (blocked) endpoints.add(endpoint);
          else endpoints.delete(endpoint);
          meta.put([...endpoints], 'comparisonBlocked');
          done(undefined);
        };
      },
      signal,
    );
  }

  async summary(): Promise<QueueSummary> {
    return this.transaction(['outbox', 'meta'], 'readonly', (tx, done) => {
      const request = tx.objectStore('outbox').getAll();
      request.onsuccess = () => {
        const entries = request.result as QueueMetadata[];
        const pending = entries.filter((entry) => !entry.blocked);
        const pause = tx.objectStore('meta').get('pauseUntil');
        pause.onsuccess = () => {
          const retry = pending.length
            ? Math.max(
                Number(pause.result ?? 0),
                Math.min(...pending.map((entry) => entry.nextAttemptAt)),
              )
            : 0;
          done({
            pending: pending.length,
            blocked: entries.length - pending.length,
            bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            ...(entries.length
              ? {
                  oldestAt: new Date(
                    Math.min(...entries.map((entry) => entry.enqueuedAt)),
                  ).toISOString(),
                }
              : {}),
            ...(retry === Infinity ? { retryPaused: true } : {}),
            ...(Number.isFinite(retry) && retry > 0
              ? { nextRetryAt: new Date(retry).toISOString() }
              : {}),
            ...(entries.find((entry) => entry.lastError)
              ? { lastError: entries.find((entry) => entry.lastError)!.lastError }
              : {}),
          });
        };
      };
    });
  }

  async close(): Promise<void> {
    if (this.database) (await this.database).close();
    this.database = undefined;
  }
}
