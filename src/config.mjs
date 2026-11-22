import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import Ajv from 'ajv';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
const bool = { type: 'boolean' };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const repository = { ...str(201, 3), pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' };
const environmentKey = { ...str(100, 1), pattern: '^[A-Za-z_][A-Za-z0-9_]*$' };
const threadRequirement = { anyOf: [
  { ...str(107, 1), pattern: '^[A-Za-z0-9_.]+$' },
  object({ path: { ...str(121, 1), pattern: '^[A-Za-z][A-Za-z0-9_.]*$' },
    equals: { anyOf: [{ type: 'string' }, { type: 'number' }, bool, { type: 'null' }] } }),
] };
const threadSnapshot = (properties = {}) => object({
  number: integer(1, Number.MAX_SAFE_INTEGER),
  bodyHash: { ...str(64, 64), pattern: '^[a-f0-9]{64}$' },
  verifiedAt: str(100, 1), expiresAt: str(100, 1),
  requirements: { type: 'array', items: threadRequirement },
  ...properties,
}, ['bodyHash', 'verifiedAt', 'requirements']);
const specialThreads = object({
  ...Object.fromEntries(['youtube-ubo', 'youtube-lite', 'facebook', 'twitch', 'spotify']
    .map(key => [key, threadSnapshot()])),
  shortener: threadSnapshot({ nodeId: { ...str(256, 1), pattern: '^[A-Za-z0-9_+=/-]+$' }, screenshotsRequested: bool }),
}, []);

export const defaultConfig = Object.freeze({
  schemaVersion: 1,
  port: 4317,
  autoProcess: true,
  provider: {
    enabled: false, baseUrl: 'http://127.0.0.1:8787/v1', model: 'gpt-4.1',
    apiKeyEnv: 'PROXY_API_KEY', outputMode: 'tool', vision: true,
    timeoutMs: 120000, maxOutputTokens: 2048,
    allowedSensitivity: ['ordinary', 'unknown'],
  },
  publication: {
    enabled: false, tokenEnv: 'GITHUB_TOKEN', evidenceRepository: '', minIntervalMs: 2000,
    allowedRepositories: ['AdguardTeam/AdguardFilters', 'easylist/easylist', 'uBlockOrigin/uAssets'],
  },
  browser: { instance: '', allowChanges: false, isolateUbol: true },
  scheduler: { maxAnalysesPerCycle: 20, maxPublicationsPerCycle: 5, intervalMs: 60000, followUpIntervalMs: 3600000 },
});

const schema = object({
  schemaVersion: { const: 1 }, port: integer(1024, 65535), autoProcess: bool,
  provider: object({
    enabled: bool, baseUrl: str(2048, 1), model: str(200, 1), apiKeyEnv: environmentKey,
    outputMode: { enum: ['tool', 'json-schema'] }, vision: bool,
    timeoutMs: integer(1000, 300000), maxOutputTokens: integer(128, 16384),
    allowedSensitivity: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
      items: { enum: ['ordinary', 'unknown', 'nsfw'] } },
  }),
  publication: object({
    enabled: bool, tokenEnv: environmentKey, evidenceRepository: { anyOf: [repository, { const: '' }] },
    minIntervalMs: integer(1000, 3600000),
    allowedRepositories: { type: 'array', maxItems: 100, uniqueItems: true, items: repository },
    specialThreads,
  }, ['enabled', 'tokenEnv', 'evidenceRepository', 'minIntervalMs', 'allowedRepositories']),
  browser: object({ instance: str(160), allowChanges: bool, isolateUbol: bool }),
  scheduler: object({ maxAnalysesPerCycle: integer(1, 300), maxPublicationsPerCycle: integer(1, 50),
    intervalMs: integer(10000, 86400000), followUpIntervalMs: integer(300000, 86400000) }),
});
const validate = new Ajv({ strict: true }).compile(schema);
const invalid = message => Object.assign(new Error(message), { code: 'invalid_config', status: 400 });

export function defaultStateDir(env = process.env) {
  return resolve(env.FILTER_OBSERVATORY_STATE_DIR || join(env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'FilterObservatory'));
}

export function initializeState(directory) {
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ['config.json', `${JSON.stringify(defaultConfig, null, 2)}\n`],
    ['worker.token', `${randomBytes(32).toString('base64url')}\n`],
  ]) {
    try { writeFileSync(join(dir, name), value, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return { stateDir: dir, configPath: join(dir, 'config.json'), tokenPath: join(dir, 'worker.token') };
}

export function loadConfig(directory) {
  let config;
  try { config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')); }
  catch { throw invalid('Cannot read config.json; run init or correct the JSON'); }
  if (!validate(config)) throw invalid(`Invalid configuration field: ${validate.errors[0].instancePath || '/'}`);
  for (const [key, snapshot] of Object.entries(config.publication.specialThreads ?? {})) {
    for (const field of ['verifiedAt', 'expiresAt']) {
      if (snapshot[field] !== undefined && !Number.isFinite(Date.parse(snapshot[field]))) {
        throw invalid(`Invalid configuration field: /publication/specialThreads/${key}/${field}`);
      }
    }
    for (const requirement of snapshot.requirements) {
      const path = typeof requirement === 'string' ? `prerequisites.${requirement}` : requirement.path;
      if (path.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) {
        throw invalid(`Invalid configuration field: /publication/specialThreads/${key}/requirements`);
      }
    }
  }
  let url;
  try { url = new URL(config.provider.baseUrl); } catch { throw invalid('Provider base URL is invalid'); }
  if (url.username || url.password || url.search || url.hash || /[\u0000-\u0020\u007f]/u.test(config.provider.baseUrl)
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw invalid('Provider endpoint must use HTTPS or loopback HTTP and contain no credentials, query or fragment');
  }
  return config;
}

export function readWorkerToken(directory) {
  const token = readFileSync(join(directory, 'worker.token'), 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid('worker.token is invalid');
  return token;
}

export function resolveProvider(config, env = process.env) {
  const { apiKeyEnv, enabled, allowedSensitivity, ...provider } = config.provider;
  return { ...provider, apiKey: env[apiKeyEnv] || undefined };
}

export async function acquireProcessLock(directory) {
  const canonical = realpathSync(resolve(directory));
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const server = createServer(socket => socket.destroy());
  // Kernel-owned locks vanish after a crash; a persisted PID cannot prove ownership after PID reuse.
  const address = process.platform === 'win32'
    ? { path: `\\\\.\\pipe\\filter-observatory-${key.slice(0, 32)}` }
    : { host: '127.0.0.1', port: 49152 + (Number.parseInt(key.slice(0, 8), 16) % 16384), exclusive: true };
  await new Promise((resolveLock, reject) => {
    server.once('error', cause => reject(Object.assign(new Error('Another worker owns this state directory or its lock endpoint is occupied'), { code: 'worker_busy', cause })));
    server.listen(address, resolveLock);
  });
  let released = false;
  return { async release() {
    if (released) return;
    released = true;
    await new Promise(resolveClose => server.close(resolveClose));
  } };
}
