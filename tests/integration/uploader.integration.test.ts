import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) — exercises uploadRecords against a REAL
 * Firestore emulator, not a mock. This is the layer the unit-level
 * `vi.mock('../../src/shared/firebase')` used elsewhere cannot see: batching
 * behaviour, `merge: true` semantics, and the actual admin SDK write path.
 * Runs via `npm run test:integration`, which wraps this file in
 * `firebase emulators:exec --only firestore`.
 *
 * FIRESTORE_EMULATOR_HOST is set by `firebase emulators:exec` before this
 * process starts, so importing ../../src/shared/firebase here connects
 * firebase-admin to the emulator rather than a real project.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { uploadRecords, generateSearchTokens } = await import('../../src/importer/uploader');

function record(overrides: Record<string, any> = {}) {
  return {
    id: 'PEP-int-1',
    source: 'PEP',
    type: 'individual',
    primaryName: 'Integration Person',
    aliases: ['Alias Person'],
    searchNames: [], // deliberately empty — uploadRecords must fill this in
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function clearCollection() {
  const snap = await db.collection('sanctions').get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

beforeEach(async () => {
  await clearCollection();
});

afterAll(async () => {
  await clearCollection();
});

describe('uploadRecords — real Firestore write path', () => {
  it('writes a record and generates its searchNames server-side', async () => {
    await uploadRecords([record()]);

    const doc = await db.collection('sanctions').doc('PEP-int-1').get();
    expect(doc.exists).toBe(true);
    const data = doc.data()!;
    expect(data.searchNames).toEqual(
      expect.arrayContaining(generateSearchTokens('Integration Person', ['Alias Person'])),
    );
  });

  it('stamps updatedAt with a fresh timestamp on write', async () => {
    const before = new Date().toISOString();
    await uploadRecords([record({ updatedAt: '2000-01-01T00:00:00.000Z' })]);
    const doc = await db.collection('sanctions').doc('PEP-int-1').get();
    expect(doc.data()!.updatedAt >= before).toBe(true);
  });

  it('merges into an existing document instead of overwriting unrelated fields', async () => {
    // Seed a field the uploader doesn't know about, simulating manual
    // enrichment done directly in Firestore.
    await db.collection('sanctions').doc('PEP-int-1').set({ analystNote: 'flagged for review' });

    await uploadRecords([record()]);

    const doc = await db.collection('sanctions').doc('PEP-int-1').get();
    const data = doc.data()!;
    expect(data.analystNote).toBe('flagged for review');
    expect(data.primaryName).toBe('Integration Person');
  });

  it('batches writes across the 500-document boundary', async () => {
    // batchSize is hard-coded to 500 in uploadRecords. Use a small multiple
    // that still crosses two batches without making the test slow.
    const N = 501;
    const records = Array.from({ length: N }, (_, i) =>
      record({ id: `PEP-batch-${i}`, primaryName: `Batch Person ${i}` }),
    );

    await uploadRecords(records);

    const snap = await db.collection('sanctions').get();
    expect(snap.size).toBe(N);
  }, 30_000);

  it('does nothing (no throw) when given an empty array', async () => {
    await expect(uploadRecords([])).resolves.toBeUndefined();
    const snap = await db.collection('sanctions').get();
    expect(snap.empty).toBe(true);
  });
});

describe('uploadRecords — custom records survive an unrelated import (issue #10)', () => {
  it('leaves an existing CUSTOM record byte-identical after uploading unrelated EU-sourced records', async () => {
    const customRecord = record({
      id: 'CUSTOM-1',
      source: 'CUSTOM',
      primaryName: 'Local Watchlist Entry',
      aliases: [],
      searchNames: ['local', 'watchlist', 'entry'],
    });
    await uploadRecords([customRecord]);
    const before = (await db.collection('sanctions').doc('CUSTOM-1').get()).data();

    // Simulates an EU import run — different ids entirely, no reference to
    // the custom record. uploadRecords never queries or deletes anything
    // outside the batch it's given, so the custom doc should be untouched.
    await uploadRecords([
      record({ id: 'EU-1', source: 'EU', primaryName: 'Official EU Person', searchNames: [] }),
      record({ id: 'EU-2', source: 'EU', primaryName: 'Another EU Person', searchNames: [] }),
    ]);

    const after = (await db.collection('sanctions').doc('CUSTOM-1').get()).data();
    expect(after).toEqual(before);
  });
});
