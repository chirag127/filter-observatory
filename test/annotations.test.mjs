import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  effectiveContext,
  imagePublicationKey,
  sanitizedImage,
  validateAnnotations,
} from '../src/annotations.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

const note = () => ({
  source: 'Operator checked browser settings',
  observedAt: '2026-11-21T16:00:00.000Z',
  context: {
    privacyChecked: true,
    sensitivity: 'ordinary',
    os: { name: 'Windows', version: '11' },
  },
  images: [
    {
      id: 'viewport',
      sensitivity: 'ordinary',
      sanitized: true,
      redactions: [{ x: 0, y: 0, width: 1, height: 1 }],
    },
  ],
});

test('annotations cannot replace captured URL, pixels or readback-confirmed isolation', () => {
  const capture = captureFixture({
    context: { prerequisites: { isolated: false }, sensitivity: 'nsfw' },
  });
  const input = note();
  input.context.prerequisites = { isolated: true, filtersCurrent: true };
  const validated = validateAnnotations(input, capture);
  const context = effectiveContext(capture, validated);
  assert.equal(context.prerequisites.isolated, false);
  assert.equal(context.prerequisites.filtersCurrent, true);
  assert.equal(context.sensitivity, 'nsfw');
  assert.equal(context.annotationSource, input.source);
  assert.throws(
    () => validateAnnotations({ ...input, url: 'https://different.example/' }, capture),
    { code: 'invalid_annotations' },
  );
  assert.throws(
    () =>
      validateAnnotations(
        { ...input, images: [{ ...input.images[0], dataBase64: 'replace' }] },
        capture,
      ),
    { code: 'invalid_annotations' },
  );
});

test('invalid masks, duplicate images and unchecked public evidence are rejected', () => {
  for (const mutate of [
    (n) => {
      n.images[0].redactions[0].width = 4;
    },
    (n) => {
      n.images[0].redactions[0].x = -1;
    },
    (n) => {
      n.images[0].id = 'missing';
    },
    (n) => {
      n.images.push({ ...n.images[0] });
    },
    (n) => {
      n.context.privacyChecked = false;
    },
    (n) => {
      n.context.prerequisites = { isolated: 'yes' };
    },
  ]) {
    const input = note();
    mutate(input);
    assert.throws(() => validateAnnotations(input, captureFixture()), {
      code: 'invalid_annotations',
    });
  }
});

test('a measured anti-adblock prerequisite can be recorded without inventing unobserved controls', () => {
  const capture = captureFixture();
  const input = note();
  input.context.prerequisites = { detectionResolvedWhenDisabled: true };
  const context = effectiveContext(capture, validateAnnotations(input, capture));
  assert.equal(context.prerequisites.detectionResolvedWhenDisabled, true);
  assert.equal(context.prerequisites.breakageResolvedWhenDisabled, undefined);
  input.context.prerequisites.detectionResolvedWhenDisabled = 'yes';
  assert.throws(() => validateAnnotations(input, capture), { code: 'invalid_annotations' });
});

test('annotated product details retain the captured blocker identity and version', () => {
  const capture = captureFixture({
    context: {
      blockers: [
        { id: 'observed-adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true },
      ],
    },
  });
  const input = note();
  input.context.product = {
    id: 'observed-adguard',
    name: 'AdGuard changed name',
    version: '99.0.0',
    manifestVersion: 3,
  };
  const context = effectiveContext(capture, validateAnnotations(input, capture));
  assert.deepEqual(context.product, {
    id: 'observed-adguard',
    name: 'AdGuard AdBlocker',
    version: '5.5.4.76',
    manifestVersion: 3,
  });
  assert.equal(input.context.product.version, '99.0.0');
  input.context.product.id = 'different-extension';
  assert.throws(() => validateAnnotations(input, capture), { code: 'invalid_annotations' });
});

test('product annotations without inventory remain source-attributed and ambiguous names are rejected', () => {
  const input = note();
  input.context.product = { name: 'AdGuard AdBlocker', version: '5.5.4.76' };
  const withoutInventory = captureFixture();
  const context = effectiveContext(withoutInventory, validateAnnotations(input, withoutInventory));
  assert.equal(context.product.version, '5.5.4.76');
  assert.equal(context.annotationSource, input.source);
  const ambiguous = captureFixture({
    context: {
      blockers: [
        { id: 'first', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true },
        { id: 'second', name: 'AdGuard AdBlocker', version: '5.5.3', enabled: true },
      ],
    },
  });
  assert.throws(() => validateAnnotations(input, ambiguous), { code: 'invalid_annotations' });
});

test('recorded blocker annotations fill missing inventory while captured readback retains precedence', () => {
  const capture = captureFixture();
  const input = note();
  input.context.blockers = [
    { id: 'observed-adguard', name: 'AdGuard AdBlocker', version: '5.5.4.76', enabled: true },
  ];
  input.context.product = {
    id: 'observed-adguard',
    name: 'AdGuard AdBlocker',
    version: '99.0.0',
    manifestVersion: 3,
  };
  const context = effectiveContext(capture, validateAnnotations(input, capture));
  assert.equal(context.blockers[0].enabled, true);
  assert.equal(context.product.version, '5.5.4.76');
  assert.equal(context.annotationSource, 'Operator checked browser settings');
  assert.equal(context.annotationObservedAt, '2026-11-21T16:00:00.000Z');
  assert.equal(capture.context.blockers, undefined);
  delete input.context.product;
  const recorded = captureFixture({
    context: {
      blockers: [
        { id: 'observed-adguard', name: 'AdGuard AdBlocker', version: '5.5.3', enabled: false },
      ],
    },
  });
  const preserved = effectiveContext(recorded, validateAnnotations(input, recorded));
  assert.deepEqual(preserved.blockers, [
    { id: 'observed-adguard', name: 'AdGuard AdBlocker', version: '5.5.3', enabled: false },
  ]);
  input.context.blockers[0].enabled = 'yes';
  assert.throws(() => validateAnnotations(input, capture), { code: 'invalid_annotations' });
});

test('classified image evidence cannot be weakened by an ordinary capture annotation', () => {
  for (const [captured, annotatedImage, expected] of [
    ['ordinary', 'nsfw', 'nsfw'],
    ['ordinary', 'unknown', 'unknown'],
    ['ordinary', 'ordinary', 'ordinary'],
    ['nsfw', 'ordinary', 'nsfw'],
  ]) {
    const capture = captureFixture({ context: { sensitivity: captured } });
    const input = note();
    input.images[0].sensitivity = annotatedImage;
    input.images[0].sanitized = false;
    const context = effectiveContext(capture, validateAnnotations(input, capture));
    assert.equal(context.sensitivity, expected);
  }
});

test('redaction removes selected pixels while preserving original capture and remaining pixels', () => {
  const capture = captureFixture();
  const original = capture.images[0].dataBase64;
  const sanitized = sanitizedImage(capture.images[0], note().images[0]);
  const actual = PNG.sync.read(Buffer.from(sanitized.dataBase64, 'base64'));
  assert.deepEqual([...actual.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...actual.data.subarray(4, 8)], [0, 255, 0, 255]);
  assert.equal(capture.images[0].dataBase64, original);
  const first = imagePublicationKey(capture, capture.images[0], note());
  const revised = note();
  revised.images[0].redactions[0].x = 1;
  assert.notEqual(imagePublicationKey(capture, capture.images[0], revised), first);
});

test('upload identity uses outgoing pixels and destination instead of annotation representation or capture identity', () => {
  const capture = captureFixture();
  const first = note();
  first.images[0].redactions = [];
  const second = structuredClone(first);
  delete second.images[0].redactions;
  const originalKey = imagePublicationKey(capture, capture.images[0], first, 'Operator/Evidence');
  assert.equal(
    imagePublicationKey(capture, capture.images[0], second, 'operator/evidence'),
    originalKey,
  );
  const anotherCapture = captureFixture({ id: 'another_capture_id' });
  assert.equal(
    imagePublicationKey(anotherCapture, anotherCapture.images[0], first, 'operator/evidence'),
    originalKey,
  );
  assert.notEqual(
    imagePublicationKey(capture, capture.images[0], first, 'operator/other'),
    originalKey,
  );
  assert.notEqual(
    imagePublicationKey(capture, capture.images[0], first, {
      repo: 'operator/evidence',
      branch: 'other',
    }),
    originalKey,
  );
  const masks = note();
  masks.images[0].redactions.push({ x: 2, y: 0, width: 1, height: 1 });
  const reversed = structuredClone(masks);
  reversed.images[0].redactions.reverse();
  assert.equal(
    imagePublicationKey(capture, capture.images[0], masks, 'operator/evidence'),
    imagePublicationKey(capture, capture.images[0], reversed, 'operator/evidence'),
  );
});
