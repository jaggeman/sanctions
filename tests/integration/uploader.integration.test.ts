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
const { uploadRecords, delistRecords, generateSearchTokens } = await import('../../src/importer/uploader');
const { getOverride, saveOverride, deleteOverride, applyOverride } = await import('../../src/overrides');

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
  // recursiveDelete (not a plain batch delete) so orphaned `versions`/
  // `history` subcollections from prior tests can't leak into later ones —
  // Firestore does not cascade-delete subcollections on its own (see issue
  // #9's gotchas, and now issue #112's overrides/{id}/history).
  const snap = await db.collection('sanctions').get();
  await Promise.all(snap.docs.map((doc) => db.recursiveDelete(doc.ref)));

  const overridesSnap = await db.collection('overrides').get();
  await Promise.all(overridesSnap.docs.map((doc: any) => db.recursiveDelete(doc.ref)));
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

describe('soft delete + version history — real Firestore write path (issue #9)', () => {
  it('writes a "created" version doc and never a bare .delete() for a new record', async () => {
    await uploadRecords([record({ id: 'PEP-int-ver-1' })], 'import-1');

    const doc = await db.collection('sanctions').doc('PEP-int-ver-1').get();
    expect(doc.data()!.status).toBe('active');
    expect(doc.data()!.listedAt).toBeTruthy();

    const versions = await db.collection('sanctions').doc('PEP-int-ver-1').collection('versions').get();
    expect(versions.size).toBe(1);
    expect(versions.docs[0].id).toBe('import-1');
    expect(versions.docs[0].data().changeType).toBe('created');
  });

  it('writes no new version doc for an unchanged re-import', async () => {
    await uploadRecords([record({ id: 'PEP-int-ver-2' })], 'import-1');
    await uploadRecords([record({ id: 'PEP-int-ver-2' })], 'import-2');

    const versions = await db.collection('sanctions').doc('PEP-int-ver-2').collection('versions').get();
    expect(versions.size).toBe(1);
  });

  it('delists a record via delistRecords, then relists it on reappearance, reconstructing its full history', async () => {
    await uploadRecords([record({ id: 'PEP-int-ver-3', primaryName: 'Original Name' })], 'import-1');
    await delistRecords(['PEP-int-ver-3'], 'import-2');

    let doc = await db.collection('sanctions').doc('PEP-int-ver-3').get();
    expect(doc.data()!.status).toBe('delisted');
    expect(doc.data()!.delistedAt).toBeTruthy();

    await uploadRecords([record({ id: 'PEP-int-ver-3', primaryName: 'Original Name' })], 'import-3');

    doc = await db.collection('sanctions').doc('PEP-int-ver-3').get();
    expect(doc.data()!.status).toBe('active');
    expect(doc.data()!.delistedAt).toBeUndefined();

    const versionsSnap = await db
      .collection('sanctions')
      .doc('PEP-int-ver-3')
      .collection('versions')
      .orderBy('changedAt')
      .get();
    const changeTypes = versionsSnap.docs.map((v) => v.data().changeType);
    expect(changeTypes).toEqual(['created', 'delisted', 'relisted']);

    // Reconstruct the record as of the first import from its version snapshot.
    const firstVersion = versionsSnap.docs[0].data();
    expect(firstVersion.record.primaryName).toBe('Original Name');
    expect(firstVersion.record.status).toBe('active');
  });
});

describe('delistRecords — real Firestore write path (issue #9)', () => {
  it('is a no-op for an id that does not exist, and for an already-delisted id', async () => {
    await expect(delistRecords(['DOES-NOT-EXIST'], 'import-1')).resolves.toBeUndefined();

    await uploadRecords([record({ id: 'PEP-int-ver-4' })], 'import-1');
    await delistRecords(['PEP-int-ver-4'], 'import-2');
    await delistRecords(['PEP-int-ver-4'], 'import-3'); // already delisted

    const versions = await db.collection('sanctions').doc('PEP-int-ver-4').collection('versions').get();
    expect(versions.size).toBe(2); // created + delisted, not a second delisted entry
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

describe('overrides — real Firestore write path (issue #35)', () => {
  it('survives a full re-import of its source, and still wins over the freshly re-imported value', async () => {
    await uploadRecords([
      record({ id: 'EU-override-1', primaryName: 'Original Name', sanctionReason: 'Original reason' }),
    ]);

    await saveOverride(
      'EU-override-1',
      { sanctionReason: 'Analyst-corrected reason' },
      { overriddenBy: 'analyst@example.com', reason: 'Source reason was inaccurate' },
    );

    // Simulates a full re-import of the same source: the parser produced a
    // genuinely updated sanctionReason from the official source this time.
    await uploadRecords([
      record({ id: 'EU-override-1', primaryName: 'Original Name', sanctionReason: 'Updated source reason' }),
    ]);

    const rawDoc = (await db.collection('sanctions').doc('EU-override-1').get()).data()!;
    // The import itself is unaffected by the override — it wrote the real,
    // fresh source value straight through.
    expect(rawDoc.sanctionReason).toBe('Updated source reason');

    const override = await getOverride('EU-override-1');
    const { record: merged, overriddenFields } = applyOverride(rawDoc, override);
    expect(merged.sanctionReason).toBe('Analyst-corrected reason');
    expect(overriddenFields).toEqual(['sanctionReason']);
  });

  it('removing an override restores exactly the CURRENT imported values, not a frozen pre-override snapshot', async () => {
    await uploadRecords([
      record({ id: 'EU-override-2', primaryName: 'Original Name', sanctionReason: 'Original reason' }),
    ]);
    await saveOverride(
      'EU-override-2',
      { sanctionReason: 'Analyst-corrected reason' },
      { overriddenBy: 'analyst@example.com', reason: 'Fix' },
    );

    // A re-import lands new source data WHILE the override is still active.
    await uploadRecords([
      record({ id: 'EU-override-2', primaryName: 'Original Name', sanctionReason: 'Second source update' }),
    ]);

    await deleteOverride('EU-override-2', 'reviewer@example.com');

    const rawDoc = (await db.collection('sanctions').doc('EU-override-2').get()).data()!;
    const override = await getOverride('EU-override-2');
    const { record: merged, overriddenFields } = applyOverride(rawDoc, override);

    // Not 'Original reason' (the pre-override snapshot) — the record itself
    // was never mutated by the override, so removing it just reveals
    // whatever the source most recently and genuinely said.
    expect(merged.sanctionReason).toBe('Second source update');
    expect(overriddenFields).toEqual([]);
  });

  it('does not resurrect a delisted record even with an override attempting to flip status back to active', async () => {
    await uploadRecords([record({ id: 'EU-override-3', primaryName: 'Some Name' })], 'import-1');
    await delistRecords(['EU-override-3'], 'import-2');

    await saveOverride(
      'EU-override-3',
      { status: 'active' } as any,
      { overriddenBy: 'analyst@example.com', reason: 'Attempted resurrection' },
    );

    const rawDoc = (await db.collection('sanctions').doc('EU-override-3').get()).data()!;
    const override = await getOverride('EU-override-3');
    const { record: merged, overriddenFields } = applyOverride(rawDoc, override);

    expect(merged.status).toBe('delisted');
    expect(overriddenFields).toEqual([]);
  });
});
