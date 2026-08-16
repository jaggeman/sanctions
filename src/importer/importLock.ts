import { db } from '../shared/firebase';
import { SanctionSource } from '../shared/types';
import { logger } from '../shared/logger';

const log = logger.child({ module: 'importer.importLock' });

export const LOCKS_COLLECTION = 'import_locks';

// issue #184: a lock held past 15 minutes is treated as abandoned/stale
// (e.g. from an ungraceful crash or timeout) and can be overwritten.
// Same generous threshold used by importRecord.ts (STALE_PENDING_THRESHOLD_MS).
export const STALE_LOCK_THRESHOLD_MS = 15 * 60 * 1000;

export interface SourceImportLock {
  source: SanctionSource;
  lockedAt: string;
  importId?: string | null;
}

/**
 * Thrown when attempting to start an import session for a source that is
 * already locked by an active import (issue #184).
 */
export class SourceImportLockedError extends Error {
  constructor(public readonly source: SanctionSource) {
    super(`An import for source "${source}" is currently in progress. Try again shortly.`);
    this.name = 'SourceImportLockedError';
  }
}

function isLockStale(lock: SourceImportLock): boolean {
  const lockTime = new Date(lock.lockedAt).getTime();
  return Number.isNaN(lockTime) || Date.now() - lockTime > STALE_LOCK_THRESHOLD_MS;
}

/**
 * Atomically acquires a per-source import lock in Firestore.
 *
 * Prevents concurrent import runs (e.g. CLI vs scheduled fetch, or concurrent CLI runs)
 * from racing against the same source snapshot in diff.ts (issue #184).
 *
 * If a prior lock exists and has not expired (within STALE_LOCK_THRESHOLD_MS),
 * throws SourceImportLockedError. If stale, overwrites the lock.
 *
 * Returns a release callback to release the lock on completion or abort.
 */
export async function acquireSourceLock(
  source: SanctionSource,
  importId?: string,
): Promise<() => Promise<void>> {
  const lockRef = db.collection(LOCKS_COLLECTION).doc(source);

  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(lockRef);
    if (snap.exists) {
      const existing = snap.data() as SourceImportLock;
      if (!isLockStale(existing)) {
        throw new SourceImportLockedError(source);
      }
      log.warn('import_lock.overwriting_stale_lock', {
        source,
        previousLockedAt: existing.lockedAt,
      });
    }

    tx.set(lockRef, {
      source,
      lockedAt: new Date().toISOString(),
      importId: importId || null,
    });
  });

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await releaseSourceLock(source);
    } catch (err) {
      log.warn('import_lock.release_failed', { source, err });
    }
  };
}

/**
 * Releases a per-source import lock.
 */
export async function releaseSourceLock(source: SanctionSource): Promise<void> {
  const lockRef = db.collection(LOCKS_COLLECTION).doc(source);
  await lockRef.delete().catch((err: any) => {
    log.warn('import_lock.delete_failed', { source, err });
  });
}

/**
 * Checks if a source currently has an active, non-stale lock.
 */
export async function isSourceLocked(source: SanctionSource): Promise<boolean> {
  const lockRef = db.collection(LOCKS_COLLECTION).doc(source);
  const snap = await lockRef.get();
  if (!snap.exists) return false;
  const existing = snap.data() as SourceImportLock;
  return !isLockStale(existing);
}
