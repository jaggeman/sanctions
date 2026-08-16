import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) — exercises the diff engine against a
 * REAL Firestore emulator. Unit tests in tests/unit/diff.test.ts mock the
 * Firestore query entirely and cannot see this: real write counts, real
 * `.select()` projection behaviour, and the actual interaction with
 * uploadRecords/delistRecords from issue #9. Runs via `npm run
 * test:integration`, wrapped in `firebase emulators:exec --only firestore`.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { runDiffForSource, DelistGuardError } = await import('../../src/importer/diff');

function record(overrides: Record<string, any> = {}) {
  return {
    id: 'EU-diff-1',
    source: 'EU',
    type: 'individual',
    names: [{ wholeName: 'Diff Person', strong: true }] as { wholeName: string; strong: boolean }[],
    searchNames: [] as string[],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function clearCollection() {
  const snap = await db.collection('sanctions').get();
  await Promise.all(snap.docs.map((doc) => db.recursiveDelete(doc.ref)));
}

async function writeCountFor(ids: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const versions = await db.collection('sanctions').doc(id).collection('versions').get();
    counts[id] = versions.size;
  }
  return counts;
}

beforeEach(async () => {
  await clearCollection();
});

afterAll(async () => {
  await clearCollection();
});

describe('diff engine — real Firestore write path (issue #8)', () => {
  it('importing the same file twice: second run is 100% unchanged and writes nothing', async () => {
    const records = [
      record({ id: 'EU-a' }),
      record({ id: 'EU-b', names: [{ wholeName: 'Second Person', strong: true }] }),
    ];

    await runDiffForSource('EU', records, { mode: 'sync', importId: 'import-1' });
    const before = await writeCountFor(['EU-a', 'EU-b']);
    expect(before).toEqual({ 'EU-a': 1, 'EU-b': 1 }); // one 'created' version each

    const diff = await runDiffForSource('EU', records, { mode: 'sync', importId: 'import-2' });

    expect(diff.counts).toMatchObject({ added: 0, updated: 0, unchanged: 2, delisted: 0 });
    const after = await writeCountFor(['EU-a', 'EU-b']);
    expect(after).toEqual(before); // no new version docs — nothing was written
  });

  it('a record present in import A and absent from import B is delisted, not deleted', async () => {
    // 5 seeded records, only EU-b drops out: 1/5 = 20%, at the guard
    // threshold rather than over it, so this is a plain classification test.
    const seedIds = ['EU-a', 'EU-b', 'EU-c', 'EU-d', 'EU-e'];
    await runDiffForSource(
      'EU',
      seedIds.map((id) => record({ id })),
      { mode: 'sync', importId: 'import-1' },
    );

    const survivors = seedIds.filter((id) => id !== 'EU-b').map((id) => record({ id }));
    const diff = await runDiffForSource('EU', survivors, { mode: 'sync', importId: 'import-2' });

    expect(diff.toDelistIds).toEqual(['EU-b']);
    const doc = await db.collection('sanctions').doc('EU-b').get();
    expect(doc.exists).toBe(true); // never deleted
    expect(doc.data()!.status).toBe('delisted');
    expect(doc.data()!.delistedAt).toBeTruthy();
  });

  it('a changed field produces "updated", and only that record is written', async () => {
    await runDiffForSource(
      'EU',
      [record({ id: 'EU-a' }), record({ id: 'EU-b' })],
      { mode: 'sync', importId: 'import-1' },
    );

    const diff = await runDiffForSource(
      'EU',
      [record({ id: 'EU-a', names: [{ wholeName: 'Changed Name', strong: true }] }), record({ id: 'EU-b' })],
      { mode: 'sync', importId: 'import-2' },
    );

    expect(diff.counts).toMatchObject({ added: 0, updated: 1, unchanged: 1, delisted: 0 });
    const versionsA = await db.collection('sanctions').doc('EU-a').collection('versions').get();
    const versionsB = await db.collection('sanctions').doc('EU-b').collection('versions').get();
    expect(versionsA.size).toBe(2); // created + updated
    expect(versionsB.size).toBe(1); // created only — untouched by import-2
  });

  it('append mode never delists, even when a previously-seen record disappears from the file', async () => {
    await runDiffForSource(
      'PEP',
      [record({ id: 'PEP-a', source: 'PEP' }), record({ id: 'PEP-b', source: 'PEP' })],
      { mode: 'append', importId: 'import-1' },
    );

    const diff = await runDiffForSource('PEP', [record({ id: 'PEP-a', source: 'PEP' })], {
      mode: 'append',
      importId: 'import-2',
    });

    expect(diff.toDelistIds).toEqual([]);
    expect(diff.counts.delisted).toBe(0);
    const doc = await db.collection('sanctions').doc('PEP-b').get();
    expect(doc.data()!.status).toBe('active'); // still active — append never delists
  });

  it('dry-run populates counts but writes nothing to the sanctions collection', async () => {
    const diff = await runDiffForSource('EU', [record({ id: 'EU-a' })], {
      mode: 'sync',
      dryRun: true,
      importId: 'import-1',
    });

    expect(diff.counts).toMatchObject({ added: 1, updated: 0, unchanged: 0, delisted: 0 });
    const doc = await db.collection('sanctions').doc('EU-a').get();
    expect(doc.exists).toBe(false); // dry-run must not create the document
  });

  it('the >20% guard refuses a truncated file, and succeeds with force', async () => {
    const seedRecords = Array.from({ length: 10 }, (_, i) => record({ id: `EU-seed-${i}` }));
    await runDiffForSource('EU', seedRecords, { mode: 'sync', importId: 'import-1' });

    // A "truncated download": only 2 of the 10 records survive -> 8/10 = 80% delisted
    const truncatedFile = seedRecords.slice(0, 2);

    await expect(
      runDiffForSource('EU', truncatedFile, { mode: 'sync', importId: 'import-2' }),
    ).rejects.toThrow(DelistGuardError);

    // Refused: nothing should have been delisted
    const stillActive = await db.collection('sanctions').where('source', '==', 'EU').get();
    expect(stillActive.docs.every((d) => d.data().status === 'active')).toBe(true);

    // Forcing it through applies the same truncated diff
    const forced = await runDiffForSource('EU', truncatedFile, {
      mode: 'sync',
      importId: 'import-3',
      force: true,
    });
    expect(forced.toDelistIds).toHaveLength(8);
    const afterForce = await db.collection('sanctions').where('source', '==', 'EU').get();
    const delistedCount = afterForce.docs.filter((d) => d.data().status === 'delisted').length;
    expect(delistedCount).toBe(8);
  });

  it('scopes the delist pass to one source — importing EU never delists UN records', async () => {
    await runDiffForSource('UN', [record({ id: 'UN-a', source: 'UN' })], { mode: 'sync', importId: 'import-1' });
    await runDiffForSource('EU', [record({ id: 'EU-a' })], { mode: 'sync', importId: 'import-2' });

    const unDoc = await db.collection('sanctions').doc('UN-a').get();
    expect(unDoc.data()!.status).toBe('active'); // untouched by the EU-scoped sync
  });
});
