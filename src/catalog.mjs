import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const bool = (value) => (typeof value === 'boolean' ? value : null);
const clone = (value) => structuredClone(value);
const unique = (values) => [...new Set(values)];

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure(
      'invalid-options',
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const [first, second = '0'] = address.split(':');
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || '0', 16);
  // Global unicast only, excluding special-use, documentation and 6to4 ranges.
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    a !== 0x2002 &&
    !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) &&
    !(a === 0x3fff && b < 0x1000)
  );
}

export function validatePublicUrl(input) {
  const text = input instanceof URL ? input.href : input;
  if (
    typeof text !== 'string' ||
    text.length > 8192 ||
    /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(text) ||
    !/^https?:\/\/[^/?#]/i.test(text)
  ) {
    throw failure(
      'unsafe-url',
      'Expected an absolute public HTTP(S) URL without whitespace or backslashes.',
    );
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw failure('unsafe-url', 'The URL is malformed.');
  }
  const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (url.username || url.password || authority.includes('@')) {
    throw failure('unsafe-url', 'Credentialed URLs are not allowed.');
  }
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
    url.hostname = host;
  }
  const address = host.replace(/^\[|\]$/g, '');
  if (isIP(address)) {
    if (!publicAddress(address))
      throw failure('unsafe-url', 'Nonpublic IP addresses are not allowed.');
  } else {
    if (
      !host.includes('.') ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|onion|invalid|test|example|alt)$/.test(
        host,
      ) ||
      /(?:^|\.)home\.arpa$/.test(host) ||
      host.length > 253 ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      throw failure('unsafe-url', 'Local, special-use or malformed hostnames are not allowed.');
    }
  }
  return url;
}

function nativeGet(url, addresses, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        maxHeaderSize: 16384,
        headers: {
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': 'FilterObservatory/0.1',
        },
        // Pin the vetted answers to the socket: checking DNS and then using fetch would permit rebinding.
        lookup(_hostname, options, callback) {
          const selected = options?.family
            ? addresses.filter((entry) => entry.family === options.family)
            : addresses;
          if (!selected.length)
            return callback(
              failure('unsafe-address', 'No validated address for the requested family.'),
            );
          if (options?.all) callback(null, selected);
          else callback(null, selected[0].address, selected[0].family);
        },
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, values] of Object.entries(incoming.headers)) {
          for (const value of array(values)) if (value != null) headers.append(name, String(value));
        }
        let body = incoming;
        const encoding = headers.get('content-encoding')?.toLowerCase().trim();
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'br'
              ? createBrotliDecompress()
              : encoding === 'deflate'
                ? createInflate()
                : null;
        if (encoding && encoding !== 'identity' && !decoder) {
          incoming.destroy();
          reject(failure('unsupported-encoding', 'Unsupported HTTP content encoding.'));
          return;
        }
        if (decoder) {
          incoming.on('error', (error) => decoder.destroy(error));
          decoder.on('close', () => incoming.destroy());
          body = incoming.pipe(decoder);
        }
        resolve({ status: incoming.statusCode, headers, body, url: url.href, redirected: false });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function disposeBody(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy();
    else if (typeof body?.cancel === 'function') void body.cancel().catch(() => {});
  } catch {
    /* A locked reader is released by its consumer. */
  }
}

function responseHeaders(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  return {
    contentType: get('content-type'),
    contentEncoding: get('content-encoding'),
    contentLength: get('content-length'),
    etag: get('etag'),
    lastModified: get('last-modified'),
    retryAfter: get('retry-after'),
    link: get('link'),
    rateLimitRemaining: get('x-ratelimit-remaining'),
    rateLimitReset: get('x-ratelimit-reset'),
  };
}

export async function fetchPublicBytes(
  input,
  {
    fetchImpl,
    lookupImpl = lookup,
    signal,
    timeoutMs = 15000,
    maxBytes = 8 * 1024 * 1024,
    maxRedirects = 5,
    validateUrl,
    budget,
  } = {},
) {
  integer(timeoutMs, 'timeoutMs', 1, 300000);
  integer(maxBytes, 'maxBytes', 1, 64 * 1024 * 1024);
  integer(maxRedirects, 'maxRedirects', 0, 20);
  if (budget) {
    integer(budget.limit, 'budget.limit', 0, 10000);
    integer(budget.requests, 'budget.requests', 0, 10000);
    if (budget.maxTotalBytes !== undefined) {
      integer(budget.maxTotalBytes, 'budget.maxTotalBytes', 1, 1024 * 1024 * 1024);
      integer(budget.bytes, 'budget.bytes', 0, Number.MAX_SAFE_INTEGER);
    }
  }
  let current = validatePublicUrl(input);
  current.hash = '';
  const provenance = {
    requestedUrl: current.href,
    finalUrl: current.href,
    retrievedAt: new Date().toISOString(),
    redirects: [],
    requests: 0,
    bytes: 0,
    status: null,
    headers: {},
    transport: fetchImpl ? 'injected-client' : 'node-pinned-dns',
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(failure('cancelled', 'Public retrieval was cancelled.'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(failure('timeout', 'Public retrieval exceeded its deadline.')),
    timeoutMs,
  );
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const within = (value) =>
    Promise.race([
      controller.signal.aborted ? Promise.reject(controller.signal.reason) : aborted,
      value,
    ]);
  let activeBody;
  try {
    const visited = new Set();
    for (;;) {
      controller.signal.throwIfAborted();
      if (validateUrl) await within(Promise.resolve(validateUrl(current.href)));
      if (visited.has(current.href))
        throw failure('redirect-loop', 'A redirect loop was observed.');
      visited.add(current.href);
      provenance.finalUrl = current.href;
      const host = current.hostname.replace(/^\[|\]$/g, '');
      const answers = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await within(
            Promise.resolve().then(() => lookupImpl(host, { all: true, verbatim: true })),
          );
      const addresses = array(answers);
      if (
        !addresses.length ||
        addresses.some(
          (entry) =>
            !object(entry) || !publicAddress(entry.address) || entry.family !== isIP(entry.address),
        )
      ) {
        throw failure('unsafe-address', 'DNS returned a nonpublic or invalid address.');
      }
      controller.signal.throwIfAborted();
      if (budget && budget.requests >= budget.limit)
        throw failure('request-budget', 'The HTTP request budget is exhausted.');
      if (budget?.bytes >= budget?.maxTotalBytes)
        throw failure('byte-budget', 'The total HTTP byte budget is exhausted.');
      if (budget) budget.requests += 1;
      provenance.requests += 1;
      const pending = Promise.resolve().then(() =>
        fetchImpl
          ? fetchImpl(current.href, {
              method: 'GET',
              redirect: 'manual',
              signal: controller.signal,
              credentials: 'omit',
              headers: { accept: '*/*' },
            })
          : nativeGet(current, addresses, controller.signal),
      );
      pending.then(
        (result) => {
          if (controller.signal.aborted) disposeBody(result?.body);
        },
        () => {},
      );
      const response = await within(pending);
      activeBody = response?.body;
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        typeof response.headers?.get !== 'function'
      ) {
        throw failure('invalid-response', 'The HTTP client returned an invalid response.');
      }
      if (
        response.redirected ||
        (response.url && validatePublicUrl(response.url).href !== current.href)
      ) {
        throw failure(
          'unverified-redirect',
          'The HTTP client followed a redirect without validation.',
        );
      }
      provenance.status = response.status;
      provenance.headers = responseHeaders(response.headers);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        disposeBody(activeBody);
        activeBody = null;
        const location = response.headers.get('location');
        if (!location) throw failure('invalid-redirect', 'The redirect has no Location header.');
        if (provenance.redirects.length >= maxRedirects)
          throw failure('redirect-limit', 'The redirect limit was reached.');
        if (/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(location))
          throw failure('unsafe-url', 'The redirect URL is malformed.');
        let next;
        try {
          next = validatePublicUrl(new URL(location, current));
        } catch {
          throw failure('unsafe-url', 'The redirect target is not a public HTTP(S) URL.');
        }
        next.hash = '';
        provenance.redirects.push({ from: current.href, to: next.href, status: response.status });
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw failure('http-error', 'Public retrieval returned a non-success HTTP status.', {
          status: response.status,
        });
      if (response.status === 206)
        throw failure(
          'partial-response',
          'An unsolicited partial response is not a complete resource.',
          { status: response.status },
        );
      const declared = response.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes)
        throw failure('too-large', 'The HTTP body exceeds the byte budget.');
      const chunks = [];
      if (activeBody) {
        if (
          typeof activeBody.getReader !== 'function' &&
          typeof activeBody[Symbol.asyncIterator] !== 'function'
        ) {
          throw failure('invalid-response', 'A streaming response body is required.');
        }
        const reader = typeof activeBody.getReader === 'function' ? activeBody.getReader() : null;
        const iterator = reader ? null : activeBody[Symbol.asyncIterator]();
        try {
          for (;;) {
            const { value, done } = await within(reader ? reader.read() : iterator.next());
            if (done) break;
            if (!(value instanceof Uint8Array))
              throw failure('invalid-response', 'HTTP body chunks must be bytes.');
            provenance.bytes += value.byteLength;
            if (budget?.maxTotalBytes !== undefined) {
              budget.bytes += value.byteLength;
              if (budget.bytes > budget.maxTotalBytes)
                throw failure('byte-budget', 'The total HTTP byte budget is exhausted.');
            }
            if (provenance.bytes > maxBytes)
              throw failure('too-large', 'The HTTP body exceeds the byte budget.');
            chunks.push(Buffer.from(value));
          }
        } catch (error) {
          controller.abort(error);
          // An async iterator's return() queues behind a stalled read; cancel the owned web reader directly.
          if (reader) void reader.cancel(error).catch(() => {});
          else if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
          throw error;
        } finally {
          if (reader) reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks, provenance.bytes);
      if (
        declared &&
        /^\d+$/.test(declared) &&
        (!provenance.headers.contentEncoding ||
          provenance.headers.contentEncoding === 'identity') &&
        Number(declared) !== body.length
      )
        throw failure('truncated-body', 'The body does not match its declared length.');
      provenance.sha256 = sha256(body);
      return { body, provenance };
    }
  } catch (error) {
    const known = error?.code && !String(error.code).startsWith('ERR_');
    const result = known
      ? error
      : failure(
          controller.signal.aborted
            ? (controller.signal.reason?.code ?? 'cancelled')
            : 'network-error',
          'Public retrieval failed.',
        );
    result.provenance = clone(provenance);
    throw result;
  } finally {
    disposeBody(activeBody);
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(',')}}`;
}

function jsonValue(raw) {
  try {
    const text =
      raw instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw;
    return typeof text === 'string' ? JSON.parse(text.replace(/^\uFEFF/, '')) : text;
  } catch {
    throw failure('invalid-json', 'The source must contain valid UTF-8 JSON.');
  }
}

const repositoryName = (value) =>
  typeof value === 'string' &&
  /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/i.test(value) &&
  !['.', '..'].includes(value.split('/')[1]);

function sourcePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/[\u0000-\u001f\u007f\\]/.test(value) &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

function githubRepository(value) {
  try {
    const url = validatePublicUrl(value);
    if (url.hostname !== 'github.com') return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/, '')}`;
    return repositoryName(repo) ? repo : undefined;
  } catch {
    return undefined;
  }
}

function publicationPath(value, owner) {
  if (!owner) return null;
  try {
    const url = validatePublicUrl(value);
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
    if (
      url.hostname === 'raw.githubusercontent.com' &&
      `${parts[0]}/${parts[1]}`.toLowerCase() === owner.toLowerCase()
    ) {
      const path = parts.slice(3).join('/');
      return sourcePath(path) ? { path, ref: parts[2], evidence: 'raw-publication-url' } : null;
    }
    const [account, repo] = owner.split('/');
    if (
      url.hostname === `${account.toLowerCase()}.github.io` &&
      parts[0]?.toLowerCase() === repo.toLowerCase()
    ) {
      const path = parts.slice(1).join('/');
      return sourcePath(path) ? { path, evidence: 'published-path; source-branch-unknown' } : null;
    }
  } catch {
    /* An unresolved publication is not ownership evidence. */
  }
  return null;
}

function nativeKey(value, source) {
  if (source === 'filterlists' || source === 'adguard') {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < 1)
      throw failure('invalid-id', 'The source ID must be a positive integer.');
    return String(number);
  }
  const key = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (
    typeof key !== 'string' ||
    !/^[a-z0-9_.-]{1,160}$/i.test(key) ||
    key === '.' ||
    key === '..'
  ) {
    throw failure('invalid-id', 'The source key is missing or malformed.');
  }
  return key;
}

function catalogRecord(source, input, key, context, report) {
  const wrapped = source === 'adguard' && object(input?.metadata);
  const row = wrapped ? input.metadata : input;
  if (!object(row)) throw failure('invalid-record', 'A catalog record must be an object.');
  if (source === 'ubo' && row.content === 'internal') return null;
  if (source === 'ubo' && row.content !== 'filters')
    throw failure('invalid-record', 'Unknown uBO asset content type.');
  const suppliedKey =
    source === 'ubo' ? key : source === 'adguard' ? row.filterId : (row.sourceKey ?? row.id);
  const prefix = `${source}:${source === 'ubo' ? 'asset' : source === 'adguard' ? 'filter' : 'list'}:`;
  const sourceKey = nativeKey(
    source === 'manual' && typeof suppliedKey === 'string' && suppliedKey.startsWith(prefix)
      ? suppliedKey.slice(prefix.length)
      : suppliedKey,
    source,
  );
  const name = source === 'ubo' ? row.title : row.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 4096)
    throw failure('invalid-name', 'An original source name is required.');
  const record = {
    id: prefix + sourceKey,
    name,
    family: typeof row.family === 'string' ? row.family : null,
    source,
    sourceKey,
    snapshot: clone(context.snapshot),
    retrievedAt: context.retrievedAt,
    downloadUrls: [],
    categories: [],
    variants: [],
    dependencies: [],
    status: {
      deprecated: bool(row.deprecated ?? row.status?.deprecated),
      disabled: bool(row.disabled ?? row.status?.disabled),
      archived: bool(row.archived ?? row.status?.archived),
      offByDefault: bool(source === 'ubo' ? row.off : row.status?.offByDefault),
    },
    raw: clone(row),
  };
  const issue = (code, message, field) =>
    report({ code, message, sourceKey, ...(field ? { field } : {}) });
  const url = (value, field) => {
    if (value === undefined || value === null || value === '') return undefined;
    try {
      const parsed = validatePublicUrl(value);
      parsed.hash = '';
      return parsed.href;
    } catch {
      issue('unsafe-url', 'A catalog URL is not an allowed public HTTP(S) target.', field);
      return undefined;
    }
  };
  const homepage = row.homepage ?? row.homeUrl ?? (source === 'ubo' ? row.supportURL : undefined);
  const home = url(homepage, 'homepage');
  if (home) record.homepage = home;
  const ownershipLinks = [row.issuesUrl, row.supportURL, row.sourceUrl, homepage];
  if (row.owner !== undefined && !repositoryName(row.owner))
    issue('invalid-owner', 'Owner must be a GitHub owner/repository identifier.', 'owner');
  let owner = repositoryName(row.owner)
    ? row.owner
    : ownershipLinks.map(githubRepository).find(Boolean);
  if (!owner && home === 'https://easylist.to/') owner = 'easylist/easylist';
  const registryPath = wrapped ? input.path : row.registryPath;
  if (registryPath !== undefined) {
    if (sourcePath(registryPath)) record.registryPath = registryPath;
    else issue('invalid-path', 'The registry path is not a relative source path.', 'registryPath');
  }
  if (
    source === 'adguard' &&
    /^filters\/filter_\d+_[^/]+\/metadata\.json$/.test(record.registryPath ?? '')
  ) {
    owner ??= 'AdguardTeam/AdguardFilters';
    record.family ??= 'AdGuard Filters';
    record.ownerEvidence = { kind: 'first-party-registry-path', path: record.registryPath };
  }
  if (owner) {
    record.owner = owner;
    record.ownerEvidence ??= {
      kind: repositoryName(row.owner) ? 'declared-owner' : 'publisher-link',
      url: ownershipLinks.find((link) => githubRepository(link) === owner) ?? home,
    };
  }
  if (row.sourcePath !== undefined) {
    if (sourcePath(row.sourcePath)) record.sourcePath = row.sourcePath;
    else issue('invalid-path', 'The list source path is not a relative source path.', 'sourcePath');
  }
  const distribution = (value, fields, field) => {
    const parsed = url(value, field);
    record.variants.push({
      kind: 'distribution',
      ...fields,
      advertisedUrl: value,
      ...(parsed ? { url: parsed } : { usable: false }),
    });
    if (parsed) record.downloadUrls.push(parsed);
  };
  const relationship = (id, type, field) => {
    try {
      record.dependencies.push({
        id: `filterlists:list:${nativeKey(id, 'filterlists')}`,
        relationship: type,
        evidenceField: field,
      });
    } catch {
      issue('invalid-dependency', 'A declared relationship has an invalid target ID.', field);
    }
  };
  if (source === 'filterlists') {
    for (const [field, type] of Object.entries({
      dependencyFilterListIds: 'requires',
      dependentFilterListIds: 'required-by',
      includesFilterListIds: 'includes',
      includedInFilterListIds: 'included-in',
      upstreamFilterListIds: 'fork-of',
      forkFilterListIds: 'has-fork',
    })) {
      if (row[field] != null && !Array.isArray(row[field]))
        issue('invalid-field', 'Relationship IDs must be an array.', field);
      else for (const id of row[field] ?? []) relationship(id, type, field);
    }
    if (row.viewUrls != null && !Array.isArray(row.viewUrls))
      issue('invalid-field', 'viewUrls must be an array.', 'viewUrls');
    else
      for (const view of row.viewUrls ?? []) {
        if (!object(view)) {
          issue('invalid-field', 'A view URL must be an object.', 'viewUrls');
          continue;
        }
        const segmentNumber =
          Number.isSafeInteger(view.segmentNumber) && view.segmentNumber > 0
            ? view.segmentNumber
            : null;
        const primariness =
          Number.isSafeInteger(view.primariness) && view.primariness > 0 ? view.primariness : null;
        if (segmentNumber === null || primariness === null)
          issue(
            'unknown-distribution-role',
            'A view URL has unknown segment or mirror ordering.',
            'viewUrls',
          );
        distribution(
          view.url,
          {
            segmentNumber,
            primariness,
            role: primariness === 1 ? 'original' : primariness > 1 ? 'mirror' : 'unknown',
          },
          'viewUrls',
        );
      }
    record.categories = array(row.tagIds)
      .filter((id) => Number.isSafeInteger(id))
      .map((id) => `filterlists:tag:${id}`);
    record.syntaxIds = clone(array(row.syntaxIds));
    record.maintainerIds = clone(array(row.maintainerIds));
  } else if (source === 'ubo') {
    const tags =
      typeof row.tags === 'string'
        ? row.tags.split(/\s+/).filter(Boolean)
        : array(row.tags).filter((value) => typeof value === 'string');
    record.categories = unique(
      [row.group, row.group2, ...tags].filter((value) => typeof value === 'string' && value),
    );
    record.parent = row.parent ?? null;
    record.languages = typeof row.lang === 'string' ? row.lang.split(/\s+/).filter(Boolean) : [];
    array(row.contentURL).forEach((value, index) => {
      if (typeof value === 'string' && value.startsWith('assets/') && sourcePath(value)) {
        record.variants.push({ kind: 'local-fallback', path: value, engine: 'ubo' });
      } else
        distribution(
          value,
          {
            segmentNumber: 1,
            role: index === 0 ? 'primary' : 'fallback',
            engine: 'ubo',
            transformation: 'unknown',
          },
          'contentURL',
        );
    });
    for (const value of array(row.cdnURLs))
      distribution(
        value,
        { segmentNumber: 1, role: 'cdn', engine: 'ubo', transformation: 'unknown' },
        'cdnURLs',
      );
    for (const value of array(row.patchURLs)) {
      const parsed = url(value, 'patchURLs');
      record.variants.push({
        kind: 'patch',
        advertisedUrl: value,
        ...(parsed ? { url: parsed } : { usable: false }),
      });
    }
  } else if (source === 'adguard') {
    record.categories = array(row.tags).filter((value) => typeof value === 'string');
    for (const field of ['subscriptionUrl', 'downloadUrl']) {
      if (row[field])
        distribution(
          row[field],
          {
            segmentNumber: 1,
            role: field === 'subscriptionUrl' ? 'subscription' : 'distribution',
            engine: 'adguard',
            transformation: 'registry-publication; original-rule-provenance-separate',
          },
          field,
        );
    }
    if (row.platformsIncluded !== undefined || row.platformsExcluded !== undefined)
      record.variants.push({
        kind: 'platform-policy',
        included: clone(row.platformsIncluded ?? null),
        excluded: clone(row.platformsExcluded ?? null),
      });
    for (const tag of record.categories) {
      const match = /^reference:(\d+)$/.exec(tag);
      if (match)
        record.dependencies.push({
          id: `adguard:filter:${match[1]}`,
          relationship: 'references',
          evidenceField: 'tags',
        });
    }
    record.groupId = row.groupId ?? null;
    record.trustLevel = row.trustLevel ?? null;
  } else {
    if (row.variants != null && !Array.isArray(row.variants))
      issue('invalid-field', 'variants must be an array.', 'variants');
    else record.variants = clone(row.variants ?? []);
    record.categories = array(row.categories).filter((value) => typeof value === 'string');
    if (row.downloadUrls != null && !Array.isArray(row.downloadUrls))
      issue('invalid-field', 'downloadUrls must be an array.', 'downloadUrls');
    else
      for (const value of row.downloadUrls ?? []) {
        const parsed = url(value, 'downloadUrls');
        if (parsed) record.downloadUrls.push(parsed);
      }
  }
  if (row.dependencies != null) {
    if (!Array.isArray(row.dependencies))
      issue('invalid-field', 'dependencies must be an array.', 'dependencies');
    else
      for (const dependency of row.dependencies) {
        if (typeof dependency === 'string' && dependency.length)
          record.dependencies.push({ id: dependency, relationship: 'requires' });
        else if (
          object(dependency) &&
          typeof dependency.id === 'string' &&
          typeof dependency.relationship === 'string'
        )
          record.dependencies.push(clone(dependency));
        else
          issue(
            'invalid-dependency',
            'A dependency must identify a target and relationship.',
            'dependencies',
          );
      }
  }
  record.downloadUrls = unique(record.downloadUrls);
  record.dependencies = [
    ...new Map(record.dependencies.map((item) => [canonical(item), item])).values(),
  ];
  if (!record.sourcePath) {
    const publication = record.downloadUrls
      .map((value) => publicationPath(value, owner))
      .find(Boolean);
    if (publication) {
      record.sourcePath = publication.path;
      if (publication.ref) record.sourceRef = publication.ref;
      record.sourcePathEvidence = publication.evidence;
    }
  }
  if (owner?.toLowerCase() === 'ublockorigin/uassets' && record.sourcePath?.startsWith('filters/'))
    record.family ??= 'uAssets';
  return record;
}

export function importCatalog(
  source,
  raw,
  { snapshot = null, retrievedAt = new Date().toISOString() } = {},
) {
  const result = {
    source,
    records: [],
    errors: [],
    counts: {
      input: 0,
      records: 0,
      skipped: 0,
      invalid: 0,
      duplicates: 0,
      conflicts: 0,
      downloadUrls: 0,
      variants: 0,
      dependencies: 0,
      unknownOwners: 0,
      missingDownloadUrls: 0,
      complete: false,
    },
  };
  if (!['filterlists', 'ubo', 'adguard', 'manual'].includes(source)) {
    result.errors.push({
      source,
      code: 'unsupported-source',
      message: 'Supported catalogs are filterlists, ubo, adguard and manual.',
    });
    return result;
  }
  let rows;
  try {
    if (typeof retrievedAt !== 'string' || !Number.isFinite(Date.parse(retrievedAt)))
      throw failure('invalid-options', 'retrievedAt must be a dated observation.');
    const data = jsonValue(raw);
    if (source === 'ubo') {
      if (!object(data)) throw failure('invalid-source', 'The uBO source must be an asset map.');
      rows = Object.entries(data);
    } else {
      const values = Array.isArray(data)
        ? data
        : object(data) && Array.isArray(data.records)
          ? data.records
          : object(data) &&
              (data.id !== undefined || data.filterId !== undefined || data.metadata !== undefined)
            ? [data]
            : null;
      if (!values)
        throw failure('invalid-source', 'The source must be an array of catalog records.');
      rows = values.map((row, index) => [index, row]);
    }
  } catch (error) {
    result.errors.push({ source, code: error.code ?? 'invalid-source', message: error.message });
    return result;
  }
  const seen = new Map();
  result.counts.input = rows.length;
  for (const [index, input] of rows) {
    const report = (error) => result.errors.push({ source, index, ...error });
    try {
      const record = catalogRecord(source, input, index, { snapshot, retrievedAt }, report);
      if (!record) {
        result.counts.skipped += 1;
        continue;
      }
      if (seen.has(record.id)) {
        result.counts.duplicates += 1;
        if (canonical(seen.get(record.id).raw) !== canonical(record.raw)) {
          result.counts.conflicts += 1;
          report({
            code: 'conflicting-id',
            sourceKey: record.sourceKey,
            message: 'Conflicting records share a source ID; the first record is retained.',
          });
        }
      } else {
        seen.set(record.id, record);
        result.records.push(record);
      }
    } catch (error) {
      result.counts.invalid += 1;
      report({
        code: error.code ?? 'invalid-record',
        message: error.code
          ? error.message
          : 'A catalog record cannot be represented as source data.',
      });
    }
  }
  result.counts.records = result.records.length;
  result.counts.downloadUrls = unique(
    result.records.flatMap((record) => record.downloadUrls),
  ).length;
  result.counts.variants = result.records.reduce((sum, record) => sum + record.variants.length, 0);
  result.counts.dependencies = result.records.reduce(
    (sum, record) => sum + record.dependencies.length,
    0,
  );
  result.counts.unknownOwners = result.records.filter((record) => !record.owner).length;
  result.counts.missingDownloadUrls = result.records.filter(
    (record) => record.downloadUrls.length === 0,
  ).length;
  result.counts.complete = result.errors.length === 0;
  return result;
}

function observationError(error, context = {}) {
  return {
    ...context,
    code: error.code ?? 'network-error',
    message: error.message ?? 'Resource retrieval failed.',
    ...(error.provenance ? { provenance: error.provenance } : {}),
  };
}

function readScope(options, defaultRequests) {
  const budget = {
    limit: integer(options.maxRequests ?? defaultRequests, 'maxRequests', 0, 10000),
    requests: 0,
    bytes: 0,
    maxTotalBytes: integer(
      options.maxTotalBytes ?? 64 * 1024 * 1024,
      'maxTotalBytes',
      1,
      1024 * 1024 * 1024,
    ),
  };
  const stats = {
    successfulRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0,
    skippedRequests: 0,
    fetchedResources: 0,
    failedResources: 0,
    cancelledResources: 0,
    invalidResources: 0,
  };
  const errors = [];
  const provenance = [];
  const deferredOrigins = new Map();
  async function get(input, context = {}, asJson = true) {
    let fetched;
    try {
      const url = validatePublicUrl(input);
      if (options.signal?.aborted) throw failure('cancelled', 'Resource retrieval was cancelled.');
      if (budget.requests >= budget.limit)
        throw failure('request-budget', 'The HTTP request budget is exhausted.');
      if (budget.bytes >= budget.maxTotalBytes)
        throw failure('byte-budget', 'The total HTTP byte budget is exhausted.');
      if (deferredOrigins.has(url.origin))
        throw failure(
          'rate-limited',
          'Further requests to this origin are deferred after a rate-limit or Retry-After response.',
        );
      fetched = await fetchPublicBytes(url, { ...options, budget });
      stats.successfulRequests += fetched.provenance.requests;
      stats.fetchedResources += 1;
      const value = asJson ? jsonValue(fetched.body) : fetched.body;
      provenance.push({ ...context, state: 'retrieved', ...fetched.provenance });
      return { value, body: fetched.body, provenance: fetched.provenance };
    } catch (error) {
      if (fetched) {
        error.provenance = fetched.provenance;
        stats.invalidResources += 1;
      }
      const evidence = error.provenance;
      const completedRedirects = fetched ? 0 : (evidence?.redirects?.length ?? 0);
      const pendingRequests = fetched
        ? 0
        : Math.max(0, (evidence?.requests ?? 0) - completedRedirects);
      stats.successfulRequests += completedRedirects;
      const cancelled = error.code === 'cancelled' && pendingRequests > 0;
      const skipped =
        pendingRequests === 0 &&
        ['request-budget', 'byte-budget', 'cancelled', 'rate-limited'].includes(error.code);
      if (skipped) stats.skippedRequests += 1;
      else if (cancelled) stats.cancelledResources += 1;
      else stats.failedResources += 1;
      if (cancelled) stats.cancelledRequests += pendingRequests;
      else stats.failedRequests += pendingRequests;
      if (
        evidence &&
        (evidence.status === 429 ||
          (evidence.status === 403 && evidence.headers.rateLimitRemaining === '0') ||
          ([429, 503].includes(evidence.status) && evidence.headers.retryAfter))
      ) {
        deferredOrigins.set(new URL(evidence.finalUrl).origin, {
          retryAfter: evidence.headers.retryAfter ?? null,
          rateLimitReset: evidence.headers.rateLimitReset ?? null,
        });
      }
      const observation = observationError(error, context);
      errors.push(observation);
      provenance.push({
        ...context,
        state: skipped ? 'skipped' : cancelled ? 'cancelled' : 'failed',
        ...(evidence ?? {}),
        code: observation.code,
      });
      return null;
    }
  }
  return {
    get,
    errors,
    provenance,
    budget,
    stats,
    counts: () => ({
      requests: budget.requests,
      ...stats,
      bytes: budget.bytes,
      requestBudget: budget.limit,
      byteBudget: budget.maxTotalBytes,
      deferredOrigins: [...deferredOrigins].map(([origin, evidence]) => ({ origin, ...evidence })),
    }),
  };
}

async function mapBounded(values, concurrency, visit) {
  let next = 0;
  const results = new Array(values.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await visit(values[index], index);
      }
    }),
  );
  return results;
}

// Reproducible defaults are the source snapshots recorded in the canonical ecosystem research.
const catalogPins = {
  ubo: 'ec0d05341697d9e9bb5f701c130bea4bf3d8e269',
  adguard: '9411fe35873a0fed21ac99dddeff903e59ecffc1',
};

export async function discoverCatalog(source, options = {}) {
  if (!['filterlists', 'ubo', 'adguard', 'manual'].includes(source))
    return importCatalog(source, []);
  const reader = readScope(options, 128);
  const concurrency = integer(options.concurrency ?? 4, 'concurrency', 1, 8);
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  let snapshot =
    options.snapshot ??
    options.ref ??
    (options.url || options.metadataBaseUrl ? null : catalogPins[source]) ??
    null;
  let discovered = null;
  let enumerationComplete = false;
  let raw = source === 'ubo' ? {} : [];
  const unresolved = [];
  const sourceErrors = [];
  const summaryConflicts = [];
  const issue = (code, message, extra = {}) =>
    sourceErrors.push({ source, code, message, ...extra });
  const ref = options.ref ?? (typeof snapshot === 'string' ? snapshot : catalogPins[source]);
  const refPart =
    typeof ref === 'string' && ref.length <= 160 && !/[\s\u0000-\u001f\u007f]/.test(ref)
      ? encodeURIComponent(ref)
      : null;
  if (source === 'manual' && (options.raw !== undefined || options.records !== undefined)) {
    const result = importCatalog(source, options.raw ?? options.records, { snapshot, retrievedAt });
    return {
      ...result,
      counts: {
        ...result.counts,
        discovered: result.counts.input,
        unresolved: result.counts.invalid,
        enumerationComplete: true,
        ...reader.counts(),
      },
      provenance: [],
      unresolved: [],
    };
  }
  if (source === 'ubo') {
    if (!options.url && !refPart)
      issue('invalid-snapshot', 'A source revision is required for uBO discovery.');
    else {
      const fetched = await reader.get(
        options.url ??
          `https://raw.githubusercontent.com/gorhill/uBlock/${refPart}/assets/assets.json`,
        { source, stage: 'assets' },
      );
      if (fetched) {
        if (!object(fetched.value)) issue('invalid-source', 'The uBO source must be an asset map.');
        else {
          raw = fetched.value;
          discovered = Object.keys(raw).length;
          enumerationComplete = true;
          snapshot ??= { url: fetched.provenance.finalUrl, sha256: fetched.provenance.sha256 };
        }
      }
    }
  } else if (source === 'filterlists') {
    const endpoint = options.url ?? 'https://api.filterlists.com/lists';
    const fetched = await reader.get(endpoint, { source, stage: 'lists' });
    if (fetched) {
      if (!Array.isArray(fetched.value))
        issue('invalid-source', 'The FilterLists list endpoint must return an array.');
      else {
        raw = clone(fetched.value);
        discovered = raw.length;
        enumerationComplete = true;
        snapshot ??= { url: fetched.provenance.finalUrl, sha256: fetched.provenance.sha256 };
        if (/rel\s*=\s*["']?next\b/i.test(fetched.provenance.headers.link ?? '')) {
          enumerationComplete = false;
          issue(
            'source-truncated',
            'The response advertises another page; undocumented pagination was not followed.',
          );
        }
        const details = new Map();
        const summaries = new Map();
        for (let index = 0; index < raw.length; index += 1) {
          const row = raw[index];
          if (!object(row)) continue;
          let id;
          try {
            id = nativeKey(row.id, source);
          } catch {
            continue;
          }
          const first = summaries.get(id);
          if (!first) summaries.set(id, { index, row: clone(row) });
          else if (canonical(first.row) !== canonical(row))
            summaryConflicts.push({ id, index, firstIndex: first.index, row: clone(row) });
          if (Array.isArray(row.viewUrls)) continue;
          if (!details.has(id)) details.set(id, []);
          details.get(id).push(index);
        }
        await mapBounded([...details], concurrency, async ([id, indexes]) => {
          if (options.hydrate === false) {
            unresolved.push({ sourceKey: id, reason: 'detail-not-requested' });
            issue(
              'detail-not-requested',
              'Summary-only import leaves download and relationship details unknown.',
              { sourceKey: id },
            );
            return;
          }
          let base;
          try {
            base = validatePublicUrl(options.detailBaseUrl ?? fetched.provenance.finalUrl);
            base.pathname = `${base.pathname.replace(/\/$/, '')}/${id}`;
            base.search = '';
            base.hash = '';
          } catch {
            issue('unsafe-url', 'The detail endpoint is not a public HTTP(S) URL.', {
              sourceKey: id,
            });
            unresolved.push({ sourceKey: id, reason: 'unsafe-url' });
            return;
          }
          const detail = await reader.get(base, { source, stage: 'detail', sourceKey: id });
          if (!detail) {
            unresolved.push({ sourceKey: id, reason: 'detail-unavailable' });
            return;
          }
          if (
            !object(detail.value) ||
            String(detail.value.id) !== id ||
            !Array.isArray(detail.value.viewUrls)
          ) {
            issue(
              'invalid-detail',
              'The detail response must identify the requested list and supply viewUrls.',
              { sourceKey: id },
            );
            unresolved.push({ sourceKey: id, reason: 'invalid-detail' });
            return;
          }
          for (const index of indexes) raw[index] = { ...raw[index], ...clone(detail.value) };
        });
        // A summary digest alone does not identify the subsequently retrieved distribution and relationship data.
        snapshot = {
          sourceSnapshot: snapshot,
          contentSha256: sha256(canonical(raw)),
          method: 'hydrated-records-v1',
        };
      }
    }
  } else if (source === 'adguard') {
    if (!refPart)
      issue('invalid-snapshot', 'A registry revision is required for AdGuard discovery.');
    else {
      const fetched = await reader.get(
        options.url ??
          `https://api.github.com/repos/AdguardTeam/FiltersRegistry/git/trees/${refPart}?recursive=1`,
        { source, stage: 'tree' },
      );
      if (fetched) {
        if (!object(fetched.value) || !Array.isArray(fetched.value.tree))
          issue('invalid-source', 'The registry tree response must contain a tree array.');
        else {
          snapshot ??= {
            url: fetched.provenance.finalUrl,
            sha256: fetched.provenance.sha256,
            ...(!options.metadataBaseUrl ? { metadataRef: ref } : {}),
          };
          enumerationComplete = fetched.value.truncated === false;
          if (!enumerationComplete)
            issue(
              fetched.value.truncated === true ? 'source-truncated' : 'source-coverage-unknown',
              'Registry tree enumeration is not confirmed complete.',
            );
          const paths = [];
          for (const item of fetched.value.tree) {
            if (
              item?.type !== 'blob' ||
              typeof item.path !== 'string' ||
              !item.path.endsWith('/metadata.json')
            )
              continue;
            const path = /^(?:filter_\d+_|ThirdParty\/)/.test(item.path)
              ? `filters/${item.path}`
              : item.path;
            if (!path.startsWith('filters/')) continue;
            if (
              !sourcePath(path) ||
              !/^filters\/(?:ThirdParty\/)?filter_\d+_[^/]+\/metadata\.json$/.test(path)
            ) {
              issue('invalid-path', 'An enumerated metadata path is not a valid registry path.');
              unresolved.push({ reason: 'invalid-path' });
            } else paths.push(path);
          }
          discovered = paths.length + unresolved.length;
          const metadata = await mapBounded(unique(paths), concurrency, async (path) => {
            const id = /\/filter_(\d+)_/.exec(path)[1];
            const base =
              options.metadataBaseUrl ??
              `https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/${refPart}/`;
            let endpoint;
            try {
              endpoint = new URL(
                path.split('/').map(encodeURIComponent).join('/'),
                `${validatePublicUrl(base).href.replace(/\/$/, '')}/`,
              );
            } catch {
              issue('unsafe-url', 'The metadata base URL is not a public HTTP(S) URL.', {
                sourceKey: id,
              });
              unresolved.push({ path, sourceKey: id, reason: 'unsafe-url' });
              return null;
            }
            const detail = await reader.get(endpoint, {
              source,
              stage: 'metadata',
              path,
              sourceKey: id,
            });
            if (!detail) {
              unresolved.push({ path, sourceKey: id, reason: 'metadata-unavailable' });
              return null;
            }
            if (!object(detail.value) || String(detail.value.filterId) !== id) {
              issue('invalid-detail', 'Registry metadata must identify the enumerated filter.', {
                path,
                sourceKey: id,
              });
              unresolved.push({ path, sourceKey: id, reason: 'invalid-detail' });
              return null;
            }
            return { path, metadata: detail.value };
          });
          raw = metadata.filter(Boolean);
          if (paths.length !== unique(paths).length)
            issue(
              'duplicate-path',
              'The tree contains duplicate metadata paths; each path was requested once.',
            );
        }
      }
    }
  } else if (options.url) {
    const fetched = await reader.get(options.url, { source, stage: 'manual' });
    if (fetched) {
      raw = fetched.value;
      enumerationComplete = true;
      snapshot ??= { url: fetched.provenance.finalUrl, sha256: fetched.provenance.sha256 };
    }
  } else
    issue(
      'missing-source',
      'Manual discovery requires records, raw data or an explicit public JSON URL.',
    );
  const result = importCatalog(source, raw, { snapshot, retrievedAt });
  for (const conflict of summaryConflicts) {
    if (canonical(raw[conflict.index]) === canonical(raw[conflict.firstIndex])) {
      result.counts.conflicts += 1;
      issue(
        'conflicting-id',
        'Hydrated details do not erase conflicting summaries with the same source ID.',
        { sourceKey: conflict.id, index: conflict.index },
      );
    }
    const record = result.records.find((item) => item.sourceKey === conflict.id);
    if (record) (record.conflictingSummaries ??= []).push(conflict.row);
  }
  if (source === 'manual' && enumerationComplete) discovered = result.counts.input;
  result.errors.push(...sourceErrors, ...reader.errors);
  result.counts = {
    ...result.counts,
    discovered,
    unresolved: unresolved.length + result.counts.invalid,
    enumerationComplete,
    ...reader.counts(),
    concurrency,
    complete: enumerationComplete && result.errors.length === 0 && unresolved.length === 0,
  };
  return { ...result, provenance: reader.provenance, unresolved };
}

function lexicalFeed(body, contentType) {
  const digest = {
    sha256: sha256(body),
    semanticSha256: null,
    semanticMethod: 'ordered-lexical-v1',
  };
  const format = {
    state: 'unknown',
    method: 'lexical',
    ruleCount: 0,
    kinds: {},
    unknownLines: 0,
    directives: 0,
    comments: 0,
    headers: 0,
    metadata: {},
    limitations: ['Engine parsing, includes and compilation were not performed.'],
  };
  const invalid = (reason) => ({ format: { ...format, state: 'invalid', reason }, digest });
  if (body.length === 0) return invalid('empty-body');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/^\uFEFF/, '');
  } catch {
    return invalid('invalid-utf8');
  }
  if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? ''))
    return invalid('html-content-type');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return invalid('binary-body');
  if (/^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return invalid('json-body');
    } catch {
      /* Filter headers can start with a bracket. */
    }
  }
  const semantic = [];
  const domain = (value) =>
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(value) &&
    value.includes('.') &&
    !value.includes('..');
  const count = (kind) => {
    format.ruleCount += 1;
    format.kinds[kind] = (format.kinds[kind] ?? 0) + 1;
  };
  for (const original of text.split(/\r\n|\n|\r/)) {
    const line = original.trim();
    if (!line) continue;
    if (
      /^<(?:!doctype\s+html\b|\/?(?:html|head|body)(?:\s|>))/i.test(
        line.replace(/^(?:<!--.*?-->\s*)+/, ''),
      )
    )
      return invalid('html-body');
    if (
      /^!\s*(?:[#+@$[-])|^#(?:include|if(?:def|ndef)?|else|elif|endif)\b|^%include\b/i.test(line)
    ) {
      format.directives += 1;
      semantic.push(original);
      continue;
    }
    if (/^\[(?:Adblock(?: Plus)?|uBlock)(?:\s[^\]]*)?\]$/i.test(line)) {
      format.headers += 1;
      semantic.push(original);
      continue;
    }
    if (/^(?:[^#\s]+)?(?:#@?\??#|#@?\$\??#|#@?%#).+/.test(line)) {
      count('cosmetic-or-scriptlet');
    } else if (line.startsWith('!') || line.startsWith('#')) {
      format.comments += 1;
      const metadata =
        /^[!#]\s*(Title|Version|Expires|Last modified|Last updated|Homepage|License):\s*(.*)$/i.exec(
          line,
        );
      if (metadata) format.metadata[metadata[1].toLowerCase()] = metadata[2];
      continue;
    } else {
      const hostParts = line.replace(/\s+#.*$/, '').split(/\s+/);
      if (
        hostParts.length > 1 &&
        isIP(hostParts[0]) &&
        hostParts.slice(1).every((part) => domain(part) || /^[a-z0-9][a-z0-9-]*$/i.test(part))
      )
        count('hosts');
      else if (domain(line)) count('domain');
      else if (isIP(line)) count('ip');
      else if (/^(?:address|server|local)=\/[^\s]+\//i.test(line)) count('dnsmasq');
      else if (/^\$(?:TTL|ORIGIN)\b/i.test(line)) {
        format.directives += 1;
      } else if (
        /^(?:[a-z0-9*_.-]+\.[a-z0-9_.-]*|@)\s+(?:\d+\s+)?(?:IN\s+)?(?:CNAME|SOA|NS|A|AAAA)\s+\S/i.test(
          line,
        )
      )
        count('rpz');
      else if (
        /^(?:@@)?(?:\|\||\||\/|\*)[^<>]+/.test(line) ||
        (/^[^\s<>]+$/.test(line) &&
          (/[/$^*]/.test(line) || (format.headers > 0 && !line.startsWith('['))))
      )
        count(line.startsWith('@@') ? 'network-exception' : 'network');
      else format.unknownLines += 1;
    }
    // Keep rule order, exceptions, directives and unknown lines; never sort a list into a different program.
    semantic.push(original);
  }
  digest.semanticSha256 = sha256(semantic.join('\n'));
  if (format.unknownLines) {
    format.state = format.ruleCount > 0 ? 'partial' : 'invalid';
    format.reason = 'unrecognized-lines';
  } else if (format.ruleCount > 0) format.state = 'valid';
  else format.reason = format.directives ? 'unresolved-template' : 'no-rule-candidates';
  return { format, digest };
}

function feedGroups(record) {
  const groups = new Map();
  const listed = new Set();
  const keyFor = (value) => {
    try {
      const url = validatePublicUrl(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  };
  const add = (key, segmentNumber, candidate, roleKnown = true) => {
    if (!groups.has(key)) groups.set(key, { segmentNumber, roleKnown, candidates: [] });
    const group = groups.get(key);
    const identity = keyFor(candidate.url);
    if (!group.candidates.some((item) => keyFor(item.url) === identity))
      group.candidates.push(candidate);
    listed.add(identity);
  };
  const distributions = array(record?.variants).filter(
    (variant) => object(variant) && variant.kind === 'distribution',
  );
  for (const [index, variant] of distributions.entries()) {
    const segment =
      Number.isSafeInteger(variant.segmentNumber) && variant.segmentNumber > 0
        ? variant.segmentNumber
        : null;
    add(
      segment ?? `unknown-${index}`,
      segment,
      {
        url: variant.url ?? variant.advertisedUrl,
        role: variant.role ?? 'unknown',
        priority:
          variant.primariness ??
          (['original', 'primary', 'subscription'].includes(variant.role) ? 1 : 2),
      },
      segment !== null,
    );
  }
  const extra = array(record?.downloadUrls).filter((url) => !listed.has(keyFor(url)));
  for (const [index, url] of extra.entries())
    add(
      distributions.length ? 'unassigned' : 1,
      distributions.length ? null : 1,
      { url, role: index === 0 ? 'primary' : 'fallback', priority: index + 1 },
      distributions.length === 0,
    );
  for (const group of groups.values()) group.candidates.sort((a, b) => a.priority - b.priority);
  return [...groups.values()];
}

export async function checkFeed(record, options = {}) {
  const reader = readScope(options, 8);
  const groups = feedGroups(record);
  const attempts = [];
  const segments = [];
  const errors = [];
  const cache = new Map();
  let unusedUrls = 0;
  for (const group of groups) {
    const segment = {
      segmentNumber: group.segmentNumber,
      roleKnown: group.roleKnown,
      delivery: { state: 'unknown' },
      format: { state: 'unknown', method: 'lexical', ruleCount: 0 },
    };
    let selected;
    for (const [index, candidate] of group.candidates.entries()) {
      let url;
      try {
        const parsed = validatePublicUrl(candidate.url);
        parsed.hash = '';
        url = parsed.href;
      } catch {
        /* The reader records the rejected target without dispatch. */
      }
      let attempt = url ? cache.get(url) : null;
      if (!attempt) {
        const fetched = await reader.get(
          candidate.url,
          { stage: 'feed', segmentNumber: group.segmentNumber },
          false,
        );
        if (fetched) {
          const parsed = lexicalFeed(fetched.body, fetched.provenance.headers.contentType);
          attempt = {
            state: 'retrieved',
            url,
            role: candidate.role,
            provenance: fetched.provenance,
            ...parsed,
          };
          if (parsed.format.state === 'invalid' || parsed.format.state === 'partial')
            errors.push({
              code: 'invalid-feed',
              reason: parsed.format.reason,
              segmentNumber: group.segmentNumber,
              url,
            });
        } else {
          const error = reader.errors.at(-1);
          attempt = {
            state: reader.provenance.at(-1).state,
            ...(url ? { url } : {}),
            role: candidate.role,
            code: error.code,
            ...(error.provenance ? { provenance: error.provenance } : {}),
          };
        }
        if (url) cache.set(url, attempt);
        attempts.push({ segmentNumber: group.segmentNumber, ...attempt });
      }
      if (attempt.state === 'retrieved') {
        const quality = { invalid: 0, unknown: 1, partial: 2, valid: 3 };
        if (!selected || quality[attempt.format.state] > quality[selected.format.state])
          selected = attempt;
        if (attempt.format.state === 'valid') {
          selected = attempt;
          unusedUrls += group.candidates.length - index - 1;
          break;
        }
      } else if (attempt.state === 'failed') segment.delivery.state = 'unavailable';
    }
    if (selected) {
      segment.delivery = {
        state: 'available',
        url: selected.url,
        finalUrl: selected.provenance.finalUrl,
        role: selected.role,
      };
      segment.format = selected.format;
      segment.digest = selected.digest;
      segment.provenance = selected.provenance;
    }
    segments.push(segment);
  }
  const available = segments.filter((segment) => segment.delivery.state === 'available').length;
  const valid = segments.filter((segment) => segment.format.state === 'valid').length;
  const invalid = segments.filter((segment) => segment.format.state === 'invalid').length;
  const partial = segments.filter((segment) => segment.format.state === 'partial').length;
  const roleKnown = groups.every((group) => group.roleKnown);
  const deliveryState = !segments.length
    ? 'unknown'
    : available === segments.length
      ? 'available'
      : available
        ? 'partial'
        : segments.some((segment) => segment.delivery.state === 'unavailable')
          ? 'unavailable'
          : 'unknown';
  const formatState = !segments.length
    ? 'unknown'
    : valid === segments.length
      ? 'valid'
      : valid || partial
        ? 'partial'
        : invalid === segments.length
          ? 'invalid'
          : invalid
            ? 'partial'
            : 'unknown';
  return {
    recordId: record?.id ?? null,
    checkedAt: new Date().toISOString(),
    delivery: {
      state: deliveryState,
      scope: 'required-segments-with-mirror-fallback',
      segmentRolesKnown: roleKnown,
    },
    format: {
      state: formatState,
      method: 'lexical',
      ruleCount: segments.reduce((sum, segment) => sum + segment.format.ruleCount, 0),
    },
    compatibility: { state: 'unknown', reason: 'engine-compilation-not-performed' },
    effectiveness: { state: 'unknown', reason: 'runtime-effectiveness-not-measured' },
    segments,
    attempts,
    errors: [...errors, ...reader.errors],
    counts: {
      requiredSegments: segments.length,
      availableSegments: available,
      validSegments: valid,
      ...reader.counts(),
      skippedUrls: reader.stats.skippedRequests,
      unusedUrls,
      complete: segments.length > 0 && roleKnown && valid === segments.length,
    },
  };
}

const dated = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

export async function checkMaintenance(record, options = {}) {
  const reader = readScope(options, 2);
  const result = {
    recordId: record?.id ?? null,
    checkedAt: new Date().toISOString(),
    lifecycle: {
      deprecated: bool(record?.status?.deprecated),
      disabled: bool(record?.status?.disabled),
      archived: bool(record?.status?.archived),
      observedAt: record?.retrievedAt ?? null,
    },
    repository: { state: 'unknown', scope: 'repository' },
    path: { state: 'unknown', scope: 'list-path' },
    errors: [],
    unknowns: [
      'substantive-rule-change',
      'source-input-freshness',
      'compatibility',
      'installed-revision',
      'effectiveness',
    ],
  };
  const owner = record?.owner;
  if (!repositoryName(owner)) {
    result.unknowns.push('owner', 'list-path-activity');
    if (owner != null)
      result.errors.push({
        code: 'invalid-owner',
        message: 'Owner must be a GitHub owner/repository identifier.',
      });
  } else {
    const base = `https://api.github.com/repos/${owner}`;
    const repository = await reader.get(base, { stage: 'repository', owner });
    if (repository) {
      const value = repository.value;
      if (
        !object(value) ||
        !Number.isSafeInteger(value.id) ||
        value.id < 1 ||
        !repositoryName(value.full_name)
      ) {
        result.errors.push({
          code: 'invalid-repository',
          message: 'The repository response has no verifiable identity.',
          provenance: repository.provenance,
        });
      } else
        result.repository = {
          state: 'observed',
          scope: 'repository',
          requestedOwner: owner,
          id: value.id,
          fullName: value.full_name,
          archived: bool(value.archived),
          disabled: bool(value.disabled),
          pushedAt: dated(value.pushed_at),
          updatedAt: dated(value.updated_at),
          defaultBranch: typeof value.default_branch === 'string' ? value.default_branch : null,
          provenance: repository.provenance,
        };
    }
    if (!sourcePath(record?.sourcePath)) {
      result.unknowns.push('list-path', 'list-path-activity');
      if (record?.sourcePath != null)
        result.errors.push({
          code: 'invalid-path',
          message: 'The source path must be a relative list path.',
        });
    } else {
      const endpoint = new URL(`${base}/commits`);
      endpoint.searchParams.set('path', record.sourcePath);
      endpoint.searchParams.set('per_page', '1');
      const ref = options.ref ?? record.sourceRef;
      if (typeof ref === 'string' && ref) endpoint.searchParams.set('sha', ref);
      const history = await reader.get(endpoint, {
        stage: 'path-history',
        owner,
        path: record.sourcePath,
      });
      if (history) {
        if (
          !Array.isArray(history.value) ||
          (history.value.length &&
            (!object(history.value[0]) ||
              !/^[a-f0-9]{40,64}$/i.test(history.value[0].sha ?? '') ||
              !object(history.value[0].commit)))
        ) {
          result.errors.push({
            code: 'invalid-history',
            message: 'The path history response is malformed.',
            provenance: history.provenance,
          });
        } else {
          const latest = history.value[0];
          let url = null;
          try {
            if (latest?.html_url) url = validatePublicUrl(latest.html_url).href;
          } catch {
            /* The commit identity remains, without an unsafe link. */
          }
          result.path = {
            state: latest ? 'observed' : 'not-observed',
            scope: 'list-path',
            path: record.sourcePath,
            ref: ref ?? null,
            historyLimit: 1,
            historyComplete: false,
            latestCommit: latest
              ? {
                  sha: latest.sha,
                  url,
                  committedAt: dated(latest.commit.committer?.date),
                  authoredAt: dated(latest.commit.author?.date),
                  message: typeof latest.commit.message === 'string' ? latest.commit.message : null,
                  changeKind: 'unknown',
                }
              : null,
            provenance: history.provenance,
          };
        }
      }
      if (result.path.state === 'unknown') result.unknowns.push('list-path-activity');
    }
  }
  if (result.repository.state === 'unknown') result.unknowns.push('repository-state');
  result.errors.push(...reader.errors);
  result.unknowns = unique(result.unknowns);
  result.provenance = reader.provenance;
  result.counts = {
    ...reader.counts(),
    complete:
      result.repository.state === 'observed' &&
      result.path.state !== 'unknown' &&
      result.errors.length === 0,
  };
  return result;
}
