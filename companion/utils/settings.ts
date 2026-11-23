import type { ConnectionSettings } from './contracts.ts';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:4317';
export const SETTINGS_KEY = 'worker-connection-v1';

export interface LocalSettingsStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function validateSettings(input: unknown): ConnectionSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Worker connection settings are invalid.');
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.endpoint !== 'string' || typeof candidate.token !== 'string') {
    throw new Error('Enter a worker URL and token.');
  }
  const raw = candidate.endpoint.trim();
  // Validate the written host as well as URL.hostname: URL parsing normalizes alternate IP spellings.
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(?::[1-9][0-9]{0,4})?\/?$/.test(raw)) {
    throw new Error('Use http://127.0.0.1 or http://localhost with an optional port, and no path.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The worker URL has an invalid port.');
  }
  const port = /:(\d+)\/?$/.exec(raw)?.[1];
  if (port !== undefined && (Number(port) < 1024 || Number(port) > 65535)) {
    throw new Error('An explicit worker port must be from 1024 to 65535.');
  }
  const token = candidate.token.trim();
  if (
    token &&
    (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token) || token.length < 16 || token.length > 1024)
  ) {
    throw new Error('The worker token must be 16–1024 characters without spaces.');
  }
  return { endpoint: url.origin, token };
}

export async function readSettings(store: LocalSettingsStore): Promise<ConnectionSettings> {
  const stored = (await store.get(SETTINGS_KEY))[SETTINGS_KEY];
  return stored === undefined
    ? { endpoint: DEFAULT_ENDPOINT, token: '' }
    : validateSettings(stored);
}

export async function saveSettings(
  store: LocalSettingsStore,
  input: unknown,
): Promise<ConnectionSettings> {
  const settings = validateSettings(input);
  await store.set({ [SETTINGS_KEY]: settings });
  return settings;
}
