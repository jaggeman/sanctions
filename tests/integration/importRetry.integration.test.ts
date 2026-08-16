import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) — issue #60: createPendingImport's
 * retry/staleness decision now happens inside a Firestore transaction. A
 * mock can fake the read-then-write shape, but only the real emulator can
 * confirm the transaction's atomicity actually holds under concurrent
 * retries — the exact guarantee issue #7's dedup mechanism depends on and
 * that this fix must not regress.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const {
  createPendingImport,
  markImportFailed,
  markImportApplied,
  findImportBySha256,
  ImportAlreadyInFlightError,
} = await import('../../src/importer/importRecord');

async function clearImports() {
  const snap = await db.collection('imports').get();
  const batch = db.batch();
  snap.forEach((doc: any) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

function baseRecord(overrides: Record<string, any> = {}) {
  return {
    importId: 'retry-sha',
    filename: 'test.csv',
    sha256: 'retry-sha',
    sizeBytes: 1024,
    storagePath: 'imports/retry-sha/upload.csv',
    source: 'PEP' as const,
    format: 'csv' as const,
    fileGenerationDate: null,
    uploadedBy: 'user@example.com',
    uploadedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearImports();
});

afterAll(async () => {
  await clearImports();
});

describe('createPendingImport — retry after failure/staleness (issue #60, real Firestore)', () => {
  it('lets the same file be uploaded again after the prior attempt failed', async () => {
    await createPendingImport(baseRecord());
    await markImportFailed('retry-sha', 'transient network blip');

    await createPendingImport(baseRecord());
    const doc = await findImportBySha256('retry-sha');
    expect(doc?.status).toBe('pending');

    await markImportApplied('retry-sha', { parsed: 3, uploaded: 3 });
    const applied = await findImportBySha256('retry-sha');
    expect(applied?.status).toBe('applied');
  }, 30_000);

  it('lets the same file be uploaded again once a pending import is stale', async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await createPendingImport(baseRecord({ uploadedAt: longAgo }));

    await createPendingImport(baseRecord({ uploadedAt: new Date().toISOString() }));

    const doc = await findImportBySha256('retry-sha');
    expect(doc?.status).toBe('pending');
    expect(doc?.uploadedAt).not.toBe(longAgo);
  }, 30_000);

  it('still preserves the original create-race safety: six concurrent attempts, one wins', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createPendingImport(baseRecord())),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ImportAlreadyInFlightError,
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);

    const finalDocs = await db.collection('imports').get();
    expect(finalDocs.size).toBe(1);
  }, 30_000);

  it('still blocks a retry while a prior attempt is applied', async () => {
    await createPendingImport(baseRecord());
    await markImportApplied('retry-sha', { parsed: 1, uploaded: 1 });

    await expect(createPendingImport(baseRecord())).rejects.toBeInstanceOf(ImportAlreadyInFlightError);
  }, 30_000);
});
