import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { crc32, inflateRawSync } from 'node:zlib';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const has = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function failure(code, message, properties = {}) {
  return Object.assign(new Error(message), { code }, properties);
}

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? JSON.stringify(`[${typeof value}]`);
  }
  if (ancestors.has(value))
    throw failure('invalid-options', 'Corpus metadata must be acyclic JSON.');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => canonical(item, ancestors)).join(',')}]`
    : `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`)
        .join(',')}}`;
  ancestors.delete(value);
  return result;
}

function fingerprint(value) {
  try {
    return sha256(canonical(value));
  } catch {
    return sha256(Object.prototype.toString.call(value));
  }
}

function metadataCopy(value) {
  try {
    return JSON.parse(canonical(value));
  } catch {
    throw failure('invalid-options', 'Snapshot must be acyclic JSON metadata.');
  }
}

function checkLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw failure('invalid-options', 'Limit must be a nonnegative safe integer.');
  }
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
  const [first, second = '0'] = address.split(':');
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || '0', 16);
  // Global unicast only; exclude special-use, documentation and 6to4 prefixes.
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    a !== 0x2002 &&
    !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) &&
    !(a === 0x3fff && b < 0x1000)
  );
}

function publicUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw failure('invalid-url', 'A nonempty URL is required.');
  }
  const text = value.trim();
  if (/\s|[\u0000-\u001f\u007f\\]/u.test(text)) {
    throw failure('invalid-url', 'URLs must not contain whitespace, controls or backslashes.');
  }
  if (!/^https?:\/\/[^/?#]/i.test(text)) {
    throw failure('unsafe-url', 'Only absolute HTTP(S) URLs are allowed.');
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw failure('invalid-url', 'The URL is malformed.');
  }
  if (
    url.username ||
    url.password ||
    text
      .slice(text.indexOf('://') + 3)
      .split(/[/?#]/, 1)[0]
      .includes('@')
  ) {
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
      host.endsWith('.home.arpa') ||
      host === 'home.arpa'
    ) {
      throw failure('unsafe-url', 'Local and special-use hostnames are not allowed.');
    }
    if (
      host.length > 253 ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      throw failure('invalid-url', 'The hostname is malformed.');
    }
  }
  return url;
}

function domainUrl(domain) {
  if (typeof domain !== 'string' || !domain.trim() || /[\s/?#@\\%]/u.test(domain.trim())) {
    throw failure('invalid-domain', 'A domain must contain only a hostname.');
  }
  const trimmed = domain.trim();
  const text = isIP(trimmed) === 6 ? `[${trimmed}]` : trimmed;
  if (
    text.includes(':') &&
    !(text.startsWith('[') && text.endsWith(']') && isIP(text.slice(1, -1)) === 6)
  ) {
    throw failure('invalid-domain', 'A domain must not contain a scheme, port or path.');
  }
  return publicUrl(`https://${text}/`);
}

const hostname = (url) => url.hostname.replace(/^\[|\]$/g, '');

function normalizeRow(raw, ordinal) {
  let row = raw;
  if (typeof raw === 'string') {
    row = /^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? { url: raw } : { domain: raw };
  }
  if (!record(row)) throw failure('invalid-row', 'An entry must be a domain, URL or entry object.');
  const suppliedRank = has(row, 'rank') ? row.rank : ordinal;
  const rank =
    typeof suppliedRank === 'string' && /^\d+$/.test(suppliedRank.trim())
      ? Number(suppliedRank.trim())
      : suppliedRank;
  if (!Number.isSafeInteger(rank) || rank < 1)
    throw failure('invalid-rank', 'A rank must be a positive safe integer.');
  const hasDomain = has(row, 'domain') && row.domain !== '';
  const hasUrl = has(row, 'url') && row.url !== '';
  if (!hasDomain && !hasUrl)
    throw failure('invalid-row', 'An entry must supply a domain or absolute URL.');
  const fromDomain = hasDomain ? domainUrl(row.domain) : null;
  const url = hasUrl ? publicUrl(row.url) : fromDomain;
  if (fromDomain && hostname(fromDomain) !== hostname(url)) {
    throw failure('domain-mismatch', 'The supplied domain does not match the URL hostname.');
  }
  return { ordinal, rank, domain: hostname(url), url: url.href };
}

function* csvRecords(text) {
  let fields = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let started = false;
  let invalid = false;
  let line = 1;
  let firstLine = 1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    started = true;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
        if (char === '\n' || (char === '\r' && text[index + 1] !== '\n')) line += 1;
      }
      continue;
    }
    if (char === ',' || char === '\n' || char === '\r') {
      fields.push(field);
      field = '';
      afterQuote = false;
      if (char !== ',') {
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        yield { fields, line: firstLine, invalid };
        line += 1;
        firstLine = line;
        fields = [];
        invalid = false;
        started = false;
      }
    } else if (char === '"' && field === '' && !afterQuote) {
      quoted = true;
    } else {
      if (char === '"' || afterQuote) invalid = true;
      field += char;
    }
  }
  if (started) yield { fields: [...fields, field], line: firstLine, invalid: invalid || quoted };
}

function csvRows(text, limit) {
  const iterator = csvRecords(text);
  const first = iterator.next();
  if (first.done) return { rows: [] };
  const names = first.value.fields.map((field) => field.trim().toLowerCase());
  // Data such as `1,domain` still occupies a slot; headers contain only labels.
  const hasHeader =
    (names.includes('domain') || names.includes('url')) &&
    names.every((name) => name === '' || /^[a-z_][a-z0-9 _-]*$/.test(name));
  if (
    hasHeader &&
    (first.value.invalid ||
      (!names.includes('domain') && !names.includes('url')) ||
      names.some((name) => !name) ||
      new Set(names).size !== names.length)
  ) {
    return {
      rows: [],
      error: {
        code: 'invalid-csv-header',
        message: 'CSV headers must name an unambiguous domain or URL column.',
        line: 1,
      },
    };
  }
  const rows = [];
  let current = hasHeader ? iterator.next() : first;
  while (!current.done && rows.length < limit) {
    const item = current.value;
    const fields = item.fields.map((field) => field.trim());
    const raw = {};
    if (hasHeader) {
      for (const name of ['rank', 'domain', 'url']) {
        const index = names.indexOf(name);
        if (index !== -1 && (name === 'rank' || fields[index] !== '')) raw[name] = fields[index];
      }
    } else {
      raw.rank = fields[0];
      raw.domain = fields[1];
    }
    rows.push({
      raw,
      line: item.line,
      invalid: item.invalid || fields.length !== (hasHeader ? names.length : 2),
      fingerprint: fingerprint(item.fields),
    });
    if (rows.length < limit) current = iterator.next();
  }
  return { rows };
}

export function parseCorpus(input, { format, limit = 300, source, snapshot } = {}) {
  checkLimit(limit);
  if (format !== undefined && format !== 'json' && format !== 'csv') {
    throw failure('invalid-options', 'Format must be json or csv.');
  }
  let data = input;
  let documentError;
  if (input instanceof Uint8Array) {
    try {
      data = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      documentError = { code: 'invalid-encoding', message: 'Corpus bytes must be valid UTF-8.' };
    }
  }
  if (typeof data === 'string') data = data.replace(/^\uFEFF/, '');
  const selectedFormat =
    format ?? (typeof data !== 'string' || /^[\s]*[[{]/.test(data) ? 'json' : 'csv');
  let rows = [];
  let envelope;
  if (!documentError && selectedFormat === 'json') {
    try {
      if (typeof data === 'string') data = JSON.parse(data);
      if (record(data) && Array.isArray(data.entries)) envelope = data;
      const entries = envelope ? envelope.entries : data;
      if (!Array.isArray(entries)) throw new Error('Not an entries array.');
      rows = Array.from(entries.slice(0, limit), (raw) => ({ raw }));
    } catch {
      documentError = {
        code: 'invalid-json',
        message: 'JSON must be an array or an object containing an entries array.',
      };
    }
  } else if (!documentError) {
    if (typeof data !== 'string') {
      documentError = { code: 'invalid-csv', message: 'CSV input must be text or UTF-8 bytes.' };
    } else {
      const csv = csvRows(data, limit);
      rows = csv.rows;
      documentError = csv.error;
    }
  }
  source ??= envelope?.source ?? 'manual';
  if (typeof source !== 'string' || !source.trim() || /[\u0000-\u001f\u007f]/.test(source)) {
    throw failure('invalid-options', 'Source must be a nonempty text identifier.');
  }
  snapshot = metadataCopy(snapshot === undefined ? (envelope?.snapshot ?? null) : snapshot);
  const context = { schemaVersion: 1, source, snapshot };
  const attempts = rows.map((item, index) => {
    const ordinal = index + 1;
    const rank = record(item.raw) && has(item.raw, 'rank') ? item.raw.rank : ordinal;
    try {
      if (item.invalid)
        throw failure(
          'invalid-csv',
          'CSV record has malformed quoting or the wrong number of columns.',
        );
      return { identity: normalizeRow(item.raw, ordinal) };
    } catch (error) {
      const identity = {
        ordinal,
        rank,
        code: error.code ?? 'invalid-row',
        inputDigest: item.fingerprint ?? fingerprint(item.raw),
      };
      return {
        identity,
        error: {
          ordinal,
          rank,
          code: identity.code,
          message: error.message,
          excluded: true,
          ...(item.line === undefined ? {} : { line: item.line }),
        },
      };
    }
  });
  const documentIdentity = documentError
    ? { code: documentError.code, inputDigest: fingerprint(input) }
    : null;
  const id = `corpus-${sha256(canonical({ ...context, rows: attempts.map((attempt) => attempt.identity), document: documentIdentity }))}`;
  const entries = [];
  const errors = documentError ? [{ id, ...documentError, excluded: true }] : [];
  const urls = new Map();
  const domains = new Map();
  const ranks = new Map();
  for (const attempt of attempts) {
    const entryId = `entry-${sha256(canonical({ ...context, entry: attempt.identity }))}`;
    if (attempt.error) {
      errors.push({ id: entryId, ...attempt.error });
      continue;
    }
    const entry = { id: entryId, ...attempt.identity };
    entries.push(entry);
    const duplicate = (code, previous) =>
      errors.push({
        id: entry.id,
        ordinal: entry.ordinal,
        rank: entry.rank,
        code,
        duplicateOf: previous.id,
        excluded: false,
      });
    if (urls.has(entry.url)) duplicate('duplicate-url', urls.get(entry.url));
    else if (domains.has(entry.domain)) duplicate('duplicate-domain', domains.get(entry.domain));
    if (ranks.has(entry.rank)) duplicate('duplicate-rank', ranks.get(entry.rank));
    if (!urls.has(entry.url)) urls.set(entry.url, entry);
    if (!domains.has(entry.domain)) domains.set(entry.domain, entry);
    if (!ranks.has(entry.rank)) ranks.set(entry.rank, entry);
  }
  return { ...context, id, entries, errors };
}

function archiveCsv(bytes, maxBytes) {
  const bad = () =>
    failure('invalid-tranco-archive', 'Expected an intact, single-file CSV ZIP archive.');
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 22 - 65535);
    offset -= 1
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== 1 ||
    bytes.readUInt16LE(end + 10) !== 1
  )
    throw bad();
  const centralSize = bytes.readUInt32LE(end + 12);
  const central = bytes.readUInt32LE(end + 16);
  if (
    central + centralSize !== end ||
    centralSize < 46 ||
    central + 46 > end ||
    bytes.readUInt32LE(central) !== 0x02014b50
  )
    throw bad();
  const flags = bytes.readUInt16LE(central + 8);
  const method = bytes.readUInt16LE(central + 10);
  const crc = bytes.readUInt32LE(central + 16);
  const compressedSize = bytes.readUInt32LE(central + 20);
  const size = bytes.readUInt32LE(central + 24);
  const nameSize = bytes.readUInt16LE(central + 28);
  const extraSize = bytes.readUInt16LE(central + 30);
  const commentSize = bytes.readUInt16LE(central + 32);
  if (size > maxBytes)
    throw failure('too-large', 'Uncompressed Tranco data exceeds the byte budget.');
  if (
    (flags & ~0x080e) !== 0 ||
    ![0, 8].includes(method) ||
    compressedSize === 0xffffffff ||
    bytes.readUInt16LE(central + 34) !== 0 ||
    bytes.readUInt32LE(central + 42) !== 0 ||
    central + 46 + nameSize + extraSize + commentSize !== end
  )
    throw bad();
  const nameBytes = bytes.subarray(central + 46, central + 46 + nameSize);
  const name = nameBytes.toString('utf8');
  if (
    !/^[a-z0-9][a-z0-9._-]*\.csv$/i.test(name) ||
    central < 30 ||
    bytes.readUInt32LE(0) !== 0x04034b50 ||
    bytes.readUInt16LE(6) !== flags ||
    bytes.readUInt16LE(8) !== method ||
    bytes.readUInt16LE(26) !== nameSize
  )
    throw bad();
  const start = 30 + nameSize + bytes.readUInt16LE(28);
  const dataEnd = start + compressedSize;
  if (start > central || dataEnd > central || !bytes.subarray(30, 30 + nameSize).equals(nameBytes))
    throw bad();
  if (flags & 8) {
    let descriptor = dataEnd;
    if (descriptor + 4 <= central && bytes.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
    if (
      descriptor + 12 !== central ||
      bytes.readUInt32LE(descriptor) !== crc ||
      bytes.readUInt32LE(descriptor + 4) !== compressedSize ||
      bytes.readUInt32LE(descriptor + 8) !== size
    )
      throw bad();
  } else if (
    dataEnd !== central ||
    bytes.readUInt32LE(14) !== crc ||
    bytes.readUInt32LE(18) !== compressedSize ||
    bytes.readUInt32LE(22) !== size
  )
    throw bad();
  const compressed = bytes.subarray(start, dataEnd);
  let body;
  try {
    if (method === 0) body = compressed;
    else {
      const inflated = inflateRawSync(compressed, { maxOutputLength: maxBytes, info: true });
      if (inflated.engine.bytesWritten !== compressedSize) throw bad();
      body = inflated.buffer;
    }
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE')
      throw failure('too-large', 'Uncompressed Tranco data exceeds the byte budget.');
    throw bad();
  }
  if (body.length > maxBytes)
    throw failure('too-large', 'Uncompressed Tranco data exceeds the byte budget.');
  if (body.length !== size || crc32(body) !== crc) throw bad();
  return {
    body,
    provenance: {
      entry: name,
      compression: method === 0 ? 'stored' : 'deflate',
      uncompressedBytes: body.length,
      sha256: sha256(body),
    },
  };
}

function fixedDownload(value, listId) {
  try {
    const url = publicUrl(value instanceof URL ? value.href : value);
    const match = /^\/download\/([a-z0-9]+)(?:\/(?:[1-9]\d*|full))?\/?$/i.exec(url.pathname);
    if (
      url.origin !== 'https://tranco-list.eu' ||
      url.search ||
      url.hash ||
      match?.[1].toUpperCase() !== listId
    )
      throw new Error();
    return url.href;
  } catch {
    throw failure(
      'invalid-tranco-download',
      'Tranco metadata must supply an HTTPS download URL for the requested fixed list ID.',
    );
  }
}

// Fixed list 46YVX delivered a 22,678,162-byte CSV; daily-list downloads need a larger bounded budget.
export async function fetchTrancoCorpus(
  listId,
  {
    limit = 300,
    fetchImpl,
    signal,
    timeoutMs = 30000,
    maxBytes = 32 * 1024 * 1024,
    maxRedirects = 5,
    maxUncompressedBytes = 64 * 1024 * 1024,
    lookupImpl,
  } = {},
) {
  if (
    typeof listId !== 'string' ||
    !/^[a-z0-9]{4,64}$/i.test(listId) ||
    /^(?:latest|current|default)$/i.test(listId)
  ) {
    throw failure('invalid-tranco-id', 'A fixed Tranco list ID is required.');
  }
  listId = listId.toUpperCase();
  checkLimit(limit);
  if (
    ![timeoutMs, maxBytes, maxUncompressedBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !Number.isSafeInteger(maxRedirects) ||
    maxRedirects < 0
  ) {
    throw failure(
      'invalid-options',
      'Network and decompression budgets must be positive safe integers; redirects must be nonnegative.',
    );
  }
  // The API's download field is authoritative; never derive a moving latest-list URL.
  // Endpoint and response fields: https://tranco-list.eu/api_documentation
  const metadataUrl = `https://tranco-list.eu/api/lists/id/${listId}`;
  const provenance = {};
  let stage = 'metadata';
  let requestedUrl = metadataUrl;
  try {
    const { fetchPublicBytes } = await import('./catalog.mjs');
    async function retrieve(url, validateUrl) {
      const resource = await fetchPublicBytes(url, {
        fetchImpl,
        signal,
        timeoutMs,
        maxBytes,
        maxRedirects,
        lookupImpl,
        validateUrl,
      });
      const body = resource.body;
      if (!(body instanceof Uint8Array))
        throw failure(
          'invalid-transport-response',
          'Public retrieval did not return response bytes.',
        );
      const bytes = Buffer.from(body);
      const evidence = {
        ...resource.provenance,
        requestedUrl: url,
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
      provenance[stage] = evidence;
      if (evidence.status < 200 || evidence.status >= 300) {
        throw failure('http-error', 'Tranco retrieval returned a non-success HTTP status.', {
          status: evidence.status,
        });
      }
      return { bytes, evidence };
    }
    const validateMetadataUrl = (value) => {
      if (String(value).replace(/\/$/, '') !== metadataUrl) {
        throw failure(
          'invalid-tranco-metadata',
          'Metadata retrieval must remain on the requested fixed list endpoint.',
        );
      }
    };
    const result = await retrieve(metadataUrl, validateMetadataUrl);
    validateMetadataUrl(result.evidence.finalUrl);
    let metadata;
    try {
      metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes));
    } catch {
      throw failure('invalid-tranco-metadata', 'Tranco metadata must be valid UTF-8 JSON.');
    }
    if (
      !record(metadata) ||
      typeof metadata.list_id !== 'string' ||
      metadata.list_id.toUpperCase() !== listId ||
      typeof metadata.available !== 'boolean' ||
      typeof metadata.failed !== 'boolean'
    ) {
      throw failure(
        'invalid-tranco-metadata',
        'Tranco metadata does not identify the requested list and availability.',
      );
    }
    if (!metadata.available || metadata.failed)
      throw failure('tranco-unavailable', 'The requested Tranco list is not available.');
    if (
      !record(metadata.configuration) ||
      typeof metadata.created_on !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(
        metadata.created_on,
      ) ||
      !Number.isFinite(Date.parse(metadata.created_on))
    ) {
      throw failure(
        'invalid-tranco-metadata',
        'Tranco metadata is missing its creation time or configuration.',
      );
    }
    requestedUrl = fixedDownload(metadata.download, listId);
    stage = 'download';
    const download = await retrieve(requestedUrl, (value) => fixedDownload(value, listId));
    fixedDownload(download.evidence.finalUrl, listId);
    const isZip =
      download.bytes.length >= 4 &&
      [0x04034b50, 0x06054b50].includes(download.bytes.readUInt32LE(0));
    let csv = download.bytes;
    if (
      isZip ||
      /(?:application\/zip|application\/x-zip)/i.test(download.evidence.headers?.contentType ?? '')
    ) {
      const archive = archiveCsv(csv, maxUncompressedBytes);
      csv = archive.body;
      provenance.archive = archive.provenance;
    } else if (csv.length > maxUncompressedBytes) {
      throw failure('too-large', 'Uncompressed Tranco data exceeds the byte budget.');
    }
    const snapshot = {
      listId,
      createdOn: metadata.created_on,
      configuration: metadata.configuration,
      sha256: sha256(csv),
    };
    return {
      ...parseCorpus(csv, { format: 'csv', limit, source: 'tranco', snapshot }),
      provenance,
    };
  } catch (error) {
    error.provenance = { ...error.provenance, listId, stage, requestedUrl, ...provenance };
    throw error;
  }
}
