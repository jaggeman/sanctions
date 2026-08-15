import { db } from '../shared/firebase';
import { ImportRecord } from '../shared/types';

const COLLECTION = 'imports';

/**
 * Thrown when createPendingImport races another request for the same file —
 * this is the intended, expected outcome of the concurrency-safety mechanism
 * (see createPendingImport), not an error condition to alarm on.
 */
export class ImportAlreadyInFlightError extends Error {}

function isAlreadyExistsError(err: any): boolean {
  return err?.code === 6 || /already exists/i.test(err?.message || '');
}

/**
 * Atomically creates the pending import doc, keyed by sha256. Firestore's
 * .create() fails atomically (ALREADY_EXISTS) if the ID is already taken —
 * that failure IS the race-safety mechanism issue #7 asks for: two
 * concurrent uploads of byte-identical content can't both "win" and both
 * proceed to parse/upload.
 */
export async function createPendingImport(record: Omit<ImportRecord, 'status'>): Promise<void> {
  const docRef = db.collection(COLLECTION).doc(record.sha256);
  try {
    await docRef.create({ ...record, status: 'pending' });
  } catch (err: any) {
    if (isAlreadyExistsError(err)) {
      throw new ImportAlreadyInFlightError(`Import ${record.sha256} is already pending or in progress`);
    }
    throw err;
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
