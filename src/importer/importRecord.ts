import { db } from '../shared/firebase';
import { ImportRecord, ImportStatus } from '../shared/types';

const COLLECTION = 'imports';

/**
 * Thrown when createPendingImport races another request for the same file —
 * this is the intended, expected outcome of the concurrency-safety mechanism
 * (see createPendingImport), not an error condition to alarm on.
 */
export class ImportAlreadyInFlightError extends Error {}

/**
 * Thrown when createFetchImportRecord encounters an existing document with the
 * same importId (issue #295) — a collision from reusing an importId is a
 * meaningful client error (409 Conflict).
 */
export class ImportAlreadyExistsError extends Error {}

// issue #60: a failed or rejected prior attempt for the same content must
// not block this exact file from ever being uploaded again — retrying is
// always safe for these statuses.
const RETRYABLE_STATUSES: ReadonlySet<ImportStatus> = new Set(['failed', 'rejected']);

// issue #60: a pending import stuck past this long has clearly died with
// its Cloud Function instance (crash, timeout, cold-start eviction) — real
// imports finish in seconds even for the largest source (~25 MB EU export),
// not minutes, so this is a generous margin, not a tight timeout.
const STALE_PENDING_THRESHOLD_MS = 15 * 60 * 1000;

function isStalePending(existing: ImportRecord): boolean {
  return existing.status === 'pending' && Date.now() - new Date(existing.uploadedAt).getTime() > STALE_PENDING_THRESHOLD_MS;
}

/**
 * Atomically creates the pending import doc, keyed by sha256, inside a
 * transaction — the "is a prior attempt retryable" decision and the write
 * itself have to happen as one atomic step, or two concurrent retries of the
 * same failed import could both pass the status check and both proceed to
 * re-run the pipeline, exactly the race issue #7's dedup mechanism exists to
 * prevent. If no doc exists yet, Firestore's own transaction-conflict
 * detection on `tx.create()` still provides the original first-write-wins
 * race safety (concurrent attempts that all see "not exists" get retried by
 * the SDK; only one actually commits).
 *
 * A prior attempt that's still genuinely in flight (pending and fresh) or
 * already applied blocks a new attempt, same as before. A prior attempt that
 * failed, was rejected, or has been pending long enough to have clearly died
 * (issue #60) is retryable — the new attempt replaces it instead of being
 * turned away forever.
 */
export async function createPendingImport(
  record: Omit<ImportRecord, 'status'> & { sha256: string },
): Promise<void> {
  const docRef = db.collection(COLLECTION).doc(record.sha256);

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const snap = await tx.get(docRef);

    if (!snap.exists) {
      tx.create(docRef, { ...record, status: 'pending' });
      return;
    }

    const existing = snap.data() as ImportRecord;

    if (RETRYABLE_STATUSES.has(existing.status) || isStalePending(existing)) {
      tx.set(docRef, { ...record, status: 'pending' });
      return;
    }

    throw new ImportAlreadyInFlightError(`Import ${record.sha256} is already pending or in progress`);
  });
}

/**
 * Creates the pending import doc for a fetch-triggered import (issue #111
 * — POST /api/import, which downloads and parses the EU/UN/US sources
 * directly, unlike an upload which has a file to hash-dedup on). Keyed by
 * `record.importId`, which the caller must have already generated (or
 * accepted from the client and validated against a safe id pattern, per
 * CLAUDE.md §6) — there's no natural dedup key here, so no retry/staleness
 * handling like createPendingImport's: every call gets its own fresh id, and
 * a collision (e.g. a client-supplied importId reused) is a genuine error,
 * not an in-flight race to recover from.
 */
export async function createFetchImportRecord(
  record: Omit<ImportRecord, 'status' | 'trigger'>,
): Promise<void> {
  const docRef = db.collection(COLLECTION).doc(record.importId);
  try {
    await docRef.create({ ...record, trigger: 'fetch', status: 'pending' });
  } catch (error: any) {
    if (error?.code === 6 || error?.code === 'already-exists' || /already exists/i.test(error?.message)) {
      throw new ImportAlreadyExistsError(`Import with ID "${record.importId}" already exists`);
    }
    throw error;
  }
}

export async function findImportBySha256(sha256: string): Promise<ImportRecord | null> {
  const doc = await db.collection(COLLECTION).doc(sha256).get();
  return doc.exists ? (doc.data() as ImportRecord) : null;
}

/** Only ever returns a record that actually completed successfully — the
 * dedup check must not treat a still-pending or failed prior attempt as a
 * reason to reject a new upload. */
export async function findAppliedImportBySha256(sha256: string): Promise<ImportRecord | null> {
  const record = await findImportBySha256(sha256);
  return record?.status === 'applied' ? record : null;
}

export async function markImportApplied(
  sha256: string,
  counts: { parsed: number; uploaded: number },
): Promise<void> {
  await db.collection(COLLECTION).doc(sha256).update({ status: 'applied', counts });
}

export async function markImportFailed(sha256: string, error: string): Promise<void> {
  await db.collection(COLLECTION).doc(sha256).update({ status: 'failed', error });
}

export async function markImportRejected(sha256: string, duplicateOfImportId: string): Promise<void> {
  await db.collection(COLLECTION).doc(sha256).update({ status: 'rejected', duplicateOfImportId });
}

/** Lists import audit records newest first (issue #12 — import history view). */
export async function listImports(limit: number): Promise<ImportRecord[]> {
  const snapshot = await db.collection(COLLECTION).orderBy('uploadedAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc: any) => doc.data() as ImportRecord);
}
