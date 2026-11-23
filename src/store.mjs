import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as sqlite from 'node:sqlite';
import { captureDigest, stableJson, validateCapture } from './capture.mjs';
import { effectiveContext, validateAnnotations } from './annotations.mjs';

const Database = sqlite.Database ?? sqlite.DatabaseSync;
const now = () => new Date().toISOString();
const decode = (value) => (value == null ? null : JSON.parse(value));
const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const entryStates = [
  'pending',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'inconclusive',
];
const protectedReports = new Set(['sending', 'uncertain', 'created', 'appended', 'duplicate']);
const reassessmentLimit = 3;

export function openStore(directory) {
  const stateDir = resolve(directory);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(stateDir, 'observatory.sqlite'));
  db.exec(
    'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
  );
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) {
    db.close();
    throw error(
      'unsupported_database',
      'This database was created by a newer Filter Observatory',
      500,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, envelope TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      capture_id TEXT NOT NULL REFERENCES captures(id), id TEXT NOT NULL,
      bytes BLOB NOT NULL, PRIMARY KEY(capture_id, id)
    );
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_attempts (
      capture_id TEXT NOT NULL REFERENCES captures(id), ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL, context_revision TEXT NOT NULL, context TEXT NOT NULL,
      annotation_revision TEXT, state TEXT NOT NULL, result TEXT, reports TEXT,
      started_at TEXT, finished_at TEXT, PRIMARY KEY(capture_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL, outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, corpus TEXT NOT NULL, options TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_entries (
      run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
      PRIMARY KEY(run_id, id)
    );
    CREATE TABLE IF NOT EXISTS catalog (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, health TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases (
      name TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS capture_queue ON captures(state, created_at);
    CREATE INDEX IF NOT EXISTS report_queue ON reports(state, created_at);
    PRAGMA user_version=2;
  `);
  let closed = false;
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  }
  function saveReport(report, { createdAt } = {}) {
    if (
      !report?.id ||
      !report.fingerprint ||
      !['ready', 'deferred', 'unsupported', 'dry-run'].includes(report.state)
    ) {
      throw error('invalid_report', 'Prepared report has an invalid identity or state', 400);
    }
    const existing = db
      .prepare('SELECT * FROM reports WHERE fingerprint=?')
      .get(report.fingerprint);
    if (existing)
      return { id: existing.id, duplicate: true, updated: promoteDraft(existing, report) };
    // A promoted canonical draft can retain another capture's originally requested ID.
    const id = db.prepare('SELECT 1 FROM reports WHERE id=?').get(report.id)
      ? `report-${captureDigest({ requestedId: report.id, fingerprint: report.fingerprint })}`
      : report.id;
    const at = now();
    db.prepare(
      'INSERT INTO reports (id,fingerprint,payload,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run(
      id,
      report.fingerprint,
      JSON.stringify({ ...report, id }),
      report.state,
      createdAt ?? at,
      at,
    );
    return { id, duplicate: false };
  }
  function reportRow(row) {
    if (!row) return null;
    return {
      ...decode(row.payload),
      ...decode(row.outcome),
      id: row.id,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  function promoteDraft(existing, prepared) {
    if (
      !['deferred', 'unsupported', 'failed'].includes(existing.state) ||
      !['ready', 'dry-run'].includes(prepared.state)
    )
      return false;
    db.prepare('UPDATE reports SET payload=?,state=?,outcome=NULL,updated_at=? WHERE id=?').run(
      JSON.stringify({ ...prepared, id: existing.id }),
      prepared.state,
      now(),
      existing.id,
    );
    return true;
  }
  function reportsForCapture(id) {
    const ids = new Set(
      db
        .prepare('SELECT id FROM findings WHERE capture_id=?')
        .all(id)
        .map((row) => row.id),
    );
    return store.reports().filter((report) => report.captureId === id || ids.has(report.findingId));
  }
  function listRevision(context) {
    const lists = (context.lists ?? [])
      .filter((list) => list.enabled)
      .map((list) => stableJson(list))
      .sort();
    return captureDigest(lists);
  }
  function analysisContext(capture) {
    const annotations = store.annotations(capture.id);
    const context = effectiveContext(capture, annotations);
    return {
      context,
      revision: listRevision(context),
      annotationRevision: annotations?.revision ?? null,
    };
  }
  function ensureAnalysisHistory(row) {
    if (
      !row.result ||
      db.prepare('SELECT 1 FROM analysis_attempts WHERE capture_id=? LIMIT 1').get(row.id)
    )
      return;
    const result = decode(row.result);
    // Older databases did not retain a dispatch snapshot; preserve only the context they recorded.
    const context =
      result.findings?.find((finding) => finding.context)?.context ?? decode(row.envelope).context;
    db.prepare(
      `INSERT INTO analysis_attempts
      (capture_id,ordinal,kind,context_revision,context,state,result,reports,finished_at)
      VALUES (?,1,'legacy',?,?,?,?,?,?)`,
    ).run(
      row.id,
      listRevision(context),
      JSON.stringify(context),
      result.state ?? row.state,
      row.result,
      JSON.stringify(reportsForCapture(row.id)),
      row.updated_at,
    );
    if (result.state === 'accepted') store.setRecord(`analysis-active:${row.id}`, { ordinal: 1 });
  }
  function activeAnalysis(row, history) {
    const ordinal = store.getRecord(`analysis-active:${row.id}`)?.ordinal;
    const recorded = history.find(
      (attempt) => attempt.ordinal === ordinal && attempt.state === 'accepted',
    );
    if (recorded) return recorded;
    // Migrate only a result the older database actually retained as its active outcome.
    return history.findLast(
      (attempt) =>
        attempt.state === 'accepted' &&
        row.result &&
        stableJson(attempt.result) === stableJson(decode(row.result)),
    );
  }
  function settleReassessment(row, active, revision) {
    if (active?.contextRevision !== revision) return false;
    store.setRecord(`reassessment:${row.id}`, {
      pending: false,
      state: 'accepted',
      contextRevision: revision,
    });
    db.prepare('UPDATE captures SET state=?,result=?,updated_at=? WHERE id=?').run(
      'accepted',
      JSON.stringify(active.result),
      now(),
      row.id,
    );
    return true;
  }
  function deferReassessmentReports(id) {
    for (const report of reportsForCapture(id).filter((report) =>
      ['ready', 'dry-run'].includes(report.state),
    )) {
      db.prepare("UPDATE reports SET state='deferred',outcome=?,updated_at=? WHERE id=?").run(
        JSON.stringify({ state: 'deferred', reason: 'reassessment_pending' }),
        now(),
        report.id,
      );
    }
  }
  function queueReassessment(id) {
    const row = db.prepare('SELECT * FROM captures WHERE id=?').get(id);
    if (!row || row.state === 'analyzing') return;
    const pending = store.reassessmentPending(id);
    if (row.state !== 'accepted' && !pending) return;
    const capture = decode(row.envelope);
    const snapshot = analysisContext(capture);
    ensureAnalysisHistory(row);
    const history = store.analysisHistory(id);
    const active = activeAnalysis(row, history);
    if (pending && settleReassessment(row, active, snapshot.revision)) return;
    const enabledIds = new Set(
      (snapshot.context.lists ?? []).filter((list) => list.enabled).map((list) => list.id),
    );
    const findings = db
      .prepare('SELECT payload FROM findings WHERE capture_id=?')
      .all(id)
      .map((item) => decode(item.payload));
    if (
      !enabledIds.size ||
      (!pending &&
        !findings.some(
          (finding) => !(finding.listIds ?? []).some((listId) => enabledIds.has(listId)),
        ))
    )
      return;
    if (reportsForCapture(id).some((report) => protectedReports.has(report.state))) return;
    if (history.some((attempt) => attempt.contextRevision === snapshot.revision)) return;
    const spent = new Set(
      history
        .filter((attempt) => attempt.kind === 'reassessment')
        .map((attempt) => attempt.contextRevision),
    );
    const exhausted = spent.size >= reassessmentLimit;
    store.setRecord(`reassessment:${id}`, {
      pending: true,
      state: exhausted ? 'deferred' : 'queued',
      contextRevision: snapshot.revision,
      reason: exhausted ? 'reassessment_budget_exhausted' : 'list_context_changed',
    });
    deferReassessmentReports(id);
    if (!exhausted)
      db.prepare("UPDATE captures SET state='queued',updated_at=? WHERE id=?").run(now(), id);
  }
  function reviseReport(id, prepared) {
    const current = store.report(id);
    if (!current) return saveReport(prepared);
    if (
      protectedReports.has(current.state) ||
      store.reassessmentPending(current.captureId ?? store.finding(current.findingId)?.captureId)
    ) {
      return { id, unchanged: true };
    }
    if (
      !prepared?.fingerprint ||
      !['ready', 'deferred', 'unsupported', 'dry-run'].includes(prepared.state)
    ) {
      throw error('invalid_report', 'Prepared report has an invalid identity or state', 400);
    }
    const duplicate = db
      .prepare('SELECT * FROM reports WHERE fingerprint=? AND id<>?')
      .get(prepared.fingerprint, id);
    if (duplicate) {
      promoteDraft(duplicate, prepared);
      db.prepare("UPDATE reports SET state='duplicate',outcome=?,updated_at=? WHERE id=?").run(
        JSON.stringify({
          state: 'duplicate',
          duplicateOf: duplicate.id,
          reason: 'existing_finding',
        }),
        now(),
        id,
      );
      return { id: duplicate.id, duplicate: true };
    }
    db.prepare(
      'UPDATE reports SET fingerprint=?,payload=?,state=?,outcome=NULL,updated_at=? WHERE id=?',
    ).run(prepared.fingerprint, JSON.stringify({ ...prepared, id }), prepared.state, now(), id);
    return { id, updated: true };
  }
  function replaceDerived(id, result, reports) {
    const previous = reportsForCapture(id);
    if (previous.some((report) => protectedReports.has(report.state))) return false;
    const matched = new Set();
    const replacements = reports.map((report) => {
      const earlier =
        previous.find((item) => !matched.has(item.id) && item.fingerprint === report.fingerprint) ??
        previous.find((item) => !matched.has(item.id) && item.findingId === report.findingId);
      if (earlier) matched.add(earlier.id);
      return { earlier, report };
    });
    // Free the complete replaceable set before deduplicating its replacements.
    for (const report of previous) {
      db.prepare('DELETE FROM reports WHERE id=?').run(report.id);
    }
    db.prepare('DELETE FROM findings WHERE capture_id=?').run(id);
    for (const finding of result.findings ?? []) {
      if (!finding.id) throw error('invalid_finding', 'Worker-assigned finding ID is missing', 400);
      db.prepare('INSERT INTO findings (id,capture_id,payload) VALUES (?,?,?)').run(
        finding.id,
        id,
        JSON.stringify({ ...finding, captureId: id }),
      );
    }
    for (const { earlier, report } of replacements) {
      saveReport({ ...report, id: earlier?.id ?? report.id }, { createdAt: earlier?.createdAt });
    }
    return true;
  }
  const store = {
    stateDir,
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
    ingest(input) {
      const capture = validateCapture(input);
      const digest = captureDigest(capture);
      return transaction(() => {
        const existing = db.prepare('SELECT digest,state FROM captures WHERE id=?').get(capture.id);
        if (existing) {
          if (existing.digest !== digest)
            throw error('capture_conflict', 'Capture ID already belongs to different evidence');
          return {
            id: capture.id,
            state: existing.state === 'queued' ? 'queued' : 'stored',
            duplicate: true,
          };
        }
        const at = now();
        const envelope = {
          ...capture,
          images: capture.images.map(({ dataBase64, ...image }) => image),
        };
        db.prepare(
          'INSERT INTO captures (id,digest,envelope,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        ).run(capture.id, digest, JSON.stringify(envelope), 'queued', at, at);
        const insert = db.prepare('INSERT INTO images (capture_id,id,bytes) VALUES (?,?,?)');
        for (const image of capture.images)
          insert.run(capture.id, image.id, Buffer.from(image.dataBase64, 'base64'));
        return { id: capture.id, state: 'queued', duplicate: false };
      });
    },
    capture(id) {
      const row = db.prepare('SELECT envelope FROM captures WHERE id=?').get(id);
      if (!row) return null;
      const capture = decode(row.envelope);
      capture.images = capture.images.map((image) => ({
        ...image,
        dataBase64: Buffer.from(
          db.prepare('SELECT bytes FROM images WHERE capture_id=? AND id=?').get(id, image.id)
            .bytes,
        ).toString('base64'),
      }));
      return capture;
    },
    image(captureId, imageId) {
      const row = db
        .prepare('SELECT bytes FROM images WHERE capture_id=? AND id=?')
        .get(captureId, imageId);
      if (!row) return null;
      const envelope = decode(
        db.prepare('SELECT envelope FROM captures WHERE id=?').get(captureId).envelope,
      );
      return {
        ...envelope.images.find((image) => image.id === imageId),
        bytes: Buffer.from(row.bytes),
      };
    },
    captureStatus(id) {
      const row = db
        .prepare('SELECT id,state,result,created_at,updated_at FROM captures WHERE id=?')
        .get(id);
      const reassessment = store.getRecord(`reassessment:${id}`);
      return row
        ? {
            id: row.id,
            state: row.state,
            result: decode(row.result),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            ...(reassessment ? { reassessment } : {}),
          }
        : null;
    },
    analysisHistory(id) {
      return db
        .prepare('SELECT * FROM analysis_attempts WHERE capture_id=? ORDER BY ordinal')
        .all(id)
        .map((row) => ({
          ordinal: row.ordinal,
          kind: row.kind,
          contextRevision: row.context_revision,
          context: decode(row.context),
          annotationRevision: row.annotation_revision,
          state: row.state,
          result: decode(row.result),
          reports: decode(row.reports),
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        }));
    },
    reassessmentPending(id) {
      return Boolean(id && store.getRecord(`reassessment:${id}`)?.pending);
    },
    capturePage({ limit = 200, before } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw error('invalid_page', 'Capture page limit must be an integer from 1 to 200', 400);
      let ordinal;
      if (before !== undefined) {
        if (typeof before !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(before))
          throw error('invalid_page', 'Capture page cursor is invalid', 400);
        const decoded = Buffer.from(before, 'base64url').toString('utf8');
        ordinal = Number(decoded);
        if (
          !/^[1-9]\d{0,15}$/.test(decoded) ||
          !Number.isSafeInteger(ordinal) ||
          Buffer.from(decoded).toString('base64url') !== before
        ) {
          throw error('invalid_page', 'Capture page cursor is invalid', 400);
        }
      }
      const fields = 'rowid AS ordinal,id,envelope,state,result,created_at';
      const rows =
        ordinal === undefined
          ? db.prepare(`SELECT ${fields} FROM captures ORDER BY rowid DESC LIMIT ?`).all(limit + 1)
          : db
              .prepare(`SELECT ${fields} FROM captures WHERE rowid<? ORDER BY rowid DESC LIMIT ?`)
              .all(ordinal, limit + 1);
      const page = rows.slice(0, limit);
      return {
        captures: page.map((row) => ({
          ...decode(row.envelope),
          state: row.state,
          analysis: decode(row.result),
          annotations: store.annotations(row.id),
          reassessment: store.getRecord(`reassessment:${row.id}`),
          createdAt: row.created_at,
        })),
        total: db.prepare('SELECT count(*) AS n FROM captures').get().n,
        limit,
        nextCursor:
          rows.length > limit
            ? Buffer.from(String(page.at(-1).ordinal)).toString('base64url')
            : null,
      };
    },
    claimCapture(id) {
      return transaction(() => {
        const rows = id
          ? db.prepare("SELECT * FROM captures WHERE id=? AND state='queued'").all(id)
          : db.prepare("SELECT * FROM captures WHERE state='queued' ORDER BY created_at,id").all();
        for (const row of rows) {
          ensureAnalysisHistory(row);
          const snapshot = analysisContext(decode(row.envelope));
          const history = store.analysisHistory(row.id);
          const pending = store.getRecord(`reassessment:${row.id}`);
          if (pending?.pending) {
            if (
              !pending.explicitRetry &&
              settleReassessment(row, activeAnalysis(row, history), snapshot.revision)
            )
              continue;
            const protectedIdentity = reportsForCapture(row.id).some((report) =>
              protectedReports.has(report.state),
            );
            const spent = new Set(
              history
                .filter((attempt) => attempt.kind === 'reassessment')
                .map((attempt) => attempt.contextRevision),
            );
            const retry =
              pending.explicitRetry &&
              pending.contextRevision === snapshot.revision &&
              spent.has(snapshot.revision);
            const alreadyAttempted =
              !retry && history.some((attempt) => attempt.contextRevision === snapshot.revision);
            const exhausted = !spent.has(snapshot.revision) && spent.size >= reassessmentLimit;
            const empty = !(snapshot.context.lists ?? []).some((list) => list.enabled);
            if (protectedIdentity || alreadyAttempted || empty || exhausted) {
              const previousState = decode(row.result)?.state ?? 'interrupted';
              db.prepare('UPDATE captures SET state=?,updated_at=? WHERE id=?').run(
                previousState,
                now(),
                row.id,
              );
              store.setRecord(`reassessment:${row.id}`, {
                pending: true,
                state: 'deferred',
                contextRevision: snapshot.revision,
                reason: protectedIdentity
                  ? 'protected_publication'
                  : exhausted
                    ? 'reassessment_budget_exhausted'
                    : empty
                      ? 'list_context_missing'
                      : 'context_already_observed',
              });
              continue;
            }
            store.setRecord(`reassessment:${row.id}`, {
              pending: true,
              state: 'analyzing',
              contextRevision: snapshot.revision,
            });
          }
          const ordinal = (history.at(-1)?.ordinal ?? 0) + 1;
          const at = now();
          db.prepare(
            `INSERT INTO analysis_attempts
            (capture_id,ordinal,kind,context_revision,context,annotation_revision,state,started_at)
            VALUES (?,?,?,?,?,?,'analyzing',?)`,
          ).run(
            row.id,
            ordinal,
            pending?.pending ? 'reassessment' : history.length ? 'retry' : 'initial',
            snapshot.revision,
            JSON.stringify(snapshot.context),
            snapshot.annotationRevision,
            at,
          );
          db.prepare("UPDATE captures SET state='analyzing',updated_at=? WHERE id=?").run(
            at,
            row.id,
          );
          return store.capture(row.id);
        }
        return null;
      });
    },
    finishCapture(id, result, reports = []) {
      if (!['accepted', 'abstained', 'failed', 'cancelled'].includes(result?.state)) {
        throw error('invalid_analysis_state', 'Invalid terminal analysis state', 400);
      }
      return transaction(() => {
        const row = db.prepare('SELECT * FROM captures WHERE id=?').get(id);
        if (!row || row.state !== 'analyzing')
          throw error('capture_not_claimed', 'Capture is not claimed for analysis');
        const attempt = db
          .prepare(
            "SELECT * FROM analysis_attempts WHERE capture_id=? AND state='analyzing' ORDER BY ordinal DESC LIMIT 1",
          )
          .get(id);
        const stale =
          attempt?.kind === 'reassessment' &&
          attempt.context_revision !== analysisContext(decode(row.envelope)).revision;
        const changed = db
          .prepare(
            "UPDATE captures SET state=?,result=?,updated_at=? WHERE id=? AND state='analyzing'",
          )
          .run(
            stale ? (decode(row.result)?.state ?? 'interrupted') : result.state,
            stale ? row.result : JSON.stringify(result),
            now(),
            id,
          ).changes;
        if (!changed) throw error('capture_not_claimed', 'Capture is not claimed for analysis');
        if (attempt)
          db.prepare(
            'UPDATE analysis_attempts SET state=?,result=?,reports=?,finished_at=? WHERE capture_id=? AND ordinal=?',
          ).run(
            result.state,
            JSON.stringify(result),
            JSON.stringify(reports),
            now(),
            id,
            attempt.ordinal,
          );
        if (stale) {
          store.setRecord(`reassessment:${id}`, {
            pending: true,
            state: 'deferred',
            contextRevision: attempt.context_revision,
            reason: 'analysis_context_changed',
          });
        } else if (attempt?.kind === 'reassessment') {
          store.setRecord(`reassessment:${id}`, {
            pending: result.state !== 'accepted',
            state: result.state,
            contextRevision: attempt.context_revision,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          if (result.state === 'accepted' && !replaceDerived(id, result, reports)) {
            store.setRecord(`reassessment:${id}`, {
              pending: true,
              state: 'deferred',
              contextRevision: attempt.context_revision,
              reason: 'protected_publication',
            });
          } else if (result.state === 'accepted') {
            store.setRecord(`analysis-active:${id}`, { ordinal: attempt.ordinal });
          }
        } else {
          for (const finding of result.findings ?? []) {
            if (!finding.id)
              throw error('invalid_finding', 'Worker-assigned finding ID is missing', 400);
            db.prepare('INSERT INTO findings (id,capture_id,payload) VALUES (?,?,?)').run(
              finding.id,
              id,
              JSON.stringify({ ...finding, captureId: id }),
            );
          }
          for (const report of reports) saveReport(report);
          if (attempt && result.state === 'accepted')
            store.setRecord(`analysis-active:${id}`, { ordinal: attempt.ordinal });
        }
        queueReassessment(id);
        return store.captureStatus(id);
      });
    },
    retryCapture(id) {
      return transaction(() => {
        const row = db.prepare('SELECT * FROM captures WHERE id=?').get(id);
        if (!row || !['failed', 'cancelled', 'interrupted', 'abstained'].includes(row.state))
          return false;
        ensureAnalysisHistory(row);
        db.prepare("UPDATE captures SET state='queued',updated_at=? WHERE id=?").run(now(), id);
        const pending = store.getRecord(`reassessment:${id}`);
        if (pending?.pending)
          store.setRecord(`reassessment:${id}`, {
            ...pending,
            state: 'queued',
            explicitRetry: true,
          });
        return true;
      });
    },
    saveReport(report) {
      return transaction(() => saveReport(report));
    },
    reviseReport(id, prepared) {
      return transaction(() => reviseReport(id, prepared));
    },
    annotateCapture(id, input) {
      const capture = store.capture(id);
      if (!capture) throw error('capture_not_found', 'Capture not found', 404);
      const note = validateAnnotations(input, capture);
      return transaction(() => {
        if (
          store.leases().some((lease) => lease.name === `evidence:${id}`) ||
          store.reports().some((item) => item.captureId === id && item.state === 'sending')
        ) {
          throw error(
            'publication_in_progress',
            'Wait for the current publication before editing its context',
          );
        }
        const revision = captureDigest(note);
        store.setRecord(`annotations-history:${id}:${revision}`, note);
        store.setRecord(`annotations:${id}`, { ...note, revision });
        for (const item of store
          .reports()
          .filter((item) => item.captureId === id && ['ready', 'dry-run'].includes(item.state))) {
          db.prepare("UPDATE reports SET state='deferred',outcome=?,updated_at=? WHERE id=?").run(
            JSON.stringify({ state: 'deferred', reason: 'context_updated' }),
            now(),
            item.id,
          );
        }
        queueReassessment(id);
        return { id, revision };
      });
    },
    annotations(id) {
      return store.getRecord(`annotations:${id}`);
    },
    report(id) {
      return reportRow(db.prepare('SELECT * FROM reports WHERE id=?').get(id));
    },
    reports() {
      return db.prepare('SELECT * FROM reports ORDER BY created_at,id').all().map(reportRow);
    },
    claimReport() {
      return transaction(() => {
        const row = db
          .prepare("SELECT * FROM reports WHERE state='ready' ORDER BY created_at,id")
          .all()
          .find((row) => {
            const report = reportRow(row);
            return !store.reassessmentPending(
              report.captureId ?? store.finding(report.findingId)?.captureId,
            );
          });
        if (!row) return null;
        db.prepare("UPDATE reports SET state='sending',updated_at=? WHERE id=?").run(now(), row.id);
        return store.report(row.id);
      });
    },
    finishReport(id, outcome) {
      if (
        ![
          'created',
          'appended',
          'deferred',
          'uncertain',
          'failed',
          'dry-run',
          'unsupported',
        ].includes(outcome?.state)
      ) {
        throw error('invalid_publication_state', 'Invalid publication outcome', 400);
      }
      const before = store.report(id);
      if (!before) throw error('report_not_found', 'Report not found', 404);
      if (['created', 'appended'].includes(before.state)) return before;
      db.prepare('UPDATE reports SET state=?,outcome=?,updated_at=? WHERE id=?').run(
        outcome.state,
        JSON.stringify(outcome),
        now(),
        id,
      );
      return store.report(id);
    },
    readyDryRuns() {
      return db
        .prepare("UPDATE reports SET state='ready',outcome=NULL,updated_at=? WHERE state='dry-run'")
        .run(now()).changes;
    },
    findings() {
      return db
        .prepare('SELECT payload FROM findings ORDER BY rowid')
        .all()
        .map((row) => decode(row.payload));
    },
    finding(id) {
      // Legacy drafts can lack a finding ID; Node 22/24 SQLite cannot bind undefined.
      if (id === undefined || id === null) return null;
      return decode(db.prepare('SELECT payload FROM findings WHERE id=?').get(id)?.payload);
    },
    updateFinding(id, payload) {
      const current = store.finding(id);
      if (!current) throw error('finding_not_found', 'Finding not found', 404);
      if (store.reassessmentPending(current.captureId)) return;
      db.prepare('UPDATE findings SET payload=? WHERE id=?').run(
        JSON.stringify({ ...payload, id, captureId: current.captureId }),
        id,
      );
    },
    recoverInterrupted() {
      return transaction(() => {
        for (const row of db.prepare("SELECT id FROM captures WHERE state='analyzing'").all()) {
          db.prepare(
            "UPDATE analysis_attempts SET state='interrupted',finished_at=? WHERE capture_id=? AND state='analyzing'",
          ).run(now(), row.id);
          const pending = store.getRecord(`reassessment:${row.id}`);
          if (pending?.pending)
            store.setRecord(`reassessment:${row.id}`, {
              ...pending,
              state: 'interrupted',
              reason: 'analysis_interrupted',
            });
        }
        return {
          evidenceLeases: db.prepare("DELETE FROM leases WHERE name LIKE 'evidence:%'").run()
            .changes,
          captures: db
            .prepare("UPDATE captures SET state='interrupted',updated_at=? WHERE state='analyzing'")
            .run(now()).changes,
          reports: db
            .prepare("UPDATE reports SET state='uncertain',updated_at=? WHERE state='sending'")
            .run(now()).changes,
          entries: db
            .prepare("UPDATE run_entries SET state='interrupted' WHERE state='running'")
            .run().changes,
        };
      });
    },
    acquireLease(name, owner) {
      if (!name || !owner) throw error('invalid_lease', 'Lease name and owner are required', 400);
      const changed = db
        .prepare(
          'INSERT INTO leases (name,owner,acquired_at) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING',
        )
        .run(name, owner, now()).changes;
      return (
        changed === 1 ||
        db.prepare('SELECT owner FROM leases WHERE name=?').get(name)?.owner === owner
      );
    },
    releaseLease(name, owner) {
      return (
        db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name, owner).changes === 1
      );
    },
    leases() {
      return db
        .prepare('SELECT name,owner,acquired_at AS acquiredAt FROM leases')
        .all()
        .map((row) => ({ ...row }));
    },
    journal(name) {
      return {
        async read() {
          return store.getRecord(`journal:${name}`);
        },
        async write(snapshot) {
          store.setRecord(`journal:${name}`, snapshot);
        },
        async clear() {
          db.prepare('DELETE FROM records WHERE key=?').run(`journal:${name}`);
        },
      };
    },
    journals() {
      return db
        .prepare("SELECT key,value FROM records WHERE key LIKE 'journal:%'")
        .all()
        .map((row) => ({ name: row.key.slice(8), snapshot: decode(row.value) }));
    },
    setRecord(key, value) {
      db.prepare(
        'INSERT INTO records (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, JSON.stringify(value));
    },
    getRecord(key) {
      return decode(db.prepare('SELECT value FROM records WHERE key=?').get(key)?.value);
    },
    listRecords(prefix, { after, limit = 100 } = {}) {
      if (
        typeof prefix !== 'string' ||
        !prefix.length ||
        prefix.includes('\0') ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        (after !== undefined &&
          (typeof after !== 'string' || !after.startsWith(prefix) || after.includes('\0')))
      ) {
        throw error(
          'invalid_record_page',
          'Use a nonempty literal prefix, a matching cursor and a limit from 1 to 1000',
          400,
        );
      }
      const rows = db
        .prepare(
          `SELECT key,value FROM records
        WHERE key>=? AND substr(key,1,length(?))=? COLLATE BINARY${after === undefined ? '' : ' AND key>?'}
        ORDER BY key COLLATE BINARY LIMIT ?`,
        )
        .all(prefix, prefix, prefix, ...(after === undefined ? [] : [after]), limit + 1);
      const records = rows
        .slice(0, limit)
        .map((row) => ({ key: row.key, value: decode(row.value) }));
      const complete = rows.length <= limit;
      return { records, nextCursor: complete ? null : records.at(-1).key, complete };
    },
    createRun(corpus, options = {}) {
      return transaction(() => {
        if (!Array.isArray(corpus?.entries))
          throw error('invalid_corpus', 'Corpus entries are required', 400);
        const id = randomUUID();
        const at = now();
        db.prepare(
          'INSERT INTO runs (id,corpus,options,created_at,updated_at) VALUES (?,?,?,?,?)',
        ).run(id, JSON.stringify(corpus), JSON.stringify(options), at, at);
        const insert = db.prepare(
          'INSERT INTO run_entries (run_id,id,ordinal,payload,state) VALUES (?,?,?,?,?)',
        );
        for (const [ordinal, entry] of corpus.entries.entries())
          insert.run(id, entry.id, ordinal, JSON.stringify(entry), 'pending');
        return store.run(id);
      });
    },
    run(id) {
      const row = db.prepare('SELECT * FROM runs WHERE id=?').get(id);
      if (!row) return null;
      const counts = Object.fromEntries(entryStates.map((state) => [state, 0]));
      for (const item of db
        .prepare('SELECT state,count(*) AS n FROM run_entries WHERE run_id=? GROUP BY state')
        .all(id))
        counts[item.state] = item.n;
      return {
        id,
        corpus: decode(row.corpus),
        options: decode(row.options),
        counts,
        state: counts.running
          ? 'running'
          : counts.pending
            ? 'pending'
            : counts.interrupted
              ? 'interrupted'
              : 'finished',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    entries(runId) {
      return db
        .prepare('SELECT payload,state,result FROM run_entries WHERE run_id=? ORDER BY ordinal')
        .all(runId)
        .map((row) => ({ ...decode(row.payload), state: row.state, result: decode(row.result) }));
    },
    claimEntry(runId) {
      return transaction(() => {
        const row = db
          .prepare(
            "SELECT id,payload FROM run_entries WHERE run_id=? AND state='pending' ORDER BY ordinal LIMIT 1",
          )
          .get(runId);
        if (!row) return null;
        db.prepare("UPDATE run_entries SET state='running' WHERE run_id=? AND id=?").run(
          runId,
          row.id,
        );
        db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(now(), runId);
        return decode(row.payload);
      });
    },
    finishEntry(runId, id, result) {
      if (!entryStates.slice(2).includes(result?.state))
        throw error('invalid_entry_state', 'Invalid terminal entry state', 400);
      const changed = db
        .prepare(
          "UPDATE run_entries SET state=?,result=? WHERE run_id=? AND id=? AND state='running'",
        )
        .run(result.state, JSON.stringify(result), runId, id).changes;
      if (!changed) throw error('entry_not_claimed', 'Run entry is not claimed');
      db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(now(), runId);
    },
    resumeRun(runId, { retryFailed = false } = {}) {
      return db
        .prepare(
          `UPDATE run_entries SET state='pending',result=NULL WHERE run_id=? AND state IN ('interrupted','cancelled'${retryFailed ? ",'failed','inconclusive'" : ''})`,
        )
        .run(runId).changes;
    },
    cancelPending(runId) {
      return db
        .prepare("UPDATE run_entries SET state='cancelled' WHERE run_id=? AND state='pending'")
        .run(runId).changes;
    },
    saveCatalog(result) {
      return transaction(() => {
        const upsert = db.prepare(
          'INSERT INTO catalog (id,payload,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',
        );
        const snapshot = result.currentSnapshot;
        const authoritative =
          snapshot?.source === result.source &&
          ['ubo', 'adguard', 'filterlists'].includes(result.source) &&
          result.counts?.complete === true &&
          !(result.errors ?? []).length &&
          /^[a-f0-9]{64}$/.test(snapshot.digest ?? '') &&
          Number.isFinite(Date.parse(snapshot.retrievedAt));
        const scopeKey = `catalog-current:${result.source}`;
        const previous = store.getRecord(scopeKey);
        const newer =
          authoritative &&
          (!previous || Date.parse(snapshot.retrievedAt) > Date.parse(previous.retrievedAt));
        const incoming = new Set((result.records ?? []).map((record) => record.id));
        for (const record of result.records ?? []) {
          const existing = db.prepare('SELECT payload FROM catalog WHERE id=?').get(record.id);
          const membership = store.getRecord(`catalog-membership:${record.id}`);
          store.setRecord(`catalog-history:${record.id}:${captureDigest(record)}`, record);
          // Once managed by a current snapshot, historical and partial imports are evidence only.
          if (membership && !newer) continue;
          if (
            newer &&
            (record.source !== result.source ||
              (membership && membership.source !== result.source) ||
              (existing && decode(existing.payload).source !== result.source))
          )
            throw error('invalid_catalog_snapshot', 'Snapshot contains a foreign source');
          if (existing)
            store.setRecord(
              `catalog-history:${record.id}:${captureDigest(decode(existing.payload))}`,
              decode(existing.payload),
            );
          upsert.run(record.id, JSON.stringify(record), now());
          if (newer)
            store.setRecord(`catalog-membership:${record.id}`, {
              source: result.source,
              retired: false,
              snapshot,
            });
        }
        if (newer) {
          for (const row of db.prepare('SELECT id,payload FROM catalog').all()) {
            const membership = store.getRecord(`catalog-membership:${row.id}`);
            if (membership?.source === result.source && !incoming.has(row.id))
              store.setRecord(`catalog-membership:${row.id}`, {
                ...membership,
                retired: true,
                snapshot,
              });
          }
          store.setRecord(scopeKey, snapshot);
        }
        store.setRecord(`import:${result.source}`, {
          source: result.source,
          counts: result.counts,
          errors: result.errors ?? [],
          at: now(),
        });
        return (result.records ?? []).length;
      });
    },
    catalog({ includeRetired = false } = {}) {
      return db
        .prepare('SELECT id,payload,health FROM catalog ORDER BY id')
        .all()
        .filter(
          (row) => includeRetired || !store.getRecord(`catalog-membership:${row.id}`)?.retired,
        )
        .map((row) => ({
          ...decode(row.payload),
          health: decode(row.health),
          ...(store.getRecord(`catalog-membership:${row.id}`)?.retired ? { retired: true } : {}),
        }));
    },
    saveHealth(id, health) {
      db.prepare('UPDATE catalog SET health=?,updated_at=? WHERE id=?').run(
        JSON.stringify(health),
        now(),
        id,
      );
    },
    event(kind, message, data = {}) {
      db.prepare('INSERT INTO events (at,kind,message,data) VALUES (?,?,?,?)').run(
        now(),
        kind,
        message,
        JSON.stringify(data),
      );
      db.prepare(
        'DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-1000 FROM events)',
      ).run();
    },
    summary() {
      const { captures, ...capturePage } = store.capturePage();
      const runs = db
        .prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 100')
        .all()
        .map(({ id }) => store.run(id));
      return {
        captures,
        capturePage,
        findings: store.findings(),
        reports: store
          .reports()
          .map((report) => ({ ...report, followUp: store.getRecord(`followup:${report.id}`) })),
        runs,
        catalog: store.catalog().map(({ raw, ...record }) => record),
        catalogImports: db
          .prepare("SELECT value FROM records WHERE key LIKE 'import:%' ORDER BY key")
          .all()
          .map((row) => decode(row.value)),
        journals: store.journals(),
        leases: store.leases(),
        events: db
          .prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100')
          .all()
          .map((row) => ({ ...row, data: decode(row.data) })),
        totals: {
          captures: db.prepare('SELECT count(*) AS n FROM captures').get().n,
          findings: db.prepare('SELECT count(*) AS n FROM findings').get().n,
          reports: db.prepare('SELECT count(*) AS n FROM reports').get().n,
          catalog: store.catalog().length,
        },
      };
    },
  };
  return store;
}
