import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';
import { createFakeDb } from './helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb } = createFakeDb();

vi.mock('../../src/shared/firebase', () => {
  const originalCollection = fakeDb.collection;
  const augmentedDb = {
    ...fakeDb,
    collection: (name: string) => {
      if (name === 'sanctions') {
        return {
          where: (_field: string, _op: string, _val: any) => ({
            select: (..._fields: string[]) => ({
              get: async () => ({
                forEach: (_cb: any) => {},
              }),
            }),
          }),
        };
      }
      return originalCollection(name);
    },
  };
  return {
    db: augmentedDb,
    default: augmentedDb,
  };
});

vi.mock('../../src/importer/uploader', () => ({
  uploadRecords: vi.fn(async () => {}),
  delistRecords: vi.fn(async () => {}),
  computeContentHash: vi.fn(() => 'test-hash'),
  filterAutomatedBatch: vi.fn((r) => r),
}));

const { startDiffSession, runDiffForSource } = await import('../../src/importer/diff');
const { SourceImportLockedError, isSourceLocked } = await import('../../src/importer/importLock');

function makeRecord(id: string): SanctionRecord {
  return {
    id,
    source: 'EU',
    type: 'individual',
    names: [{ wholeName: 'Test Person', strong: true }],
    searchNames: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('startDiffSession & runDiffForSource concurrency locking (issue #184)', () => {
  beforeEach(() => {
    resetFakeDb();
    vi.clearAllMocks();
  });

  it('locks source during active session and releases on finish()', async () => {
    const session1 = await startDiffSession('EU', { mode: 'sync' });
    expect(await isSourceLocked('EU')).toBe(true);

    // Concurrent session for the same source must be rejected
    await expect(startDiffSession('EU', { mode: 'sync' })).rejects.toThrow(SourceImportLockedError);

    // Finishing session1 releases the lock
    await session1.finish();
    expect(await isSourceLocked('EU')).toBe(false);

    // Now another session can run
    const session2 = await startDiffSession('EU', { mode: 'sync' });
    expect(await isSourceLocked('EU')).toBe(true);
    await session2.finish();
    expect(await isSourceLocked('EU')).toBe(false);
  });

  it('releases lock when session is aborted via abort()', async () => {
    const session = await startDiffSession('EU', { mode: 'append' });
    expect(await isSourceLocked('EU')).toBe(true);

    session.abort();
    expect(await isSourceLocked('EU')).toBe(false);

    // Can start a new session after abort
    const session2 = await startDiffSession('EU', { mode: 'append' });
    expect(await isSourceLocked('EU')).toBe(true);
    await session2.finish();
  });

  it('dryRun does not acquire a lock and does not block real imports', async () => {
    const drySession = await startDiffSession('EU', { mode: 'sync', dryRun: true });
    expect(await isSourceLocked('EU')).toBe(false);

    // A real import can start concurrently with a dry-run
    const realSession = await startDiffSession('EU', { mode: 'sync' });
    expect(await isSourceLocked('EU')).toBe(true);

    await realSession.finish();
    await drySession.finish();
  });

  it('runDiffForSource acquires and releases lock', async () => {
    expect(await isSourceLocked('EU')).toBe(false);
    await runDiffForSource('EU', [makeRecord('EU-1')], { mode: 'append' });
    expect(await isSourceLocked('EU')).toBe(false);
  });
});
