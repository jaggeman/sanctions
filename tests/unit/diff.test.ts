import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';

const { mockGet, mockSelect, mockWhere, mockCollection, mockUploadRecords, mockDelistRecords } =
  vi.hoisted(() => {
    const mockGet = vi.fn();
    const mockSelect = vi.fn(() => ({ get: mockGet }));
    const mockWhere = vi.fn(() => ({ select: mockSelect }));
    const mockCollection = vi.fn(() => ({ where: mockWhere }));
    const mockUploadRecords = vi.fn();
    const mockDelistRecords = vi.fn();
    return { mockGet, mockSelect, mockWhere, mockCollection, mockUploadRecords, mockDelistRecords };
  });

vi.mock('../../src/shared/firebase', () => ({
  db: { collection: mockCollection },
  default: { collection: mockCollection },
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
import { computeDiff, runDiffForSource, DelistGuardError } from '../../src/importer/diff';

function makeRecord(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    primaryName: 'Jane Doe',
    aliases: [],
    searchNames: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockExistingSnapshot(docs: Array<{ id: string; status?: string; contentHash?: string }>) {
  mockGet.mockResolvedValueOnce({
    forEach: (cb: (doc: any) => void) => {
      docs.forEach((d) => cb({ id: d.id, data: () => ({ status: d.status, contentHash: d.contentHash }) }));
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeDiff', () => {
  it('classifies a record with no existing doc as added', async () => {
    mockExistingSnapshot([]);
    const record = makeRecord({ id: 'EU-new' });

    const diff = await computeDiff('EU', [record], { mode: 'append' });

    expect(mockCollection).toHaveBeenCalledWith('sanctions');
    expect(mockWhere).toHaveBeenCalledWith('source', '==', 'EU');
    expect(diff.counts).toMatchObject({ parsed: 1, added: 1, updated: 0, unchanged: 0, delisted: 0 });
  });

  it('classifies a record with an identical content hash as unchanged', async () => {
    const record = makeRecord({ id: 'EU-1' });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: computeContentHash(record) }]);

    const diff = await computeDiff('EU', [record], { mode: 'append' });

    expect(diff.counts).toMatchObject({ added: 0, updated: 0, unchanged: 1, delisted: 0 });
  });

  it('classifies a record with a changed content hash as updated', async () => {
    const record = makeRecord({ id: 'EU-1', primaryName: 'Jane Changed' });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: 'stale-hash' }]);

    const diff = await computeDiff('EU', [record], { mode: 'append' });

    expect(diff.counts).toMatchObject({ added: 0, updated: 1, unchanged: 0, delisted: 0 });
  });

  it('classifies a previously-delisted record that reappears as updated, even if content is identical', async () => {
    const record = makeRecord({ id: 'EU-1' });
    mockExistingSnapshot([{ id: 'EU-1', status: 'delisted', contentHash: computeContentHash(record) }]);

    const diff = await computeDiff('EU', [record], { mode: 'append' });

    expect(diff.counts).toMatchObject({ added: 0, updated: 1, unchanged: 0, delisted: 0 });
  });

  it('append mode never computes a delist set, regardless of what is missing', async () => {
    mockExistingSnapshot([
      { id: 'EU-1', status: 'active', contentHash: 'h1' },
      { id: 'EU-2', status: 'active', contentHash: 'h2' },
    ]);

    const diff = await computeDiff('EU', [], { mode: 'append' });

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

    const diff = await computeDiff('EU', [record], { mode: 'sync' });

    expect(diff.toDelistIds).toEqual(['EU-2']);
    expect(diff.counts.delisted).toBe(1);
  });

  it('trips the guard when the delist share exceeds 20% of active records, but does not throw', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    // Only 3 of 10 active records survive in the file -> 7/10 = 70% delisted
    const survivors = active.slice(0, 3).map((a) => makeRecord({ id: a.id }));
    const diff = await computeDiff('EU', survivors, { mode: 'sync' });

    expect(diff.guardTripped).toBe(true);
    expect(diff.toDelistIds).toHaveLength(7);
    expect(diff.activeCount).toBe(10);
  });

  it('does not trip the guard when the delist share is at or below 20%', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    // 8 of 10 survive -> 2/10 = 20%, at the threshold, not over it
    const survivors = active.slice(0, 8).map((a) => makeRecord({ id: a.id }));
    const diff = await computeDiff('EU', survivors, { mode: 'sync' });

    expect(diff.guardTripped).toBe(false);
    expect(diff.toDelistIds).toHaveLength(2);
  });

  it('never trips the guard when there are no pre-existing active records to compare against', async () => {
    mockExistingSnapshot([]);
    const diff = await computeDiff('EU', [makeRecord({ id: 'EU-1' })], { mode: 'sync' });

    expect(diff.guardTripped).toBe(false);
    expect(diff.toDelistIds).toEqual([]);
  });
});

describe('runDiffForSource', () => {
  it('dry-run never calls uploadRecords or delistRecords, even when nothing changed', async () => {
    mockExistingSnapshot([]);
    const record = makeRecord({ id: 'EU-1' });

    const diff = await runDiffForSource('EU', [record], { mode: 'append', dryRun: true });

    expect(diff.counts.added).toBe(1);
    expect(mockUploadRecords).not.toHaveBeenCalled();
    expect(mockDelistRecords).not.toHaveBeenCalled();
  });

  it('dry-run reports a tripped guard instead of throwing', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    const diff = await runDiffForSource('EU', [], { mode: 'sync', dryRun: true });

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

    const diff = await runDiffForSource(
      'EU',
      [unchangedRecord, updated3, updated4, updated5],
      { mode: 'sync', importId: 'import_123' },
    );

    expect(mockUploadRecords).toHaveBeenCalledWith([updated3, updated4, updated5], 'import_123');
    expect(mockDelistRecords).toHaveBeenCalledWith(['EU-2'], 'import_123');
    expect(diff.toDelistIds).toEqual(['EU-2']);
    expect(diff.counts).toMatchObject({ added: 0, updated: 3, unchanged: 1, delisted: 1 });
  });

  it('a fully unchanged re-import calls neither uploadRecords nor delistRecords', async () => {
    const record = makeRecord({ id: 'EU-1' });
    mockExistingSnapshot([{ id: 'EU-1', status: 'active', contentHash: computeContentHash(record) }]);

    const diff = await runDiffForSource('EU', [record], { mode: 'sync' });

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

    await runDiffForSource('EU', [], { mode: 'sync', importId: 'import_123', force: true });

    expect(mockUploadRecords).not.toHaveBeenCalled();
    expect(mockDelistRecords).toHaveBeenCalledWith(['EU-2'], 'import_123');
  });

  it('apply mode refuses a tripped guard without force', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);

    await expect(runDiffForSource('EU', [], { mode: 'sync' })).rejects.toThrow(DelistGuardError);
    expect(mockUploadRecords).not.toHaveBeenCalled();
    expect(mockDelistRecords).not.toHaveBeenCalled();
  });

  it('apply mode proceeds through a tripped guard when force is set', async () => {
    const active = Array.from({ length: 10 }, (_, i) => ({ id: `EU-${i}`, status: 'active', contentHash: 'h' }));
    mockExistingSnapshot(active);
    mockDelistRecords.mockResolvedValueOnce(undefined);

    const diff = await runDiffForSource('EU', [], { mode: 'sync', force: true });

    expect(diff.guardTripped).toBe(true);
    expect(mockDelistRecords).toHaveBeenCalledWith(active.map((a) => a.id), undefined);
  });
});
