import { createHash, randomUUID } from 'node:crypto';
import { resolveProvider } from './config.mjs';
import { effectiveContext, imagePublicationKey, imageAssetKey, legacyImagePublicationKey, sanitizedImage } from './annotations.mjs';
import { captureDigest, captureSchema } from './capture.mjs';

const problem = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const reasonOf = error => /^[a-z][a-z0-9_-]{0,79}$/.test(error?.code ?? '') ? error.code : 'operation_failed';
const terminalPublications = new Set(['created', 'appended']);
const protectedPublications = new Set(['sending', 'uncertain', 'created', 'appended', 'duplicate']);

function analysisContext(context) {
  const properties = captureSchema.properties.context.properties;
  const projected = Object.fromEntries(Object.keys(properties)
    .filter(key => context[key] !== undefined).map(key => [key, context[key]]));
  if (projected.prerequisites) {
    projected.prerequisites = Object.fromEntries(Object.entries(projected.prerequisites)
      .filter(([key]) => Object.hasOwn(properties.prerequisites.properties, key)));
  }
  return projected;
}

export function createWorker({ store, config, env = process.env, analyze, prepare, publisher,
  browserFactory, compare, recover, fetchImpl = fetch } = {}) {
  if (!store || !config) throw new TypeError('store and config are required');
  const analyzeCapture = analyze ?? (async (...args) => (await import('./analysis.mjs')).analyzeEvidence(...args));
  const prepareFinding = prepare ?? (async (...args) => (await import('./reports.mjs')).prepareReport(...args));
  const makeBrowser = browserFactory ?? (async options => (await import('./browser.mjs')).createSctlBrowser(options));
  const comparePage = compare ?? (async (...args) => (await import('./browser.mjs')).runComparison(...args));
  const restoreBrowser = recover ?? (async (...args) => (await import('./browser.mjs')).recoverComparison(...args));
  const lifetime = new AbortController();
  let cyclePromise;
  let runPromise;
  let activeRun;
  let timer;
  let wakeScheduled = false;
  let rerunRequested = false;
  let lastError;
  let publisherInstance = publisher;
  let preparationPromise;
  let publicationPromise;
  let recoveryPromise;
  let reconciliationPromise;
  let mutationQueue = Promise.resolve();

  const combinedSignal = signal => signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
  const reassessmentPending = captureId => store.reassessmentPending?.(captureId) === true;
  async function getPublisher() {
    if (publisherInstance) return publisherInstance;
    const token = env[config.publication.tokenEnv];
    if (!token) return null;
    const { createGitHubPublisher } = await import('./reports.mjs');
    publisherInstance = createGitHubPublisher({ token, fetchImpl });
    return publisherInstance;
  }

  function pacedMutation(action, signal) {
    const task = mutationQueue.then(async () => {
      signal?.throwIfAborted();
      const lastDispatch = Number(store.getRecord('publication:lastDispatch') ?? 0);
      const remaining = config.publication.minIntervalMs - (Date.now() - lastDispatch);
      if (remaining > 0) {
        const { setTimeout } = await import('node:timers/promises');
        await setTimeout(remaining, undefined, { signal });
      }
      signal?.throwIfAborted();
      store.setRecord('publication:lastDispatch', Date.now());
      try { return await action(); }
      finally {
        // Uploads perform reads before their write; pace from completion to cover that delay.
        store.setRecord('publication:lastDispatch', Date.now());
      }
    });
    mutationQueue = task.catch(() => undefined);
    return task;
  }

  function buildFindings(capture, result) {
    const annotations = store.annotations(capture.id);
    const context = effectiveContext(capture, annotations);
    const enabledIds = new Set((context.lists ?? []).filter(list => list.enabled).map(list => list.id));
    return (result.findings ?? []).map((finding, index) => ({
      ...finding,
      id: createHash('sha256').update(`${capture.id}:${index}`).digest('hex'),
      captureId: capture.id, url: capture.url, title: capture.title,
      annotationRevision: annotations?.revision ?? null,
      textEvidence: { id: 'text', available: Boolean(capture.text.trim()) },
      listIds: (finding.suggestedListIds ?? []).filter(id => enabledIds.has(id)),
      context,
      images: capture.images.map(({ dataBase64, ...image }) => {
        const original = capture.images.find(item => item.id === image.id);
        const note = annotations?.images.find(item => item.id === image.id);
        const key = imagePublicationKey(capture, original, annotations, config.publication.evidenceRepository);
        const published = key ? store.getRecord(key) : null;
        return { ...image, sensitivity: note?.sensitivity ?? 'unknown', sanitized: note?.sanitized === true,
          ...(['uploaded', 'existing'].includes(published?.state) ? { ...published.image, id: image.id } : {}) };
      }),
    }));
  }

  async function prepareOne(finding, existingIssues = [], inputs = { catalog: store.catalog(), config: structuredClone(config.publication) }) {
    const report = await prepareFinding(finding, { catalog: inputs.catalog, config: inputs.config, existingIssues });
    const annotationRevision = finding.annotationRevision ?? null;
    const changed = (store.annotations(finding.captureId)?.revision ?? null) !== annotationRevision;
    return { ...report, findingId: finding.id, captureId: finding.captureId, annotationRevision,
      ...(changed ? { state: 'deferred', reasons: ['context_updated'] } : {}),
      ...(reassessmentPending(finding.captureId) ? { state: 'deferred', reasons: ['analysis_reassessment_pending'] } : {}) };
  }

  function publicationInputs(findingId) {
    const finding = findingId ? store.finding(findingId) : null;
    const capture = finding ? store.capture(finding.captureId) : null;
    if (!capture) return null;
    return {
      finding: { ...buildFindings(capture, { findings: [finding] })[0], id: finding.id },
      catalog: store.catalog(), config: structuredClone(config.publication),
    };
  }

  async function preparePublication(findingId) {
    const inputs = publicationInputs(findingId);
    if (!inputs) throw problem('publication_evidence_unavailable', 'The recorded finding and capture are required');
    const digest = captureDigest(inputs);
    const report = await prepareOne(inputs.finding, [], inputs);
    const expiresAt = inputs.config.specialThreads?.[report.threadPolicy?.key]?.expiresAt;
    return { ...inputs, report, isCurrent() {
      if (reassessmentPending(inputs.finding.captureId)) return false;
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) return false;
      const current = publicationInputs(findingId);
      return current !== null && captureDigest(current) === digest;
    } };
  }

  function deferDraft(id, reason) {
    const current = store.report(id);
    if (current && !protectedPublications.has(current.state)) {
      store.finishReport(id, { state: 'deferred', reason, reasons: [reason] });
    }
  }

  const uploadEligible = report => ['ready', 'deferred'].includes(report.state) && report.destination &&
    Array.isArray(report.uploadEvidenceIds) && report.uploadEvidenceIds.length > 0 && (report.reasons ?? []).every(reason =>
    /^(?:evidence-url-missing-or-nonpublic:|evidence-url-unverified:|duplicate-search-incomplete$)/.test(reason));

  function bindUploadIdentity(contentHash, repository, recorded, receipt) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const validRepo = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
      !['.', '..'].includes(value.split('/')[1]);
    const validBranch = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
      !value.includes('..') && !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));
    const requested = typeof repository === 'string' ? { repo: repository } : repository;
    if (!object(requested) || !validRepo(requested.repo) || (requested.branch !== undefined && !validBranch(requested.branch))) {
      return { reason: 'upload_destination_invalid' };
    }
    const destination = { repo: requested.repo, ...(requested.branch !== undefined ? { branch: requested.branch } : {}) };
    const bindDestination = candidate => {
      if (!object(candidate) || !validRepo(candidate.repo) || candidate.repo.toLowerCase() !== destination.repo.toLowerCase() ||
          (candidate.branch !== undefined && (!validBranch(candidate.branch) ||
            (destination.branch !== undefined && candidate.branch !== destination.branch)))) return false;
      if (candidate.branch !== undefined) destination.branch = candidate.branch;
      return true;
    };
    if (recorded != null && (!object(recorded) || recorded.contentHash !== contentHash || !bindDestination(recorded.destination))) {
      return { reason: 'upload_identity_conflict' };
    }
    if (receipt != null) {
      if (!object(receipt) || receipt.operation !== 'evidence-upload' || receipt.contentHash !== contentHash ||
          receipt.path !== `screenshots/${contentHash}.png` || !validBranch(receipt.branch) ||
          (receipt.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(receipt.sourceSha256)) ||
          (receipt.blobSha !== undefined && !/^[a-f0-9]{40}$/.test(receipt.blobSha)) || !bindDestination(receipt)) {
        return { reason: 'upload_receipt_conflict' };
      }
    }
    return { identity: { contentHash, destination } };
  }

  function scanRecords(prefix) {
    if (typeof store.listRecords !== 'function') return { complete: false, reason: 'legacy-upload-scan-unavailable', records: [] };
    const records = [];
    let after;
    for (let page = 0; page < 100; page++) {
      const result = store.listRecords(prefix, { after, limit: 100 });
      if (!Array.isArray(result?.records) || typeof result.complete !== 'boolean') break;
      for (const record of result.records) {
        if (typeof record?.key !== 'string' || !record.key.startsWith(prefix) || (after !== undefined && record.key <= after)) {
          return { complete: false, reason: 'legacy-upload-scan-invalid', records };
        }
        after = record.key;
        records.push(record);
      }
      if (result.complete) return { complete: true, records };
      if (!result.records.length || result.nextCursor !== after) break;
    }
    return { complete: false, reason: 'legacy-upload-scan-incomplete', records };
  }

  function migrateLegacyUploads(repository) {
    const scanned = scanRecords('image-publication:');
    if (!scanned.complete) return scanned;
    const requested = typeof repository === 'string' ? { repo: repository } : repository;
    const repositoryName = requested.repo.toLowerCase();
    const legacyPattern = /^image-publication:([A-Za-z0-9_-]{8,96}):([A-Za-z0-9_-]{1,96}):[a-f0-9]{64}$/;
    const histories = new Map();
    for (const { key, value } of scanned.records) {
      if (!['sending', 'uncertain', 'uploaded', 'existing'].includes(value?.state) || key.startsWith('image-publication:v2:')) continue;
      const match = legacyPattern.exec(key);
      if (!match || (value.captureId !== undefined && value.captureId !== match[1]) ||
          (value.imageId !== undefined && value.imageId !== match[2])) return { complete: false, reason: 'legacy-upload-identity-unresolved' };
      const receipt = value.receipt;
      let contentHash;
      let destination;
      if (receipt?.operation === 'evidence-upload' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(receipt.repo ?? '') &&
          /^[a-f0-9]{64}$/.test(receipt.contentHash ?? '') && receipt.path === `screenshots/${receipt.contentHash}.png` &&
          typeof receipt.branch === 'string' && receipt.branch.length > 0 && receipt.branch.length <= 200) {
        if (receipt.repo.toLowerCase() !== repositoryName || (requested.branch !== undefined && requested.branch !== receipt.branch)) continue;
        contentHash = receipt.contentHash;
        destination = { repo: receipt.repo, branch: receipt.branch };
      } else {
        const capture = store.capture(match[1]);
        const image = capture?.images.find(item => item.id === match[2]);
        if (!image) return { complete: false, reason: 'legacy-upload-evidence-unavailable' };
        if (!histories.has(capture.id)) {
          const history = scanRecords(`annotations-history:${capture.id}:`);
          if (!history.complete) return history;
          histories.set(capture.id, [...history.records.map(item => item.value), store.annotations(capture.id)].filter(Boolean));
        }
        for (const annotations of histories.get(capture.id)) {
          if (legacyImagePublicationKey(capture, image, annotations, repository) !== key) continue;
          const note = annotations.images?.find(item => item.id === image.id);
          if (annotations.context?.privacyChecked !== true || note?.sanitized !== true || note.sensitivity !== 'ordinary') break;
          contentHash = createHash('sha256').update(Buffer.from(sanitizedImage(image, note).dataBase64, 'base64')).digest('hex');
          destination = { repo: requested.repo, ...(requested.branch !== undefined ? { branch: requested.branch } : {}) };
          break;
        }
        if (!contentHash) return { complete: false, reason: 'legacy-upload-identity-unresolved' };
      }
      const canonicalKey = imageAssetKey(contentHash, repository);
      const previous = store.getRecord(canonicalKey);
      // Keep original records as evidence. Only exact remote identity can settle migrated sending debt.
      if (['uploaded', 'existing'].includes(previous?.state)) continue;
      const provenImage = ['uploaded', 'existing'].includes(value.state) && value.image?.verifiedPublic === true &&
        value.image?.sanitized === true && value.image?.sensitivity === 'ordinary' && typeof value.image?.url === 'string';
      const retryAt = [previous?.retryAt, value.retryAt].filter(date => Number.isFinite(Date.parse(date ?? '')))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      store.setRecord(canonicalKey, {
        ...value, ...previous, state: provenImage ? value.state : 'uncertain',
        ...(provenImage ? { image: value.image } : {}),
        identity: { contentHash, destination },
        ...(retryAt ? { retryAt } : {}),
        migratedFrom: [...new Set([...(previous?.migratedFrom ?? []), key])],
      });
    }
    return { complete: true };
  }

  async function uploadImages(capture, finding, { signal, uploadEvidenceIds = [] } = {}) {
    if (reassessmentPending(capture.id)) return;
    if (!config.publication.enabled || !config.publication.evidenceRepository || finding.sensitivity !== 'ordinary') return;
    const repository = config.publication.evidenceRepository;
    const annotations = store.annotations(capture.id);
    const context = effectiveContext(capture, annotations);
    if (context.sensitivity !== 'ordinary' || context.privacyChecked !== true) return;
    const transport = await getPublisher();
    if (!transport?.uploadEvidence) return;
    if (reassessmentPending(capture.id) || (store.annotations(capture.id)?.revision ?? null) !== (finding.annotationRevision ?? null)) return;
    const lease = `evidence:${capture.id}`;
    const owner = randomUUID();
    if (!store.acquireLease(lease, owner)) return;
    try {
      const migration = migrateLegacyUploads(repository);
      if (!migration.complete) return { state: 'deferred', reason: migration.reason };
      for (const id of new Set(uploadEvidenceIds)) {
        if (signal?.aborted || reassessmentPending(capture.id)) break;
        if (id === 'text') continue;
        const image = capture.images.find(item => item.id === id);
        const note = annotations?.images.find(item => item.id === id);
        if (!image || note?.sensitivity !== 'ordinary' || note?.sanitized !== true) continue;
        const key = imagePublicationKey(capture, image, annotations, repository);
        const previous = store.getRecord(key);
        if (['uploaded', 'existing'].includes(previous?.state) || Date.parse(previous?.retryAt ?? '') > Date.now()) continue;
        const reconcileOnly = ['sending', 'uncertain'].includes(previous?.state);
        const outgoing = sanitizedImage(image, note);
        const contentHash = createHash('sha256').update(Buffer.from(outgoing.dataBase64, 'base64')).digest('hex');
        const binding = bindUploadIdentity(contentHash, repository, previous?.identity, previous?.receipt);
        if (binding.reason) {
          store.setRecord(key, { ...previous, state: reconcileOnly ? 'uncertain' : 'deferred', reason: binding.reason });
          return { state: 'deferred', reason: binding.reason };
        }
        let identity = binding.identity;
        store.setRecord(key, { ...previous, state: reconcileOnly ? 'uncertain' : 'sending', at: new Date().toISOString(), identity,
          captureId: capture.id, imageId: id, ...(previous?.receipt ? { receipt: previous.receipt } : {}) });
        let result;
        let dispatched = false;
        try {
          const upload = async () => {
            if (reassessmentPending(capture.id)) return { state: 'deferred', reason: 'analysis_reassessment_pending' };
            if (!config.publication.enabled) return { state: 'dry-run', reason: 'publication_disabled' };
            const current = await preparePublication(finding.id);
            if (reassessmentPending(capture.id)) return { state: 'deferred', reason: 'analysis_reassessment_pending' };
            if (!current.isCurrent() || captureDigest(current.config.evidenceRepository) !== captureDigest(repository) ||
                current.finding.annotationRevision !== (finding.annotationRevision ?? null)) {
              return { state: 'deferred', reason: 'publication_inputs_changed' };
            }
            if (!uploadEligible(current.report) || !current.report.uploadEvidenceIds.includes(id)) {
              return { state: 'deferred', reason: current.report.reasons?.[0] ?? 'report_not_ready' };
            }
            signal?.throwIfAborted();
            dispatched = true;
            const uploadConfig = reconcileOnly && identity.destination.branch
              ? { ...current.config, evidenceRepository: { ...(typeof repository === 'string' ? { repo: repository } : repository),
                branch: identity.destination.branch } }
              : current.config;
            return transport.uploadEvidence(outgoing, uploadConfig, { signal, reconcileOnly,
              beforeMutation: () => config.publication.enabled === true && current.isCurrent() });
          };
          result = reconcileOnly ? await upload() : await pacedMutation(upload, signal);
          if (!result || !['uploaded', 'existing', 'deferred', 'failed', 'uncertain', 'dry-run'].includes(result.state)) {
            result = { state: 'uncertain', reason: 'invalid_upload_outcome' };
          }
          if (['uploaded', 'existing'].includes(result.state) &&
              (result.image?.id !== id || result.image?.verifiedPublic !== true || result.image?.sanitized !== true ||
               result.image?.sensitivity !== 'ordinary' || typeof result.image?.url !== 'string')) {
            result = { state: 'uncertain', reason: 'upload_receipt_invalid' };
          }
          const resolved = bindUploadIdentity(contentHash, repository, identity, result.receipt);
          if (resolved.reason) result = { state: 'uncertain', reason: resolved.reason };
          else identity = resolved.identity;
        } catch {
          result = dispatched || reconcileOnly ? { state: 'uncertain', reason: 'upload_response_unavailable' }
            : { state: 'deferred', reason: 'cancelled_before_upload' };
        }
        if (reconcileOnly && !['uploaded', 'existing'].includes(result.state)) {
          result = { ...previous, ...result, reconciliationState: result.state, state: 'uncertain',
            ...(previous?.receipt ? { receipt: previous.receipt } : {}) };
        }
        store.setRecord(key, { ...result, identity, ...(previous?.migratedFrom ? { migratedFrom: previous.migratedFrom } : {}),
          at: new Date().toISOString(), captureId: capture.id, imageId: id });
      }
    } finally { store.releaseLease(lease, owner); }
  }

  async function refreshReports({ signal, limit = config.scheduler.maxAnalysesPerCycle } = {}) {
    if (preparationPromise) return preparationPromise;
    const currentSignal = combinedSignal(signal);
    preparationPromise = (async () => {
      let prepared = 0;
      const candidates = store.reports().filter(saved =>
        !['sending', 'uncertain', 'created', 'appended', 'duplicate'].includes(saved.state) &&
        !(Date.parse(saved.retryAt ?? '') > Date.now()));
      const cursor = candidates.findIndex(saved => saved.id === store.getRecord('preparation:cursor'));
      const ordered = [...candidates.slice(cursor + 1), ...candidates.slice(0, cursor + 1)];
      for (const saved of ordered) {
        if (prepared >= limit || currentSignal.aborted) break;
        store.setRecord('preparation:cursor', saved.id);
        if (reassessmentPending(saved.captureId)) {
          deferDraft(saved.id, 'analysis_reassessment_pending');
          prepared++;
          continue;
        }
        const finding = store.finding(saved.findingId);
        if (!finding) continue;
        const capture = store.capture(finding.captureId);
        if (!capture) continue;
        let current = buildFindings(capture, { findings: [finding] })[0];
        current.id = finding.id;
        let report = await prepareOne(current);
        const contextChanged = () => (store.annotations(capture.id)?.revision ?? null) !== current.annotationRevision;
        if (contextChanged()) continue;
        // Upload only when the remaining prerequisites concern the evidence itself.
        const uploadable = uploadEligible(report);
        if (uploadable) {
          const upload = await uploadImages(capture, current, { signal: currentSignal, uploadEvidenceIds: report.uploadEvidenceIds });
          if (contextChanged()) continue;
          current = { ...buildFindings(capture, { findings: [finding] })[0], id: finding.id };
          report = await prepareOne(current);
          if (upload?.reason && report.state !== 'ready') report = { ...report, state: 'deferred', reasons: [...report.reasons, upload.reason] };
        }
        if (currentSignal.aborted) break;
        if (reassessmentPending(saved.captureId)) {
          deferDraft(saved.id, 'analysis_reassessment_pending');
          prepared++;
          continue;
        }
        if (contextChanged()) continue;
        store.updateFinding(finding.id, current);
        store.reviseReport(saved.id, report);
        prepared++;
      }
      return { state: currentSignal.aborted ? 'cancelled' : 'completed', prepared };
    })();
    try { return await preparationPromise; }
    finally { preparationPromise = undefined; }
  }

  async function processCaptures({ signal, limit = config.scheduler.maxAnalysesPerCycle } = {}) {
    if (!config.provider.enabled) return { state: 'disabled', processed: 0 };
    const currentSignal = combinedSignal(signal);
    let processed = 0;
    for (; processed < limit && !currentSignal.aborted; processed++) {
      const capture = store.claimCapture();
      if (!capture) break;
      let result;
      let reports = [];
      try {
        const context = effectiveContext(capture, store.annotations(capture.id));
        const sensitivity = context.sensitivity ?? 'unknown';
        if (!config.provider.allowedSensitivity.includes(sensitivity)) {
          result = { state: 'abstained', reason: 'evidence_class_not_enabled', findings: [], provenance: {} };
        } else {
          const evidence = { ...capture, context: analysisContext({ ...context, sensitivity }) };
          result = await analyzeCapture(evidence, resolveProvider(config, env), { signal: currentSignal, fetchImpl });
          if (!result || !['accepted', 'abstained', 'failed', 'cancelled'].includes(result.state)) {
            throw problem('invalid_analysis_result', 'Analysis did not return a valid outcome');
          }
          result = { ...result, findings: result.state === 'accepted' ? buildFindings(capture, result) : [] };
          for (const finding of result.findings) reports.push(await prepareOne(finding));
        }
      } catch (error) {
        result = { state: currentSignal.aborted ? 'cancelled' : 'failed', reason: reasonOf(error), findings: [], provenance: {} };
        reports = [];
      }
      store.finishCapture(capture.id, result, reports);
      store.event('analysis', `Capture ${result.state}`, { captureId: capture.id, state: result.state, findings: result.findings.length });
    }
    return { state: currentSignal.aborted ? 'cancelled' : 'completed', processed };
  }

  async function processPublications({ signal, limit = config.scheduler.maxPublicationsPerCycle } = {}) {
    if (publicationPromise) return publicationPromise;
    const currentSignal = combinedSignal(signal);
    publicationPromise = (async () => {
      const transport = config.publication.enabled ? await getPublisher() : null;
      if (config.publication.enabled && !transport) return { state: 'deferred', reason: 'github_token_missing', processed: 0 };
      const candidates = store.reports().filter(report =>
        (report.state === 'ready' || (config.publication.enabled && report.state === 'dry-run')) &&
        !(Date.parse(report.retryAt ?? '') > Date.now()));
      let processed = 0;
      for (const saved of candidates) {
        if (processed >= limit || currentSignal.aborted) break;
        processed++;
        if (reassessmentPending(saved.captureId)) {
          deferDraft(saved.id, 'analysis_reassessment_pending');
          continue;
        }
        if (!config.publication.enabled) {
          const current = store.report(saved.id);
          if (current?.state === 'ready') store.finishReport(saved.id, { state: 'dry-run', reason: 'publication_disabled' });
          continue;
        }
        let claimed;
        let outcome;
        let dispatched = false;
        try {
          await pacedMutation(async () => {
            const draft = store.report(saved.id);
            if (!draft || !['ready', 'dry-run'].includes(draft.state) || Date.parse(draft.retryAt ?? '') > Date.now()) return;
            if (reassessmentPending(draft.captureId)) { deferDraft(draft.id, 'analysis_reassessment_pending'); return; }
            if (!config.publication.enabled) {
              store.finishReport(draft.id, { state: 'dry-run', reason: 'publication_disabled' });
              return;
            }
            const version = captureDigest(draft);
            const current = await preparePublication(draft.findingId);
            currentSignal.throwIfAborted();
            if (reassessmentPending(draft.captureId)) { deferDraft(draft.id, 'analysis_reassessment_pending'); return; }
            if (captureDigest(store.report(draft.id)) !== version) return;
            if (!config.publication.enabled) {
              store.finishReport(draft.id, { state: 'dry-run', reason: 'publication_disabled' });
              return;
            }
            if (!current.isCurrent() || current.finding.captureId !== draft.captureId) {
              deferDraft(draft.id, 'publication_inputs_changed');
              return;
            }
            const revision = store.reviseReport(draft.id, current.report);
            if (revision.unchanged || revision.duplicate || current.report.state !== 'ready') return;
            // A concurrent refresh can have queued an older draft; only claim the one just validated.
            if (store.reports().find(report => report.state === 'ready')?.id !== draft.id) return;
            claimed = store.claimReport();
            if (!claimed || claimed.id !== draft.id) throw problem('publication_revalidation_required', 'The publication queue changed');
            const claimedVersion = captureDigest(claimed);
            dispatched = true;
            outcome = await transport.publish({ ...claimed, state: 'ready' }, { signal: currentSignal,
              beforeMutation: () => config.publication.enabled === true && current.isCurrent() &&
                captureDigest(store.report(claimed.id)) === claimedVersion });
            if (!['created', 'appended', 'deferred', 'uncertain', 'failed', 'dry-run', 'unsupported'].includes(outcome?.state)) {
              outcome = { state: 'uncertain', reason: 'invalid_publication_outcome' };
            }
            store.finishReport(claimed.id, outcome);
            store.event('publication', `Report ${outcome.state}`, { reportId: claimed.id, state: outcome.state });
          }, currentSignal);
        } catch (cause) {
          // An entered publisher may have created a remote record even when its response was lost.
          if (claimed) store.finishReport(claimed.id, outcome ?? (dispatched
            ? { state: 'uncertain', reason: 'publication_response_unavailable' }
            : { state: 'deferred', reason: 'publication_revalidation_required' }));
          else deferDraft(saved.id, reassessmentPending(saved.captureId) ? 'analysis_reassessment_pending'
            : currentSignal.aborted ? 'cancelled_before_publication' : reasonOf(cause));
        }
      }
      return { state: currentSignal.aborted ? 'cancelled' : 'completed', processed };
    })();
    try { return await publicationPromise; }
    finally { publicationPromise = undefined; }
  }

  async function reconcileReports() {
    if (reconciliationPromise) return reconciliationPromise;
    reconciliationPromise = (async () => {
      const transport = await getPublisher();
      if (!transport) return { state: 'deferred', reason: 'github_token_missing', checked: 0 };
      // Rotate over the stable full queue, including delayed records, so removing a resolved head cannot reset progress.
      const reports = store.reports();
      const cursor = reports.findIndex(report => report.id === store.getRecord('reconciliation:cursor'));
      const ordered = [...reports.slice(cursor + 1), ...reports.slice(0, cursor + 1)];
      let checked = 0;
      for (const saved of ordered) {
        if (lifetime.signal.aborted || checked >= config.scheduler.maxPublicationsPerCycle) break;
        const report = store.report(saved.id);
        if (report?.state !== 'uncertain') continue;
        const last = store.getRecord(`reconcile:${report.id}`);
        if ([report.retryAt, last?.retryAt, last?.result?.retryAt].some(value => Date.parse(value ?? '') > Date.now())) continue;
        store.setRecord('reconciliation:cursor', report.id);
        checked++;
        try {
          const result = await transport.reconcile(report, { signal: lifetime.signal });
          if (terminalPublications.has(result?.state)) store.finishReport(report.id, result);
          else store.setRecord(`reconcile:${report.id}`, { at: new Date().toISOString(), result });
        } catch { store.event('reconciliation', 'Reconciliation unavailable', { reportId: report.id }); }
      }
      return { state: lifetime.signal.aborted ? 'cancelled' : 'completed', checked };
    })();
    try { return await reconciliationPromise; }
    finally { reconciliationPromise = undefined; }
  }

  async function followUp() {
    const transport = await getPublisher();
    if (!transport) return { state: 'deferred', reason: 'github_token_missing', checked: 0 };
    let checked = 0;
    const interval = config.scheduler.followUpIntervalMs;
    for (const report of store.reports().filter(report => terminalPublications.has(report.state) && report.receipt)) {
      if (lifetime.signal.aborted || checked >= config.scheduler.maxPublicationsPerCycle) break;
      const key = `followup:${report.id}`;
      if (Date.now() - Date.parse(store.getRecord(key)?.at ?? '') < interval) continue;
      try {
        const result = await transport.followUp(report.receipt, { signal: lifetime.signal });
        store.setRecord(key, { at: new Date().toISOString(), result });
        store.event('follow-up', 'Upstream status observed', { reportId: report.id, state: result.state ?? 'unknown' });
      } catch { store.event('follow-up', 'Upstream status unavailable', { reportId: report.id }); }
      checked++;
    }
    return { state: 'completed', checked };
  }

  async function runLoop(runId, { signal } = {}) {
    if (recoveryPromise) throw problem('recovery_busy', 'Browser recovery is still running');
    const run = store.run(runId);
    if (!run) throw problem('run_not_found', 'Run not found', 404);
    if (!config.browser.instance) throw problem('browser_not_configured', 'Choose the paired browser instance first');
    if (run.options.compare && !config.browser.allowChanges) throw problem('browser_changes_disabled', 'Controlled comparisons are not enabled in configuration');
    const browserId = config.browser.instance;
    const leaseName = `browser:${browserId}`;
    const leaseOwner = randomUUID();
    if (!store.acquireLease(leaseName, leaseOwner)) throw problem('browser_busy', 'A browser comparison or recovery owns this browser');
    const controller = new AbortController();
    activeRun = { id: runId, controller };
    const currentSignal = AbortSignal.any([combinedSignal(signal), controller.signal]);
    let adapter;
    try {
      adapter = await makeBrowser({ browser: browserId });
      const journal = store.journal(browserId);
      if (await journal.read()) throw problem('browser_recovery_required', 'Restore the interrupted browser comparison before starting a run');
      store.resumeRun(runId);
      while (!currentSignal.aborted) {
        const entry = store.claimEntry(runId);
        if (!entry) break;
        try {
          const result = run.options.compare
            ? await comparePage(adapter, entry.url, { journal, signal: currentSignal, isolateUbol: config.browser.isolateUbol })
            : { state: 'completed', captures: [await adapter.capture(entry.url, { condition: 'installed', signal: currentSignal })] };
          const captureIds = [];
          for (const capture of result.captures ?? []) { store.ingest(capture); captureIds.push(capture.id); }
          store.finishEntry(runId, entry.id, { ...result, captures: undefined, captureIds });
          if (await journal.read()) break;
        } catch (error) {
          store.finishEntry(runId, entry.id, { state: currentSignal.aborted ? 'cancelled' : 'failed', reason: reasonOf(error), captureIds: [] });
          if (await journal.read()) break;
        }
      }
      if (currentSignal.aborted) store.cancelPending(runId);
      return store.run(runId);
    } finally {
      try { await adapter?.close(); }
      finally {
        // A failed restore keeps both journal and lease visible for explicit recovery.
        if (!(await store.journal(browserId).read())) store.releaseLease(leaseName, leaseOwner);
        activeRun = undefined;
      }
    }
  }

  async function recoverBrowserState() {
    if (runPromise || activeRun) throw problem('run_busy', 'Stop the active run before recovery');
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
    const results = [];
    for (const { name } of store.journals()) {
      const adapter = await makeBrowser({ browser: name });
      try {
        const result = await restoreBrowser(adapter, store.journal(name));
        results.push({ browser: name, result });
        if (!(await store.journal(name).read())) {
          for (const lease of store.leases().filter(lease => lease.name === `browser:${name}`)) store.releaseLease(lease.name, lease.owner);
        }
      } finally { await adapter.close(); }
    }
    for (const lease of store.leases().filter(lease => lease.name.startsWith('browser:'))) {
      if (!(await store.journal(lease.name.slice(8)).read())) store.releaseLease(lease.name, lease.owner);
    }
    return results;
    })();
    try { return await recoveryPromise; }
    finally { recoveryPromise = undefined; }
  }

  const worker = {
    status() { return { processing: Boolean(cyclePromise), runId: activeRun?.id ?? null, stopped: lifetime.signal.aborted, lastError: lastError ?? null }; },
    processCaptures, processPublications, reconcileReports, followUp, recoverBrowserState, refreshReports,
    async cycle(options = {}) {
      if (cyclePromise) return cyclePromise;
      cyclePromise = (async () => {
        const analyses = await processCaptures(options);
        const preparation = await refreshReports(options);
        const publications = await processPublications(options);
        const reconciliation = config.publication.enabled ? await reconcileReports() : { state: 'disabled' };
        const followups = config.publication.enabled ? await followUp() : { state: 'disabled' };
        return { analyses, preparation, publications, reconciliation, followups };
      })();
      try { return await cyclePromise; }
      finally { cyclePromise = undefined; if (rerunRequested) { rerunRequested = false; worker.wake(); } }
    },
    wake() {
      if (lifetime.signal.aborted || !config.autoProcess) return;
      if (cyclePromise) { rerunRequested = true; return; }
      if (wakeScheduled) return;
      wakeScheduled = true;
      setImmediate(() => {
        wakeScheduled = false;
        if (lifetime.signal.aborted) return;
        worker.cycle().catch(error => {
          lastError = reasonOf(error);
          store.event('worker', 'Processing cycle failed', { reason: lastError });
        });
      });
    },
    start() {
      if (!timer && !lifetime.signal.aborted) {
        timer = setInterval(() => worker.wake(), config.scheduler.intervalMs);
        timer.unref();
        worker.wake();
      }
    },
    async stop() {
      clearInterval(timer);
      lifetime.abort();
      activeRun?.controller.abort();
      await Promise.allSettled([cyclePromise, runPromise, preparationPromise, publicationPromise, reconciliationPromise, recoveryPromise].filter(Boolean));
    },
    async run(runId, options) {
      if (runPromise) throw problem('run_busy', 'A browser run is already active');
      runPromise = runLoop(runId, options);
      try { return await runPromise; }
      finally { runPromise = undefined; worker.wake(); }
    },
    cancelRun(runId) {
      if (!store.run(runId)) throw problem('run_not_found', 'Run not found', 404);
      if (activeRun?.id === runId) activeRun.controller.abort();
      store.cancelPending(runId);
      return store.run(runId);
    },
  };
  return worker;
}
