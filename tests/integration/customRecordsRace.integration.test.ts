import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) — issue #172: createCustomRecord's
 * existence check now happens via Firestore's own atomic
 * DocumentReference.create() instead of a separate get()-then-set(). A mock
 * can fake the interface shape, but only the real emulator can confirm the
 * atomicity actually holds under concurrent creates for the same id — the
 * exact TOCTOU the fix exists to close (mirrors
 * importRetry.integration.test.ts's "six concurrent attempts, one wins").
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { createCustomRecord, getCustomRecord } = await import('../../src/customRecords');

async function clearSanctions() {
  const snap = await db.collection('sanctions').get();
  const batch = db.batch();
  snap.forEach((doc: any) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

beforeEach(async () => {
  await clearSanctions();
});

afterAll(async () => {
  await clearSanctions();
});

describe('createCustomRecord — concurrent create race (issue #172, real Firestore)', () => {
  it('six concurrent creates for the same id: exactly one wins, the record is coherent', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        createCustomRecord({
          id: 'CUSTOM-RACE-1',
          type: 'individual',
          primaryName: `Attempt ${i}`,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected' && /already exists/i.test((r as PromiseRejectedResult).reason.message),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);

    const stored = await getCustomRecord('CUSTOM-RACE-1');
    expect(stored).not.toBeNull();
    // The stored record must be exactly the one attempt that actually won —
    // no interleaved partial write from a loser.
    expect(stored?.primaryName).toMatch(/^Attempt \d$/);
  }, 30_000);

  it('a second create after the first succeeds is still rejected as a duplicate', async () => {
    await createCustomRecord({ id: 'CUSTOM-RACE-2', type: 'individual', primaryName: 'First' });
    await expect(
      createCustomRecord({ id: 'CUSTOM-RACE-2', type: 'individual', primaryName: 'Second' }),
    ).rejects.toThrow(/already exists/i);

    const stored = await getCustomRecord('CUSTOM-RACE-2');
    expect(stored?.primaryName).toBe('First');
  }, 30_000);
});
