import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeScreenshot } from '../utils/png.ts';
import { pngBase64 } from './fixtures.ts';

test('PNG metadata is derived from image bytes, decoded before acceptance, and bitmap resources are closed', async () => {
  let closed = false;
  const image = await decodeScreenshot(`data:image/png;base64,${pngBase64}`, async (blob) => {
    assert.equal(blob.type, 'image/png');
    assert.equal(Buffer.from(await blob.arrayBuffer()).toString('base64'), pngBase64);
    return { width: 1, height: 1, close() { closed = true; } };
  });
  assert.deepEqual(image, { dataBase64: pngBase64, width: 1, height: 1 });
  assert.equal(closed, true);
});

test('decoder rejection or dimensions inconsistent with PNG header cannot become capture evidence', async () => {
  await assert.rejects(decodeScreenshot(`data:image/png;base64,${pngBase64}`, async () => {
    throw new Error('Invalid compressed image');
  }), /could not be decoded/);
  let closed = false;
  await assert.rejects(decodeScreenshot(`data:image/png;base64,${pngBase64}`, async () => ({
    width: 2, height: 1, close() { closed = true; },
  })), /could not be decoded/);
  assert.equal(closed, true);
});

test('malformed and oversized PNG headers are rejected before allocating the pixel decoder', async () => {
  const huge = Buffer.from(pngBase64, 'base64');
  huge.writeUInt32BE(32768, 16);
  huge.writeUInt32BE(32768, 20);
  for (const dataUrl of ['data:image/jpeg;base64,AAAA', 'data:image/png;base64,!!!!',
    'data:image/png;base64,YWJjZA==', `data:image/png;base64,${huge.toString('base64')}`]) {
    await assert.rejects(decodeScreenshot(dataUrl, async () => {
      assert.fail('Invalid input must be rejected before decoding');
    }));
  }
});
