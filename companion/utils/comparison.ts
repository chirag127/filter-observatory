export interface CaptureEnvironment {
  revision?: string;
  limitations: string[];
}

export type ComparisonObservation =
  { state: 'busy' } | { state: 'idle'; revision?: string } | { state: 'unknown' };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function comparisonObservation(value: unknown): ComparisonObservation {
  if (!record(value)) return { state: 'unknown' };
  const worker = value.worker;
  if (
    (record(worker) && typeof worker.runId === 'string' && worker.runId.length > 0) ||
    (Array.isArray(value.journals) && value.journals.length > 0) ||
    (Array.isArray(value.leases) &&
      value.leases.some(
        (lease) =>
          record(lease) && typeof lease.name === 'string' && lease.name.startsWith('browser:'),
      ))
  ) {
    return { state: 'busy' };
  }
  if (!record(worker) || worker.runId !== null || !Array.isArray(value.journals))
    return { state: 'unknown' };
  if (!Array.isArray(value.runs)) return { state: 'idle' };
  // Retain run progress as well as current activity: a comparison may finish between our two reads.
  const revisions = value.runs
    .filter(record)
    .map((run) => [
      run.id,
      run.updatedAt,
      run.state,
      record(run.counts) ? Object.entries(run.counts).sort(([a], [b]) => a.localeCompare(b)) : null,
    ]);
  revisions.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { state: 'idle', revision: JSON.stringify(revisions) };
}
