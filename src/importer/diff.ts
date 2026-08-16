import { db } from '../shared/firebase';
import { SanctionRecord, SanctionSource, NameAlias, primaryNameOf } from '../shared/types';
import { computeContentHash, uploadRecords, delistRecords, filterAutomatedBatch } from './uploader';

export type ImportMode = 'sync' | 'append';

// A file is opt-in to `sync` (issue #8's own scope: append-style sources —
// PEP, watchlists, custom uploads — must never delist by accident) so a
// caller that forgets to pass `mode` gets the safe behaviour.
export const DEFAULT_IMPORT_MODE: ImportMode = 'append';

// Refuse to delist more than this share of a source's active records without
// an explicit override — a truncated download or the wrong file looks
// identical to the diff engine as "the source delisted everyone" (CLAUDE.md §5).
const DELIST_GUARD_THRESHOLD = 0.2;

// issue #12: the diff preview must show "a sample of actual records in each
// bucket. Names, not just numbers" — capped so a diff over tens of thousands
// of records still only ever holds a handful of names in memory, never every
// record (the same reason the streaming design in this file exists at all).
export const SAMPLE_LIMIT = 5;

export interface SampleRecord {
  id: string;
  primaryName: string;
}

export interface DiffSamples {
  added: SampleRecord[];
  updated: SampleRecord[];
  unchanged: SampleRecord[];
  delisted: SampleRecord[];
}

function emptySamples(): DiffSamples {
  return { added: [], updated: [], unchanged: [], delisted: [] };
}

function pushSample(bucket: SampleRecord[], record: { id: string; names: NameAlias[] }): void {
  if (bucket.length < SAMPLE_LIMIT) bucket.push({ id: record.id, primaryName: primaryNameOf(record.names) });
}

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
  samples: DiffSamples;
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
  // Only for the delisted sample (issue #12) — a to-be-delisted record's
  // display name isn't otherwise available, since it's identified purely by
  // "id present in `existing` but absent from the incoming file."
  names?: NameAlias[];
}

async function fetchExistingSummaries(source: SanctionSource): Promise<Map<string, ExistingSummary>> {
  // id + status + contentHash + names only — fetching whole documents for a
  // ~6k-record source reintroduces the memory problem the streaming-import
  // issue fixed. `names` (issue #46) replaced the scalar `primaryName` this
  // projected before; still far lighter than the full document.
  const snapshot = await db
    .collection('sanctions')
    .where('source', '==', source)
    .select('status', 'contentHash', 'names')
    .get();

  const map = new Map<string, ExistingSummary>();
  snapshot.forEach((doc: any) => {
    const data = doc.data();
    map.set(doc.id, { status: data.status, contentHash: data.contentHash, names: data.names });
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
  const samples = emptySamples();

  for (const record of records) {
    incomingIds.add(record.id);
    const prior = existing.get(record.id);

    if (!prior) {
      added++;
      recordsToWrite.push(record);
      pushSample(samples.added, record);
    } else if (prior.status === 'delisted') {
      // A relist is always a real state transition worth surfacing, even if
      // the content itself is byte-identical to before it was delisted —
      // mirrors uploadRecords' own 'relisted' classification.
      updated++;
      recordsToWrite.push(record);
      pushSample(samples.updated, record);
    } else if (prior.contentHash !== computeContentHash(record)) {
      updated++;
      recordsToWrite.push(record);
      pushSample(samples.updated, record);
    } else {
      unchanged++;
      pushSample(samples.unchanged, record);
    }
  }

  const activeExisting = [...existing.values()].filter((e) => e.status !== 'delisted');
  const activeCount = activeExisting.length;

  let toDelistIds: string[] = [];
  if (options.mode === 'sync') {
    toDelistIds = [...existing.entries()]
      .filter(([id, e]) => e.status !== 'delisted' && !incomingIds.has(id))
      .map(([id]) => id);
    for (const id of toDelistIds) {
      pushSample(samples.delisted, { id, names: existing.get(id)?.names || [] });
    }
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
    samples,
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

/**
 * Streaming counterpart to computeDiff/applyDiff.
 *
 * The batch API above needs every record for a source in one array. That is
 * fine for a few thousand records but not for the real EU and OFAC exports,
 * which is why `runImport` streams them a chunk at a time (issues #5 and
 * #31). A session keeps only what is genuinely small — the source's existing
 * `{id -> status, contentHash}` summary map and the set of ids seen so far —
 * and writes added/updated records as they arrive.
 *
 * Ordering matters for safety. Added/updated writes happen during the stream;
 * the delist pass and its guard run in `finish()`, after the producer has
 * completed without throwing. A truncated file can therefore add or update
 * records — harmless, that data is real — but can never mass-delist, which is
 * what the guard exists to prevent.
 */
export type StreamedDiffResult = Omit<DiffResult, 'recordsToWrite'>;

export interface DiffSession {
  /** Classify a chunk, writing the added/updated subset. Returns how many were written. */
  addChunk(records: SanctionRecord[]): Promise<number>;
  /** Run the delist pass and guard. Only call after the producer finished cleanly. */
  finish(): Promise<StreamedDiffResult>;
  /** Abandon without delisting — for a producer that threw partway through. */
  abort(): StreamedDiffResult;
}

export async function startDiffSession(
  source: SanctionSource,
  options: RunDiffOptions,
): Promise<DiffSession> {
  const existing = await fetchExistingSummaries(source);

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let parsed = 0;
  const incomingIds = new Set<string>();
  const samples = emptySamples();

  const activeCount = [...existing.values()].filter((e) => e.status !== 'delisted').length;

  const summarise = (toDelistIds: string[], guardTripped: boolean): StreamedDiffResult => ({
    source,
    counts: { parsed, added, updated, unchanged, delisted: toDelistIds.length, skipped },
    samples,
    toDelistIds,
    activeCount,
    guardTripped,
  });

  return {
    async addChunk(records: SanctionRecord[]): Promise<number> {
      parsed += records.length;

      // Custom records are owned by the customRecords CRUD path (issue #10) and
      // must never be touched by an automated import — neither written here nor
      // delisted in finish(), since dropping them here also keeps them out of
      // incomingIds. This is the enforcement filterAutomatedBatch's own comment
      // anticipated would move to the diff engine once it existed; reusing that
      // function rather than reimplementing the check keeps one owner of the
      // rule, and its warning log.
      const eligible = source === 'CUSTOM' ? records : filterAutomatedBatch(records);
      skipped += records.length - eligible.length;

      const toWrite: SanctionRecord[] = [];

      for (const record of eligible) {
        incomingIds.add(record.id);
        const prior = existing.get(record.id);

        if (!prior) {
          added++;
          toWrite.push(record);
          pushSample(samples.added, record);
        } else if (prior.status === 'delisted') {
          // A relist is a real state transition even when the content is
          // byte-identical to what was delisted.
          updated++;
          toWrite.push(record);
          pushSample(samples.updated, record);
        } else if (prior.contentHash !== computeContentHash(record)) {
          updated++;
          toWrite.push(record);
          pushSample(samples.updated, record);
        } else {
          unchanged++;
          pushSample(samples.unchanged, record);
        }
      }

      if (toWrite.length === 0 || options.dryRun) return 0;
      await uploadRecords(toWrite, options.importId);
      return toWrite.length;
    },

    async finish(): Promise<StreamedDiffResult> {
      let toDelistIds: string[] = [];
      if (options.mode === 'sync' && source !== 'CUSTOM') {
        toDelistIds = [...existing.entries()]
          .filter(([id, e]) => e.status !== 'delisted' && !incomingIds.has(id))
          .map(([id]) => id);
        for (const id of toDelistIds) {
          pushSample(samples.delisted, { id, names: existing.get(id)?.names || [] });
        }
      }

      const guardTripped =
        activeCount > 0 && toDelistIds.length / activeCount > DELIST_GUARD_THRESHOLD;

      if (guardTripped && !options.force) {
        if (options.dryRun) return summarise(toDelistIds, true);
        throw new DelistGuardError(source, toDelistIds.length, activeCount);
      }

      if (!options.dryRun && toDelistIds.length > 0) {
        await delistRecords(toDelistIds, options.importId);
      }

      return summarise(toDelistIds, guardTripped);
    },

    abort(): StreamedDiffResult {
      // The producer failed, so "absent from the file" cannot be distinguished
      // from "never reached". Delisting nothing is the only safe answer —
      // and for the same reason, no partial sample is trustworthy either:
      // override the accumulated samples rather than reusing summarise()'s,
      // so a failed run never renders as a preview of anything.
      return { ...summarise([], false), samples: emptySamples() };
    },
  };
}
