import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createFakeDb } from './helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({
  db: fakeDb,
  default: fakeDb,
}));

const {
  acquireSourceLock,
  releaseSourceLock,
  isSourceLocked,
  SourceImportLockedError,
  STALE_LOCK_THRESHOLD_MS,
} = await import('../../src/importer/importLock');

describe('importLock — per-source concurrency locking (issue #184)', () => {
  beforeEach(() => {
    resetFakeDb();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires lock for an unlocked source and reports isSourceLocked true', async () => {
    expect(await isSourceLocked('EU')).toBe(false);
    const release = await acquireSourceLock('EU', 'import_123');
    expect(await isSourceLocked('EU')).toBe(true);

    await release();
    expect(await isSourceLocked('EU')).toBe(false);
  });

  it('throws SourceImportLockedError when racing another session for the same source', async () => {
    const release = await acquireSourceLock('EU', 'import_1');
    await expect(acquireSourceLock('EU', 'import_2')).rejects.toThrow(SourceImportLockedError);

    await release();
    // After release, acquiring lock succeeds
    const release2 = await acquireSourceLock('EU', 'import_2');
    expect(await isSourceLocked('EU')).toBe(true);
    await release2();
  });

  it('allows different sources to be locked concurrently without conflict', async () => {
    const releaseEU = await acquireSourceLock('EU');
    const releaseUN = await acquireSourceLock('UN');
    const releaseUS = await acquireSourceLock('US');
    const releaseUK = await acquireSourceLock('UK');

    expect(await isSourceLocked('EU')).toBe(true);
    expect(await isSourceLocked('UN')).toBe(true);
    expect(await isSourceLocked('US')).toBe(true);
    expect(await isSourceLocked('UK')).toBe(true);

    await releaseEU();
    await releaseUN();
    await releaseUS();
    await releaseUK();

    expect(await isSourceLocked('EU')).toBe(false);
    expect(await isSourceLocked('UN')).toBe(false);
    expect(await isSourceLocked('US')).toBe(false);
    expect(await isSourceLocked('UK')).toBe(false);
  });

  it('overwrites a stale lock (>15 minutes) instead of blocking indefinitely', async () => {
    vi.useFakeTimers();
    await acquireSourceLock('EU', 'old_import');
    expect(await isSourceLocked('EU')).toBe(true);

    // Advance time past STALE_LOCK_THRESHOLD_MS (15 mins)
    vi.advanceTimersByTime(STALE_LOCK_THRESHOLD_MS + 1000);

    expect(await isSourceLocked('EU')).toBe(false);

    // New lock acquisition should succeed by overwriting stale lock
    const releaseNew = await acquireSourceLock('EU', 'new_import');
    expect(await isSourceLocked('EU')).toBe(true);
    await releaseNew();
  });

  it('release callback is idempotent and does not throw if called multiple times', async () => {
    const release = await acquireSourceLock('EU');
    await release();
    await expect(release()).resolves.toBeUndefined();
  });
});
