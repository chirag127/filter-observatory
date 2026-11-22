import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ENDPOINT, SETTINGS_KEY, readSettings, saveSettings, validateSettings } from '../utils/settings.ts';

const token = 'test-worker-token-not-a-secret';

test('settings start unconfigured and store only the local worker connection', async () => {
  const data: Record<string, unknown> = {};
  const store = { get: async () => structuredClone(data), set: async (items: Record<string, unknown>) => { Object.assign(data, items); } };
  assert.deepEqual(await readSettings(store), { endpoint: DEFAULT_ENDPOINT, token: '' });
  await saveSettings(store, { endpoint: ' http://localhost:4317/ ', token });
  assert.deepEqual(data, { [SETTINGS_KEY]: { endpoint: 'http://localhost:4317', token } });
  assert.deepEqual(await readSettings(store), data[SETTINGS_KEY]);
});

for (const endpoint of [
  'https://127.0.0.1:4317', 'http://127.0.0.2:4317', 'http://[::1]:4317', 'http://localHost:4317',
  'http://localhost.evil.test:4317', 'http://localhost.:4317', 'http://127.1:4317', 'http://2130706433:4317',
  'http://0x7f000001:4317', 'http://user:pass@localhost:4317', 'http://localhost:4317/api',
  'http://localhost:4317?token=secret', 'http://localhost:4317/#fragment', 'http://localhost:0', 'http://localhost:65536',
  'http://localhost:1', 'http://localhost:80', 'http://localhost:1023', 'http://localhost:04317',
]) {
  test(`rejects endpoint outside the exact loopback contract: ${endpoint}`, () => {
    assert.throws(() => validateSettings({ endpoint, token }));
  });
}

test('token validation excludes header injection and errors do not echo secrets', () => {
  const bad = 'private-secret\r\nX-Header: value';
  assert.throws(() => validateSettings({ endpoint: DEFAULT_ENDPOINT, token: bad }), (error: Error) => {
    assert.ok(!error.message.includes('private-secret'));
    return true;
  });
  assert.equal(validateSettings({ endpoint: DEFAULT_ENDPOINT, token: '' }).token, '');
});
