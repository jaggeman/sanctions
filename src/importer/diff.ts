import { db } from '../shared/firebase';
import { SanctionRecord, SanctionSource } from '../shared/types';
import { computeContentHash, uploadRecords, delistRecords } from './uploader';

export type ImportMode = 'sync' | 'append';

// A file is opt-in to `sync` (issue #8's own scope: append-style sources —
// PEP, watchlists, custom uploads — must never delist by accident) so a
// caller that forgets to pass `mode` gets the safe behaviour.
export const DEFAULT_IMPORT_MODE: ImportMode = 'append';

// Refuse to delist more than this share of a source's active records without
// an explicit override — a truncated download or the wrong file looks
// identical to the diff engine as "the source delisted everyone" (CLAUDE.md §5).
const DELIST_GUARD_THRESHOLD = 0.2;

export interface DiffCounts {
  parsed: number;
  added: number;
  updated: number;
  unchanged: number;
  delisted: number;
  skipped: number;
}

export interface DiffResult {
  source: SanctionSource;
  counts: DiffCounts;
  // Only the added/updated/relisted records — never the truly-unchanged
  // ones. uploadRecords() writes (and bumps updatedAt on) every record it's
  // given, so passing the full incoming set here would defeat the "zero
  // writes for an unchanged re-import" guarantee this engine exists to give.
  recordsToWrite: SanctionRecord[];
  toDelistIds: string[];
  activeCount: number;
  guardTripped: boolean;
}

export interface ComputeDiffOptions {
  mode: ImportMode;
}

export interface RunDiffOptions extends ComputeDiffOptions {
  dryRun?: boolean;
  force?: boolean;
  importId?: string;
}

export class DelistGuardError extends Error {
  constructor(
    public readonly source: SanctionSource,
    public readonly delistCount: number,
    public readonly activeCount: number,
  ) {
    const pct = Math.round((delistCount / activeCount) * 100);
    super(
      `Refusing to delist ${delistCount}/${activeCount} (${pct}%) of active ${source} records — ` +
        `this looks like a truncated or wrong file. Pass force=true to override.`,
    );
    this.name = 'DelistGuardError';
  }
}

interface ExistingSummary {
  status?: string;
  contentHash?: string;
}

async function fetchExistingSummaries(source: SanctionSource): Promise<Map<string, ExistingSummary>> {
  // Only id + status + contentHash — fetching whole documents for a ~6k-record
  // source reintroduces the memory problem the streaming-import issue fixed.
  const snapshot = await db
    .collection('sanctions')
    .where('source', '==', source)
    .select('status', 'contentHash')
    .get();

  const map = new Map<string, ExistingSummary>();
  snapshot.forEach((doc: any) => {
    const data = doc.data();
    map.set(doc.id, { status: data.status, contentHash: data.contentHash });
  });
  return map;
}

/**
 * Pure classification pass: compares incoming records against the source's
 * current state and reports what would happen, without writing anything.
 * Never throws — a tripped delist guard is reported via `guardTripped`, not
 * an exception, so a dry-run is always safe to run.
 */
export async function computeDiff(
  source: SanctionSource,
  records: SanctionRecord[],
  options: ComputeDiffOptions,
): Promise<DiffResult> {
  const existing = await fetchExistingSummaries(source);

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const incomingIds = new Set<string>();
  const recordsToWrite: SanctionRecord[] = [];

  for (const record of records) {
    incomingIds.add(record.id);
    const prior = existing.get(record.id);

    if (!prior) {
      added++;
      recordsToWrite.push(record);
    } else if (prior.status === 'delisted') {
      // A relist is always a real state transition worth surfacing, even if
      // the content itself is byte-identical to before it was delisted —
      // mirrors uploadRecords' own 'relisted' classification.
      updated++;
      recordsToWrite.push(record);
    } else if (prior.contentHash !== computeContentHash(record)) {
      updated++;
      recordsToWrite.push(record);
    } else {
      unchanged++;
    }
  }

  const activeExisting = [...existing.values()].filter((e) => e.status !== 'delisted');
  const activeCount = activeExisting.length;

  let toDelistIds: string[] = [];
  if (options.mode === 'sync') {
    toDelistIds = [...existing.entries()]
      .filter(([id, e]) => e.status !== 'delisted' && !incomingIds.has(id))
      .map(([id]) => id);
  }

  const guardTripped = activeCount > 0 && toDelistIds.length / activeCount > DELIST_GUARD_THRESHOLD;

  return {
    source,
    counts: {
      parsed: records.length,
      added,
      updated,
      unchanged,
      delisted: toDelistIds.length,
      skipped: 0,
    },
    recordsToWrite,
    toDelistIds,
    activeCount,
    guardTripped,
  };
}

/**
 * Writes what `computeDiff` classified: added/updated/relisted records via
 * `uploadRecords` — never the unchanged ones, see `DiffResult.recordsToWrite`
 * — then the delist set via `delistRecords`. Never calls either with an
 * empty array unnecessarily.
 */
export async function applyDiff(diff: DiffResult, importId?: string): Promise<void> {
  if (diff.recordsToWrite.length > 0) {
    await uploadRecords(diff.recordsToWrite, importId);
  }
  if (diff.toDelistIds.length > 0) {
    await delistRecords(diff.toDelistIds, importId);
  }
}

/**
 * Compute + (optionally) apply in one call. Dry-run reports a tripped guard
 * instead of throwing, since a preview must never fail loudly. Applying for
 * real refuses a tripped guard unless `force` is set.
 */
export async function runDiffForSource(
  source: SanctionSource,
  records: SanctionRecord[],
  options: RunDiffOptions,
): Promise<DiffResult> {
  const diff = await computeDiff(source, records, { mode: options.mode });

  if (diff.guardTripped && !options.force) {
    if (options.dryRun) {
      return diff;
    }
    throw new DelistGuardError(source, diff.toDelistIds.length, diff.activeCount);
  }

  if (!options.dryRun) {
    await applyDiff(diff, options.importId);
  }

  return diff;
}
