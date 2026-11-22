import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { PNG } from 'pngjs';

export const CAPTURE_LIMITS = Object.freeze({
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 16 * 1024 * 1024,
  imagePixels: 24_000_000,
  totalPixels: 48_000_000,
  requestBytes: 24 * 1024 * 1024,
});

const text = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
const identifier = { ...text(96, 1), pattern: '^[A-Za-z0-9_-]+$' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = (maxItems, maxLength) => ({ type: 'array', maxItems, items: text(maxLength) });
const boolean = { type: 'boolean' };
const list = object({
  id: text(160, 1), name: text(300, 1), enabled: boolean, owner: text(200),
  version: text(160), source: text(2048),
}, ['id', 'name', 'enabled']);
const blocker = object({ id: text(128, 1), name: text(300), version: text(160), enabled: boolean }, ['id', 'name', 'version', 'enabled']);
const prerequisites = object(Object.fromEntries([
  'filtersCurrent', 'browserCurrent', 'productCurrent', 'isolated', 'breakageResolvedWhenDisabled',
].map(key => [key, boolean])));

export const captureSchema = object({
  schemaVersion: { const: 1 },
  id: { ...identifier, minLength: 8 },
  source: { enum: ['companion', 'audit'] },
  url: text(8192, 1), title: text(2000), capturedAt: text(40, 20),
  browser: object({ name: text(100, 1), version: text(160, 1), instance: text(160, 1) }, ['name', 'version']),
  tab: object({
    id: { type: 'integer', minimum: 0 }, windowId: { type: 'integer', minimum: 0 }, documentId: text(160, 1),
  }, ['id', 'windowId']),
  images: {
    type: 'array', minItems: 1, maxItems: 4,
    items: object({
      id: { ...identifier, not: { const: 'text' } }, mimeType: { const: 'image/png' },
      width: { type: 'integer', minimum: 1, maximum: 32768 },
      height: { type: 'integer', minimum: 1, maximum: 32768 },
      dataBase64: text(Math.ceil(CAPTURE_LIMITS.imageBytes / 3) * 4, 1),
    }, ['id', 'mimeType', 'width', 'height', 'dataBase64']),
  },
  text: text(100_000),
  context: object({
    condition: { enum: ['installed', 'adguard-on', 'adguard-off', 'adguard-restored'] },
    comparisonId: identifier,
    blockers: { type: 'array', maxItems: 200, items: blocker },
    lists: { type: 'array', maxItems: 500, items: list },
    pageState: { enum: ['usable', 'login-required', 'challenge', 'unknown'] },
    prerequisites,
    sensitivity: { enum: ['ordinary', 'nsfw', 'unknown'] },
  }),
  limitations: strings(100, 2000),
}, ['schemaVersion', 'id', 'source', 'url', 'title', 'capturedAt', 'browser', 'tab', 'images', 'text', 'context', 'limitations']);

const validate = new Ajv({ allErrors: false, strict: true }).compile(captureSchema);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_capture', status: 400 });
}

function validatePngStructure(bytes) {
  const depth = bytes[24];
  const color = bytes[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0) throw invalid('Unsupported PNG encoding');
  // pngjs bounds noninterlaced inflate by IHDR; interlacing or a replacement header bypasses that bound.
  if (bytes[28] !== 0) throw invalid('Interlaced PNGs are not supported');
  let paletteEntries = 0;
  let transparency = false;
  let gamma = false;
  let dataPhase = 0;
  let dataBytes = 0;
  for (let offset = 33; offset < bytes.length;) {
    if (bytes.length - offset < 12) throw invalid('PNG chunk is truncated');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw invalid('PNG chunk is truncated');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) throw invalid('PNG chunk type is invalid');
    if (type === 'IHDR') throw invalid('PNG must contain exactly one IHDR');
    if (type === 'IDAT') {
      if (dataPhase === 2 || (color === 3 && !paletteEntries)) throw invalid('PNG image data is out of order');
      dataPhase = 1;
      dataBytes += length;
    } else {
      if (dataPhase === 1) dataPhase = 2;
      if (type === 'PLTE') {
        if (paletteEntries || transparency || dataPhase || color === 0 || color === 4 || length < 3 || length > 768
            || length % 3 || (color === 3 && length / 3 > 2 ** depth)) throw invalid('PNG palette is invalid');
        paletteEntries = length / 3;
      } else if (type === 'tRNS') {
        if (transparency || dataPhase || !(color === 0 && length === 2 || color === 2 && length === 6
            || color === 3 && paletteEntries && length > 0 && length <= paletteEntries)) throw invalid('PNG transparency is invalid');
        transparency = true;
      } else if (type === 'gAMA') {
        if (gamma || paletteEntries || dataPhase || length !== 4) throw invalid('PNG gamma metadata is invalid');
        gamma = true;
      } else if (type === 'IEND') {
        if (length || !dataBytes || offset + 12 !== bytes.length) throw invalid('PNG must end after its image data with an empty IEND');
        return;
      } else if (!(bytes[offset + 4] & 0x20)) {
        throw invalid('PNG critical chunk is not supported');
      }
    }
    offset += length + 12;
  }
  throw invalid('PNG is missing IEND');
}

export function validateCapture(input) {
  if (!validate(input)) throw invalid(`Invalid capture field: ${validate.errors[0].instancePath || '/'}`);
  if (/[\u0000-\u0020\u007f]/u.test(input.url)) throw invalid('Capture URL contains whitespace or controls');
  let url;
  try { url = new URL(input.url); } catch { throw invalid('Capture URL is invalid'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw invalid('Capture URL must be HTTP(S) without credentials');
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(input.capturedAt);
  if (!date || !Number.isFinite(Date.parse(input.capturedAt))) throw invalid('Capture time must be an ISO timestamp');
  const [year, month, day] = date.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw invalid('Capture time has an invalid calendar date');
  }
  let totalBytes = 0;
  let totalPixels = 0;
  const ids = new Set();
  for (const image of input.images) {
    if (ids.has(image.id)) throw invalid('Image IDs must be unique within a capture');
    ids.add(image.id);
    if (image.dataBase64.length % 4) throw invalid('Image data is not canonical base64');
    const bytes = Buffer.from(image.dataBase64, 'base64');
    if (bytes.length > CAPTURE_LIMITS.imageBytes) throw invalid('Invalid image encoding or size');
    // Exact re-encoding also rejects ignored characters, alternate alphabets and nonzero padding bits.
    if (bytes.toString('base64') !== image.dataBase64) throw invalid('Image data is not canonical base64');
    totalBytes += bytes.length;
    if (totalBytes > CAPTURE_LIMITS.totalImageBytes) throw invalid('Capture exceeds image byte limit');
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.readUInt32BE(12) !== 0x49484452) {
      throw invalid('Image is not a PNG');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const pixels = width * height;
    totalPixels += pixels;
    // Check the untrusted header before the decoder allocates its pixel buffer.
    if (width !== image.width || height !== image.height || pixels > CAPTURE_LIMITS.imagePixels || totalPixels > CAPTURE_LIMITS.totalPixels) {
      throw invalid('PNG dimensions exceed limits or disagree with metadata');
    }
    validatePngStructure(bytes);
    try {
      const decoded = PNG.sync.read(bytes, { checkCRC: true });
      if (decoded.width !== width || decoded.height !== height) throw invalid('PNG dimensions disagree');
    } catch { throw invalid('PNG could not be decoded'); }
  }
  return structuredClone(input);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function captureDigest(capture) {
  return createHash('sha256').update(stableJson(capture)).digest('hex');
}
