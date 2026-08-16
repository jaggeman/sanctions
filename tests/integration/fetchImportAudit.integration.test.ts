import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) — issue #111's acceptance criterion:
 * "Integration test against the Firestore emulator confirms the doc exists
 * and has the expected fields after a run." Exercises the real write path
 * for a fetch-triggered import's audit record (createFetchImportRecord →
 * markImportApplied/markImportFailed), which an offline mock can't verify.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const {
  createFetchImportRecord,
  markImportApplied,
  markImportFailed,
  findImportBySha256,
} = await import('../../src/importer/importRecord');

async function clearImports() {
  const snap = await db.collection('imports').get();
  const batch = db.batch();
  snap.forEach((doc: any) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

beforeEach(async () => {
  await clearImports();
});

afterAll(async () => {
  await clearImports();
});

describe('fetch-triggered import audit trail (issue #111, real Firestore)', () => {
  it('creates a durable pending record, then marks it applied with counts', async () => {
    await createFetchImportRecord({
      importId: 'import_it_applied',
      sources: ['EU', 'UN'],
      mode: 'sync',
      force: false,
      uploadedBy: 'analyst@example.com',
      uploadedAt: new Date().toISOString(),
    });

    let doc = await findImportBySha256('import_it_applied');
    expect(doc?.status).toBe('pending');
    expect(doc?.trigger).toBe('fetch');
    expect(doc?.sources).toEqual(['EU', 'UN']);
    expect(doc?.uploadedBy).toBe('analyst@example.com');

    await markImportApplied('import_it_applied', { parsed: 42, uploaded: 40 });

    doc = await findImportBySha256('import_it_applied');
    expect(doc?.status).toBe('applied');
    expect(doc?.counts).toEqual({ parsed: 42, uploaded: 40 });
  }, 30_000);

  it('creates a durable pending record, then marks it failed with the error', async () => {
    await createFetchImportRecord({
      importId: 'import_it_failed',
      sources: ['US'],
      uploadedBy: 'analyst@example.com',
      uploadedAt: new Date().toISOString(),
    });

    await markImportFailed('import_it_failed', 'network timeout fetching source');

    const doc = await findImportBySha256('import_it_failed');
    expect(doc?.status).toBe('failed');
    expect(doc?.error).toBe('network timeout fetching source');
  }, 30_000);

  it('rejects creating a second record with an importId that already exists', async () => {
    await createFetchImportRecord({
      importId: 'import_it_dup',
      sources: ['EU'],
      uploadedBy: 'analyst@example.com',
      uploadedAt: new Date().toISOString(),
    });

    await expect(
      createFetchImportRecord({
        importId: 'import_it_dup',
        sources: ['UN'],
        uploadedBy: 'other@example.com',
        uploadedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  }, 30_000);
});
