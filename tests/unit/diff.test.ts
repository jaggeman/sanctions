import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';

const { mockGet, mockSelect, mockWhere, mockCollection, mockRunTransaction, mockUploadRecords, mockDelistRecords } =
  vi.hoisted(() => {
    const mockGet = vi.fn();
    const mockSelect = vi.fn(() => ({ get: mockGet }));
    const mockWhere = vi.fn(() => ({ select: mockSelect }));
    const mockDocRef = {
      get: vi.fn(async () => ({ exists: false })),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const mockCollection = vi.fn((name?: string) => {
      if (name === 'sanctions') return { where: mockWhere };
      return {
        doc: vi.fn(() => mockDocRef),
        where: mockWhere,
      };
    });
    const mockRunTransaction = vi.fn(async (updateFn: any) =>
      updateFn({
        get: vi.fn(async () => ({ exists: false })),
        set: vi.fn(),
        delete: vi.fn(),
      }),
    );
    const mockUploadRecords = vi.fn();
    const mockDelistRecords = vi.fn();
    return { mockGet, mockSelect, mockWhere, mockCollection, mockRunTransaction, mockUploadRecords, mockDelistRecords };
  });

vi.mock('../../src/shared/firebase', () => ({
  db: { collection: mockCollection, runTransaction: mockRunTransaction },
  default: { collection: mockCollection, runTransaction: mockRunTransaction },
}));

vi.mock('../../src/importer/uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/importer/uploader')>();
  return {
    ...actual,
    uploadRecords: mockUploadRecords,
    delistRecords: mockDelistRecords,
  };
});

import { computeContentHash } from '../../src/importer/uploader';
import { DelistGuardError, startDiffSession, SAMPLE_LIMIT } from '../../src/importer/diff';

function makeRecord(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    names: [{ wholeName: 'Jane Doe', strong: true }],
    searchNames: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockExistingSnapshot(docs: Array<{ id: string; status?: string; contentHash?: string; primaryName?: string }>) {
  mockGet.mockResolvedValueOnce({
    forEach: (cb: (doc: any) => void) => {
      docs.forEach((d) => cb({
        id: d.id,
        data: () => ({
          status: d.status,
          contentHash: d.contentHash,
          names: d.primaryName !== undefined ? [{ wholeName: d.primaryName, strong: true }] : undefined,
        }),
      }));
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// issue #185: computeDiff/runDiffForSource (the unused non-streaming "batch"
// API) were deleted as dead code — nothing in src/ called them, and they had
// already drifted from startDiffSession (missing the CUSTOM-record guard).
// The classification/guard/apply logic they exercised is real and shared, so
// these tests are ported onto startDiffSession/addChunk/finish — the actual
// shipped path — rather than deleted along with the dead code.
describe('startDiffSession — classification (ported from removed computeDiff, issue #185)', () => {
  it('classifies a record with no existing doc as added', async () => {
    mockExistingSnapshot([]);
    const record = makeRecord({ id: 'EU-new' });

    const session = await startDiffSession('EU', { mode: 'append' });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(mockCollection).toHaveBeenCalledWith('sanctions');
    expect(mockWhere).toHaveBeenCalledWith('source', '==', 'EU');
    expect(diff.counts).toMatchObject({ parsed: 1, added: 1, updated: 0, unchanged: 0, delisted: 0 });
  });

  it('classifies a record with an identical content hash as unchanged', async () => {
    const record = makeRecord({ id: 'EU-1' });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: computeContentHash(record) }]);

    const session = await startDiffSession('EU', { mode: 'append' });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.counts).toMatchObject({ added: 0, updated: 0, unchanged: 1, delisted: 0 });
  });

  it('classifies a record with a changed content hash as updated', async () => {
    const record = makeRecord({ id: 'EU-1', names: [{ wholeName: 'Jane Changed', strong: true }] });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: 'stale-hash' }]);

    const session = await startDiffSession('EU', { mode: 'append' });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.counts).toMatchObject({ added: 0, updated: 1, unchanged: 0, delisted: 0 });
  });

  it('classifies a previously-delisted record that reappears as updated, even if content is identical', async () => {
    const record = makeRecord({ id: 'EU-1' });
    mockExistingSnapshot([{ id: 'EU-1', status: 'delisted', contentHash: computeContentHash(record) }]);

    const session = await startDiffSession('EU', { mode: 'append' });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.counts).toMatchObject({ added: 0, updated: 1, unchanged: 0, delisted: 0 });
  });

  it('append mode never computes a delist set, regardless of what is missing', async () => {
    mockExistingSnapshot([
      { id: 'EU-1', status: 'active', contentHash: 'h1' },
      { id: 'EU-2', status: 'active', contentHash: 'h2' },
    ]);

    const session = await startDiffSession('EU', { mode: 'append' });
    await session.addChunk([]);
    const diff = await session.finish();

    expect(diff.toDelistIds).toEqual([]);
    expect(diff.counts.delisted).toBe(0);
    expect(diff.guardTripped).toBe(false);
  });

  it('sync mode marks active records missing from the file as delisted', async () => {
    const record = makeRecord({ id: 'EU-1' });
    mockExistingSnapshot([
      { id: 'EU-1', status: 'active', contentHash: computeContentHash(record) },
      { id: 'EU-2', status: 'active', contentHash: 'h2' },
      { id: 'EU-3', status: 'delisted', contentHash: 'h3' }, // already delisted, not re-flagged
    ]);

    // 1 of 2 active records missing -> 50% delisted, over the guard
    // threshold; dryRun keeps this a pure classification check rather than
    // exercising the guard itself (that has its own tests below).
    const session = await startDiffSession('EU', { mode: 'sync', dryRun: true });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.toDelistIds).toEqual(['EU-2']);
    expect(diff.counts.delisted).toBe(1);
  });

  it('trips the guard when the delist share exceeds 20% of active records, but does not throw with force', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    // Only 3 of 10 active records survive in the file -> 7/10 = 70% delisted
    const survivors = active.slice(0, 3).map((a) => makeRecord({ id: a.id }));
    const session = await startDiffSession('EU', { mode: 'sync', force: true });
    await session.addChunk(survivors);
    const diff = await session.finish();

    expect(diff.guardTripped).toBe(true);
    expect(diff.toDelistIds).toHaveLength(7);
    expect(diff.activeCount).toBe(10);
  });

  it('does not trip the guard when the delist share is at or below 20%', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    // 8 of 10 survive -> 2/10 = 20%, at the threshold, not over it
    const survivors = active.slice(0, 8).map((a) => makeRecord({ id: a.id }));
    const session = await startDiffSession('EU', { mode: 'sync' });
    await session.addChunk(survivors);
    const diff = await session.finish();

    expect(diff.guardTripped).toBe(false);
    expect(diff.toDelistIds).toHaveLength(2);
  });

  it('never trips the guard when there are no pre-existing active records to compare against', async () => {
    mockExistingSnapshot([]);
    const session = await startDiffSession('EU', { mode: 'sync' });
    await session.addChunk([makeRecord({ id: 'EU-1' })]);
    const diff = await session.finish();

    expect(diff.guardTripped).toBe(false);
    expect(diff.toDelistIds).toEqual([]);
  });
});

describe('startDiffSession — apply/dry-run/force/guard (ported from removed runDiffForSource, issue #185)', () => {
  it('dry-run never calls uploadRecords or delistRecords, even when nothing changed', async () => {
    mockExistingSnapshot([]);
    const record = makeRecord({ id: 'EU-1' });

    const session = await startDiffSession('EU', { mode: 'append', dryRun: true });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.counts.added).toBe(1);
    expect(mockUploadRecords).not.toHaveBeenCalled();
    expect(mockDelistRecords).not.toHaveBeenCalled();
  });

  it('dry-run reports a tripped guard instead of throwing', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    const session = await startDiffSession('EU', { mode: 'sync', dryRun: true });
    await session.addChunk([]);
    const diff = await session.finish();

    expect(diff.guardTripped).toBe(true);
    expect(mockDelistRecords).not.toHaveBeenCalled();
  });

  it('apply mode calls uploadRecords with only the changed subset, never the unchanged records', async () => {
    // 5 pre-existing active records, only EU-2 misses the file: 1/5 = 20%,
    // at the guard threshold rather than over it, so this stays a plain
    // happy-path test of the write wiring, not the guard. EU-1 has a
    // matching hash (unchanged); EU-3/4/5 have stale hashes (updated).
    const unchangedRecord = makeRecord({ id: 'EU-1' });
    const updated3 = makeRecord({ id: 'EU-3' });
    const updated4 = makeRecord({ id: 'EU-4' });
    const updated5 = makeRecord({ id: 'EU-5' });
    mockExistingSnapshot([
      { id: 'EU-1', status: 'active', contentHash: computeContentHash(unchangedRecord) },
      { id: 'EU-2', status: 'active', contentHash: 'h2' },
      { id: 'EU-3', status: 'active', contentHash: 'h3' },
      { id: 'EU-4', status: 'active', contentHash: 'h4' },
      { id: 'EU-5', status: 'active', contentHash: 'h5' },
    ]);
    mockUploadRecords.mockResolvedValueOnce(undefined);
    mockDelistRecords.mockResolvedValueOnce(undefined);

    const session = await startDiffSession('EU', { mode: 'sync', importId: 'import_123' });
    await session.addChunk([unchangedRecord, updated3, updated4, updated5]);
    const diff = await session.finish();

    expect(mockUploadRecords).toHaveBeenCalledWith([updated3, updated4, updated5], 'import_123');
    expect(mockDelistRecords).toHaveBeenCalledWith(['EU-2'], 'import_123');
    expect(diff.toDelistIds).toEqual(['EU-2']);
    expect(diff.counts).toMatchObject({ added: 0, updated: 3, unchanged: 1, delisted: 1 });
  });

  it('a fully unchanged re-import calls neither uploadRecords nor delistRecords', async () => {
    const record = makeRecord({ id: 'EU-1' });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: computeContentHash(record) }]);

    const session = await startDiffSession('EU', { mode: 'sync' });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.counts).toMatchObject({ added: 0, updated: 0, unchanged: 1, delisted: 0 });
    expect(mockUploadRecords).not.toHaveBeenCalled();
    expect(mockDelistRecords).not.toHaveBeenCalled();
  });

  it('apply mode with an empty record set still runs the delist pass (guard forced)', async () => {
    // An empty incoming set delists everything pre-existing, which trips the
    // guard by construction — force:true is exactly the escape hatch a
    // legitimate "this source is now empty" case would use.
    mockExistingSnapshot([{ id: 'EU-2', status: 'active', contentHash: 'h2' }]);
    mockDelistRecords.mockResolvedValueOnce(undefined);

    const session = await startDiffSession('EU', { mode: 'sync', importId: 'import_123', force: true });
    await session.addChunk([]);
    await session.finish();

    expect(mockUploadRecords).not.toHaveBeenCalled();
    expect(mockDelistRecords).toHaveBeenCalledWith(['EU-2'], 'import_123');
  });

  it('apply mode refuses a tripped guard without force', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    const session = await startDiffSession('EU', { mode: 'sync' });
    await session.addChunk([]);

    await expect(session.finish()).rejects.toThrow(DelistGuardError);
    expect(mockUploadRecords).not.toHaveBeenCalled();
    expect(mockDelistRecords).not.toHaveBeenCalled();
  });

  it('apply mode proceeds through a tripped guard when force is set', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);
    mockDelistRecords.mockResolvedValueOnce(undefined);

    const session = await startDiffSession('EU', { mode: 'sync', force: true });
    await session.addChunk([]);
    const diff = await session.finish();

    expect(diff.guardTripped).toBe(true);
    expect(mockDelistRecords).toHaveBeenCalledWith(active.map((a) => a.id), undefined);
  });
});

/**
 * issue #12's own acceptance criterion: "Diff preview: counts for added /
 * updated / unchanged / delisted, plus a sample of actual records in each
 * bucket. Names, not just numbers." Counts already existed; samples did not.
 * Bounded to SAMPLE_LIMIT per bucket so this can never reintroduce the
 * whole-source-in-memory problem the streaming design (#5/#8) exists to
 * avoid — a diff over tens of thousands of records must still only ever
 * hold a handful of sample names, not every record.
 */
describe('startDiffSession — sample records per bucket, single-chunk (ported from removed computeDiff, issue #12/#185)', () => {
  it('samples an added record with its id and primaryName', async () => {
    mockExistingSnapshot([]);
    const record = makeRecord({ id: 'EU-new', names: [{ wholeName: 'Newly Added Person', strong: true }] });

    const session = await startDiffSession('EU', { mode: 'append', dryRun: true });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.samples.added).toEqual([{ id: 'EU-new', primaryName: 'Newly Added Person' }]);
    expect(diff.samples.updated).toEqual([]);
    expect(diff.samples.unchanged).toEqual([]);
    expect(diff.samples.delisted).toEqual([]);
  });

  it('samples an updated record', async () => {
    const record = makeRecord({ id: 'EU-1', names: [{ wholeName: 'Jane Changed', strong: true }] });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: 'stale-hash', primaryName: 'Jane Old' }]);

    const session = await startDiffSession('EU', { mode: 'append', dryRun: true });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.samples.updated).toEqual([{ id: 'EU-1', primaryName: 'Jane Changed' }]);
  });

  it('samples an unchanged record even though it is never written', async () => {
    const record = makeRecord({ id: 'EU-1', names: [{ wholeName: 'Same Person', strong: true }] });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: computeContentHash(record), primaryName: 'Same Person' }]);

    const session = await startDiffSession('EU', { mode: 'append', dryRun: true });
    await session.addChunk([record]);
    const diff = await session.finish();

    expect(diff.samples.unchanged).toEqual([{ id: 'EU-1', primaryName: 'Same Person' }]);
  });

  it('samples a to-be-delisted record using its existing (pre-fetched) primaryName', async () => {
    mockExistingSnapshot([{ id: 'EU-2', status: 'active', contentHash: 'h2', primaryName: 'About To Be Delisted' }]);

    const session = await startDiffSession('EU', { mode: 'sync', dryRun: true });
    await session.addChunk([]);
    const diff = await session.finish();

    expect(diff.samples.delisted).toEqual([{ id: 'EU-2', primaryName: 'About To Be Delisted' }]);
  });

  it(`caps each bucket's sample at SAMPLE_LIMIT (${SAMPLE_LIMIT}) regardless of how many actually match`, async () => {
    mockExistingSnapshot([]);
    const records = Array.from({ length: SAMPLE_LIMIT + 10 }, (_, i) =>
      makeRecord({ id: `EU-${i}`, primaryName: `Person ${i}` }));

    const session = await startDiffSession('EU', { mode: 'append', dryRun: true });
    await session.addChunk(records);
    const diff = await session.finish();

    expect(diff.counts.added).toBe(SAMPLE_LIMIT + 10); // the real count is uncapped
    expect(diff.samples.added).toHaveLength(SAMPLE_LIMIT); // only the sample is capped
  });
});

describe('startDiffSession — sample records per bucket, streaming path (issue #12)', () => {
  it('samples added/updated/unchanged across multiple addChunk calls, and delisted in finish()', async () => {
    const unchangedRecord = makeRecord({ id: 'EU-1', names: [{ wholeName: 'Unchanged Person', strong: true }] });
    // computeContentHash depends on record content — align the mocked hash with it.
    mockExistingSnapshot([
      { id: 'EU-1', status: 'active', contentHash: computeContentHash(unchangedRecord), primaryName: 'Unchanged Person' },
      { id: 'EU-2', status: 'active', contentHash: 'stale-hash', primaryName: 'Old Name' },
      { id: 'EU-3', status: 'active', contentHash: 'h3', primaryName: 'Will Be Delisted' },
    ]);

    const session = await startDiffSession('EU', { mode: 'sync', force: true });
    await session.addChunk([unchangedRecord]);
    await session.addChunk([
      makeRecord({ id: 'EU-2', names: [{ wholeName: 'New Name', strong: true }] }),
      makeRecord({ id: 'EU-new', names: [{ wholeName: 'Fresh Person', strong: true }] }),
    ]);
    const result = await session.finish();

    expect(result.samples.unchanged).toEqual([{ id: 'EU-1', primaryName: 'Unchanged Person' }]);
    expect(result.samples.updated).toEqual([{ id: 'EU-2', primaryName: 'New Name' }]);
    expect(result.samples.added).toEqual([{ id: 'EU-new', primaryName: 'Fresh Person' }]);
    expect(result.samples.delisted).toEqual([{ id: 'EU-3', primaryName: 'Will Be Delisted' }]);
  });

  it('abort() reports no samples at all — nothing should be presented as a preview of a failed run', async () => {
    mockExistingSnapshot([]);
    const session = await startDiffSession('EU', { mode: 'append' });
    await session.addChunk([makeRecord({ id: 'EU-1', names: [{ wholeName: 'Partial', strong: true }] })]);

    const result = session.abort();

    expect(result.samples).toEqual({ added: [], updated: [], unchanged: [], delisted: [] });
  });
});
