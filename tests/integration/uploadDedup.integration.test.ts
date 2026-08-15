import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'path';

/**
 * Integration layer (CLAUDE.md §1) — issue #7's headline acceptance
 * criterion: "The six duplicate copies of 20260805-FULL-1_0.csv result in
 * exactly one applied import." Runs against a REAL Firestore emulator (via
 * `npm run test:integration`), exercising the actual create()-based
 * concurrency-safety mechanism from src/importer/importRecord.ts — a mock
 * can't observe whether Firestore's atomic create-collision behaves the way
 * the code assumes.
 *
 * Storage is deliberately NOT exercised here — no Storage emulator is
 * configured in this environment (see the coordination doc: port contention
 * across concurrent sessions made adding a second emulator not worth the
 * risk this round). This test drives the dedup mechanism (hashFileStreaming
 * + importRecord CRUD) directly rather than through the full processUpload
 * pipeline, which is what would call Storage.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { hashFileStreaming } = await import('../../src/importer/hashFile');
const {
  createPendingImport,
  findAppliedImportBySha256,
  markImportApplied,
  ImportAlreadyInFlightError,
} = await import('../../src/importer/importRecord');

const LISTS_DIR = 'C:/Sanctions/lists';
const DUPLICATE_FILES = [
  '20260805-FULL-1_0.csv',
  '20260805-FULL-1_0 (1).csv',
  '20260805-FULL-1_0 (2).csv',
  '20260805-FULL-1_0 (3).csv',
  '20260805-FULL-1_0 (4).csv',
  '20260805-FULL-1_0 (5).csv',
];

async function clearImports() {
  const snap = await db.collection('imports').get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

/** Mirrors processUpload's dedup-then-create sequence, minus Storage. */
async function attemptUpload(filePath: string, filename: string) {
  const { sha256, sizeBytes } = await hashFileStreaming(filePath);

  const existing = await findAppliedImportBySha256(sha256);
  if (existing) {
    return { outcome: 'rejected' as const, sha256 };
  }

  try {
    await createPendingImport({
      importId: sha256,
      filename,
      sha256,
      sizeBytes,
      storagePath: `imports/${sha256}/${filename}`,
      source: 'EU',
      format: 'eu-csv-1.0',
      fileGenerationDate: '05/08/2026',
      uploadedBy: 'test@example.com',
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ImportAlreadyInFlightError) {
      return { outcome: 'in_flight' as const, sha256 };
    }
    throw err;
  }

  await markImportApplied(sha256, { parsed: 100, uploaded: 100 });
  return { outcome: 'applied' as const, sha256 };
}

beforeEach(async () => {
  await clearImports();
});

afterAll(async () => {
  await clearImports();
});

describe('upload dedup — six real duplicate copies (issue #7 acceptance criterion)', () => {
  it('processes the six copies sequentially: exactly one applied, five rejected', async () => {
    const results = [];
    for (const filename of DUPLICATE_FILES) {
      results.push(await attemptUpload(path.join(LISTS_DIR, filename), filename));
    }

    const applied = results.filter((r) => r.outcome === 'applied');
    const rejected = results.filter((r) => r.outcome === 'rejected');

    expect(applied).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    // All six really did hash identically — this is the premise the whole test rests on.
    expect(new Set(results.map((r) => r.sha256)).size).toBe(1);

    const finalDocs = await db.collection('imports').get();
    expect(finalDocs.size).toBe(1);
    expect(finalDocs.docs[0].data().status).toBe('applied');
  }, 30_000);

  it('processes the six copies concurrently: exactly one wins the create race, the rest collide as in_flight', async () => {
    const results = await Promise.all(
      DUPLICATE_FILES.map((filename) => attemptUpload(path.join(LISTS_DIR, filename), filename)),
    );

    // Run concurrently, every attempt reaches findAppliedImportBySha256 before
    // any of them has applied yet (nothing is applied at the start of this
    // test), so the race is decided entirely by createPendingImport's atomic
    // create() — exactly one create() wins, the rest get in_flight.
    const applied = results.filter((r) => r.outcome === 'applied');
    const inFlight = results.filter((r) => r.outcome === 'in_flight');

    expect(applied).toHaveLength(1);
    expect(inFlight).toHaveLength(5);

    const finalDocs = await db.collection('imports').get();
    expect(finalDocs.size).toBe(1);
  }, 30_000);
});
