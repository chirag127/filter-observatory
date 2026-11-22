import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { CAPTURE_LIMITS, captureDigest, validateCapture } from '../src/capture.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

function pngChunk(type, data = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function pngHeader({ width = 1, height = 1, depth = 8, color = 6, interlace = 0 } = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data[8] = depth; data[9] = color; data[12] = interlace;
  return pngChunk('IHDR', data);
}

const pngBytes = (...chunks) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
const pixelData = () => pngChunk('IDAT', deflateSync(Buffer.from([0, 18, 52, 86, 255])));
function captureFromPng(bytes, width = 1, height = 1) {
  const capture = captureFixture();
  capture.images[0] = { ...capture.images[0], width, height, dataBase64: bytes.toString('base64') };
  return capture;
}

test('validated capture retains real PNG bytes and does not mutate its caller', () => {
  const input = captureFixture();
  const before = structuredClone(input);
  const result = validateCapture(input);
  assert.deepEqual(result, before);
  result.context.sensitivity = 'ordinary';
  assert.deepEqual(input, before);
});

test('image dimensions, data and identifiers are checked before persistence', () => {
  const cases = [
    c => { c.images[0].width = 4; },
    c => { c.images[0].dataBase64 = 'bm90IGEgcG5n'; },
    c => { c.images[0].dataBase64 += '!'; },
    c => { c.images[0].id = '../outside'; },
    c => { c.id = '../../escape'; },
    c => { c.images.push({ ...c.images[0] }); },
    c => { c.images[0].path = 'C:/private.txt'; },
    c => { c.images[0].width = 0; },
    c => { c.images = []; },
    c => { c.capturedAt = 'yesterday'; },
    c => { c.context.prerequisites = { isolated: 'yes' }; },
  ];
  for (const mutate of cases) {
    const capture = captureFixture();
    mutate(capture);
    assert.throws(() => validateCapture(capture), { code: 'invalid_capture' });
  }
});

test('the text evidence ID cannot be assigned to an image', () => {
  for (const source of ['companion', 'audit']) {
    for (const text of ['', 'Captured page text']) {
      const capture = captureFixture({ source, text });
      capture.images[0].id = 'text';
      assert.throws(() => validateCapture(capture), { code: 'invalid_capture', status: 400 });
    }
  }
});

test('ordinary image IDs retain exact spelling alongside captured text', () => {
  for (const id of ['viewport', 'Text', 'TEXT', 'text-viewport', 'text_1']) {
    const capture = captureFixture();
    capture.images[0].id = id;
    assert.deepEqual(validateCapture(capture), capture);
  }
});

test('URL validation rejects non-web schemes, embedded credentials and control characters', () => {
  for (const url of ['file:///C:/private.txt', 'javascript:alert(1)', 'https://user:secret@example.com/', 'https://example.com/\nsecret']) {
    assert.throws(() => validateCapture(captureFixture({ url })), { code: 'invalid_capture' });
  }
});

test('PNG header pixel limits are enforced before decoding a potential allocation bomb', () => {
  const capture = captureFixture();
  const bytes = Buffer.from(capture.images[0].dataBase64, 'base64');
  bytes.writeUInt32BE(65535, 16);
  bytes.writeUInt32BE(65535, 20);
  capture.images[0] = { ...capture.images[0], width: 65535, height: 65535, dataBase64: bytes.toString('base64') };
  assert.throws(() => validateCapture(capture), { code: 'invalid_capture' });
});

test('capture identity is invariant to object-key order but sensitive to evidence changes', () => {
  const capture = captureFixture();
  const digest = captureDigest(capture);
  const keys = Object.keys(capture);
  for (let offset = 0; offset < keys.length; offset++) {
    const reordered = Object.fromEntries([...keys.slice(offset), ...keys.slice(0, offset)].map(key => [key, capture[key]]));
    reordered.browser = { version: capture.browser.version, name: capture.browser.name };
    assert.equal(captureDigest(reordered), digest);
  }
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(captureDigest({ ...capture, text: 'Different observation' }), digest);
});

test('a multi-megabyte screenshot within the byte and pixel limits is accepted unchanged', () => {
  const width = 1500, height = 1000;
  const data = Buffer.alloc(width * height * 4);
  let seed = 0x12345678;
  for (let offset = 0; offset < data.length; offset += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    data[offset] = seed; data[offset + 1] = seed >>> 8; data[offset + 2] = seed >>> 16; data[offset + 3] = 255;
  }
  const bytes = PNG.sync.write({ width, height, data }, { deflateLevel: 0, filterType: 0 });
  assert.ok(bytes.length > 6_000_000 && bytes.length < CAPTURE_LIMITS.imageBytes);
  assert.ok(width * height < CAPTURE_LIMITS.imagePixels);
  const input = captureFromPng(bytes, width, height);
  const result = validateCapture(input);
  assert.equal(result.images[0].dataBase64, input.images[0].dataBase64);
  assert.deepEqual(PNG.sync.read(bytes).data, data);
});

test('noncanonical base64, including nonzero padding bits, is rejected before PNG decoding', t => {
  const read = t.mock.method(PNG.sync, 'read');
  const original = captureFixture().images[0].dataBase64;
  const invalid = [original + '\n', '!' + original.slice(1), '_' + original.slice(1),
    original.slice(0, 4) + '=' + original.slice(5), original.slice(0, -1)];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let length = 0; length < 3; length++) {
    const bytes = pngBytes(pngHeader(), pngChunk('tEXt', Buffer.from(`note\0${'x'.repeat(length)}`)), pixelData(), pngChunk('IEND'));
    const canonical = bytes.toString('base64');
    const padding = canonical.indexOf('=');
    if (padding < 0) continue;
    const index = padding - 1;
    const changed = canonical.slice(0, index) + alphabet[alphabet.indexOf(canonical[index]) | 1] + canonical.slice(index + 1);
    assert.deepEqual(Buffer.from(changed, 'base64'), bytes);
    invalid.push(changed);
  }
  for (const dataBase64 of invalid) {
    const capture = captureFixture(); capture.images[0].dataBase64 = dataBase64;
    assert.throws(() => validateCapture(capture), { code: 'invalid_capture', status: 400 });
  }
  assert.equal(read.mock.callCount(), 0);
});

test('a second IHDR cannot change allocation dimensions before rejection', t => {
  const read = t.mock.method(PNG.sync, 'read');
  const bytes = pngBytes(pngHeader(), pngHeader({ width: 16, height: 16 }),
    pngChunk('IDAT', deflateSync(Buffer.alloc((16 * 4 + 1) * 16))), pngChunk('IEND'));
  assert.throws(() => validateCapture(captureFromPng(bytes)), { code: 'invalid_capture', status: 400 });
  assert.equal(read.mock.callCount(), 0);
});

for (const [name, raw] of [
  ['valid one-pixel image', Buffer.from([0, 18, 52, 86, 255])],
  ['one-pixel header with a bounded 1 MiB inflated payload', Buffer.alloc(1024 * 1024)],
]) {
  test(`interlacing is explicitly unsupported before decoding: ${name}`, t => {
    const read = t.mock.method(PNG.sync, 'read');
    const bytes = pngBytes(pngHeader({ interlace: 1 }), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND'));
    assert.throws(() => validateCapture(captureFromPng(bytes)),
      { code: 'invalid_capture', status: 400, message: /interlac.*not supported/i });
    assert.equal(read.mock.callCount(), 0);
  });
}

const compressedPixel = deflateSync(Buffer.from([0, 18, 52, 86, 255]));
for (const [name, chunks] of [
  ['duplicate identical IHDR', [pngHeader(), pngHeader(), pixelData(), pngChunk('IEND')]],
  ['missing IDAT', [pngHeader(), pngChunk('IEND')]],
  ['missing IEND', [pngHeader(), pixelData()]],
  ['nonempty IEND', [pngHeader(), pixelData(), pngChunk('IEND', Buffer.from([0]))]],
  ['trailing bytes', [pngHeader(), pixelData(), pngChunk('IEND'), Buffer.from([0])]],
  ['truncated chunk', [pngHeader(), pixelData().subarray(0, -1)]],
  ['nonconsecutive IDAT', [pngHeader(), pngChunk('IDAT', compressedPixel.subarray(0, 3)),
    pngChunk('tEXt', Buffer.from('note\0split')), pngChunk('IDAT', compressedPixel.subarray(3)), pngChunk('IEND')]],
  ['unknown critical chunk', [pngHeader(), pngChunk('ABCD'), pixelData(), pngChunk('IEND')]],
  ['invalid RGBA bit depth', [pngHeader({ depth: 1 }), pixelData(), pngChunk('IEND')]],
  ['oversized palette', [pngHeader({ color: 3 }), pngChunk('PLTE', Buffer.alloc(257 * 3)),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0]))), pngChunk('IEND')]],
  ['duplicate palette', [pngHeader({ color: 3 }), pngChunk('PLTE', Buffer.from([255, 0, 0])),
    pngChunk('PLTE', Buffer.from([0, 255, 0])), pngChunk('IDAT', deflateSync(Buffer.from([0, 0]))), pngChunk('IEND')]],
  ['invalid transparency length', [pngHeader({ color: 2 }), pngChunk('tRNS', Buffer.alloc(7)),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 18, 52, 86]))), pngChunk('IEND')]],
  ['oversized gamma metadata', [pngHeader(), pngChunk('gAMA', Buffer.alloc(8)), pixelData(), pngChunk('IEND')]],
]) {
  test(`PNG structure is checked before decoding: ${name}`, t => {
    const read = t.mock.method(PNG.sync, 'read');
    assert.throws(() => validateCapture(captureFromPng(pngBytes(...chunks))), { code: 'invalid_capture', status: 400 });
    assert.equal(read.mock.callCount(), 0);
  });
}

test('noninterlaced palettes, transparency, metadata and consecutive IDAT chunks remain supported', () => {
  const compressed = deflateSync(Buffer.from([0, 0]));
  const bytes = pngBytes(pngHeader({ depth: 1, color: 3 }), pngChunk('gAMA', Buffer.from([0, 0, 177, 143])),
    pngChunk('PLTE', Buffer.from([18, 52, 86])), pngChunk('tRNS', Buffer.from([128])),
    pngChunk('tEXt', Buffer.from('note\0fixture')), pngChunk('IDAT', compressed.subarray(0, 3)),
    pngChunk('IDAT'), pngChunk('IDAT', compressed.subarray(3)), pngChunk('IEND'));
  const capture = captureFromPng(bytes);
  assert.deepEqual(validateCapture(capture), capture);
  assert.deepEqual([...PNG.sync.read(bytes).data], [18, 52, 86, 128]);
});

test('CRC and scanline corruption remain decode errors', () => {
  const badCrc = pixelData(); badCrc[badCrc.length - 1] ^= 1;
  for (const data of [badCrc, pngChunk('IDAT', deflateSync(Buffer.from([5, 18, 52, 86, 255])))]) {
    const capture = captureFromPng(pngBytes(pngHeader(), data, pngChunk('IEND')));
    assert.throws(() => validateCapture(capture), { code: 'invalid_capture', status: 400 });
  }
});
