import Ajv from 'ajv';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { captureSchema, stableJson } from './capture.mjs';

const text = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const boolean = { type: 'boolean' };
const sensitivity = { enum: ['ordinary', 'nsfw', 'unknown'] };
const integer = { type: 'integer', minimum: 0, maximum: 32768 };
const prerequisites = object(Object.fromEntries([
  'filtersCurrent', 'browserCurrent', 'productCurrent', 'isolated', 'breakageResolvedWhenDisabled',
  'documentationChecked', 'notAdOrBugReport', 'defaultsTested', 'customRulesExcluded',
  'interferenceExcluded', 'developerModeDisabled', 'detectionResolvedWhenDisabled',
].map(key => [key, boolean])));
const policy = object({
  ...Object.fromEntries(['selfPromotion', 'conspicuous', 'errorTracking', 'necessaryAntiBot', 'fraudPrevention',
    'paywall', 'nonObstructive', 'obstructive', 'aggressive', 'misleading', 'privacyInvasive',
    'malvertisingRisk', 'integratedContent', 'practicalPush', 'unobtrusiveAppBanner',
    'intentionallyAllowed', 'siteSpecific', 'maintainerException', 'historicalRule',
    'vietnameseSite', 'translatedGlobalSite', 'antiMalwareList', 'pornFarm', 'restyle', 'newFilterList']
    .map(key => [key, boolean])),
  widgetKind: { enum: ['social-login', 'comments', 'embedded-post', 'poll', 'own-social-link', 'sharing', 'group', 'recommendation', 'unknown'] },
  siteKind: text(100), monthlyVisits: { type: 'number', minimum: 0 },
  placeholder: object({ width: integer, height: integer }, ['width', 'height']),
});

const annotationSchema = object({
  source: text(300, 1), observedAt: text(40, 20),
  context: object({
    lists: captureSchema.properties.context.properties.lists,
    blockers: captureSchema.properties.context.properties.blockers,
    pageState: captureSchema.properties.context.properties.pageState,
    sensitivity, prerequisites, policy,
    product: object({ id: text(128, 1), name: text(300, 1), version: text(160, 1),
      manifestVersion: { enum: [2, 3] }, filteringMode: { enum: ['basic', 'optimal', 'complete'] } }, ['name', 'version']),
    os: object({ name: text(100, 1), version: text(160, 1) }, ['name', 'version']),
    otherExtensions: { type: 'array', maxItems: 200, items: text(300) },
    privacyChecked: boolean, networkEvidence: text(20000), troubleshooting: text(20000),
    accountRequirements: text(2000), filtersLastUpdate: text(40),
    reproductionRate: { type: 'number', minimum: 0, maximum: 1 },
  }),
  images: { type: 'array', maxItems: 4, items: object({
    id: { ...text(96, 1), pattern: '^[A-Za-z0-9_-]+$' }, sensitivity, sanitized: boolean,
    redactions: { type: 'array', maxItems: 100, items: object({
      x: integer, y: integer, width: { ...integer, minimum: 1 }, height: { ...integer, minimum: 1 },
    }, ['x', 'y', 'width', 'height']) },
  }, ['id', 'sensitivity', 'sanitized']) },
}, ['source', 'observedAt', 'context', 'images']);
const validate = new Ajv({ strict: true }).compile(annotationSchema);
const invalid = message => Object.assign(new Error(message), { code: 'invalid_annotations', status: 400 });

function observedProduct(capture, product, annotatedBlockers) {
  const blockers = capture.context.blockers ?? annotatedBlockers;
  if (!product || !blockers) return null;
  const matches = blockers.filter(blocker => blocker.enabled && (product.id
    ? blocker.id === product.id : blocker.name === product.name));
  if (matches.length !== 1) throw invalid('Product notes must identify one captured enabled blocker');
  return matches[0];
}

export function validateAnnotations(input, capture) {
  if (!validate(input)) throw invalid(`Invalid annotation field: ${validate.errors[0].instancePath || '/'}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.observedAt)
      || !Number.isFinite(Date.parse(input.observedAt))) throw invalid('Use an ISO UTC observation time');
  observedProduct(capture, input.context.product, input.context.blockers);
  const ids = new Set();
  for (const item of input.images) {
    const image = capture.images.find(image => image.id === item.id);
    if (!image || ids.has(item.id)) throw invalid('Annotations must name each existing image at most once');
    ids.add(item.id);
    if (item.sanitized && input.context.privacyChecked !== true) throw invalid('Sanitized evidence needs a recorded privacy check');
    for (const box of item.redactions ?? []) {
      if (box.x + box.width > image.width || box.y + box.height > image.height) throw invalid('Redaction exceeds the image bounds');
    }
  }
  return structuredClone(input);
}

export function effectiveContext(capture, annotations) {
  if (!annotations) return { ...capture.context, browser: capture.browser, capturedAt: capture.capturedAt, limitations: capture.limitations };
  const context = { ...capture.context, ...annotations.context,
    prerequisites: { ...annotations.context.prerequisites, ...capture.context.prerequisites },
    browser: capture.browser, capturedAt: capture.capturedAt, limitations: capture.limitations,
    annotationSource: annotations.source, annotationObservedAt: annotations.observedAt };
  if (capture.context.lists) context.lists = capture.context.lists;
  if (capture.context.blockers) context.blockers = capture.context.blockers;
  if (['challenge', 'login-required'].includes(capture.context.pageState)) context.pageState = capture.context.pageState;
  const evidenceClasses = [context.sensitivity ?? 'unknown', ...annotations.images.map(image => image.sensitivity)];
  context.sensitivity = capture.context.sensitivity === 'nsfw' || evidenceClasses.includes('nsfw') ? 'nsfw'
    : evidenceClasses.every(value => value === 'ordinary') ? 'ordinary' : 'unknown';
  const product = observedProduct(capture, annotations.context.product, annotations.context.blockers);
  if (product) context.product = { ...context.product, id: product.id, name: product.name, version: product.version };
  return context;
}

export function imagePublicationKey(capture, image, annotations, repository = '') {
  const note = annotations?.images.find(item => item.id === image.id);
  if (annotations?.context.privacyChecked !== true || note?.sanitized !== true || note.sensitivity !== 'ordinary') return null;
  const outgoing = sanitizedImage(image, note);
  const contentHash = createHash('sha256').update(Buffer.from(outgoing.dataBase64, 'base64')).digest('hex');
  return imageAssetKey(contentHash, repository);
}

export function imageAssetKey(contentHash, repository = '') {
  const settings = typeof repository === 'string' ? { repo: repository } : repository ?? {};
  const destination = { repo: String(settings.repo ?? '').toLowerCase(), branch: settings.branch ?? null };
  return `image-publication:v2:${createHash('sha256').update(stableJson({ contentHash, destination })).digest('hex')}`;
}

// Kept only to identify previously persisted attempts; new writes use outgoing-content identity.
export function legacyImagePublicationKey(capture, image, annotations, repository = '') {
  const note = annotations?.images.find(item => item.id === image.id);
  const digest = createHash('sha256').update(stableJson({
    data: image.dataBase64, note: note ?? null, privacyChecked: annotations?.context.privacyChecked === true, repository,
  })).digest('hex');
  return `image-publication:${capture.id}:${image.id}:${digest}`;
}

export function sanitizedImage(image, annotation) {
  if (annotation?.sanitized !== true || annotation.sensitivity !== 'ordinary' || image?.id === 'text') {
    throw invalid('Only checked ordinary images can be prepared for publication');
  }
  const png = PNG.sync.read(Buffer.from(image.dataBase64, 'base64'), { checkCRC: true });
  for (const box of annotation.redactions ?? []) {
    if (![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) || box.x < 0 || box.y < 0
        || box.width < 1 || box.height < 1 || box.x + box.width > png.width || box.y + box.height > png.height) {
      throw invalid('Redaction exceeds the image bounds');
    }
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const index = (y * png.width + x) * 4;
        png.data[index] = 0; png.data[index + 1] = 0; png.data[index + 2] = 0; png.data[index + 3] = 255;
      }
    }
  }
  return { ...image, dataBase64: PNG.sync.write({ width: png.width, height: png.height, data: png.data }).toString('base64'), sanitized: true, sensitivity: 'ordinary' };
}
