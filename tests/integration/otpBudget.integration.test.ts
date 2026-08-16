import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) — `consumeGlobalOtpBudget`'s whole point
 * is that concurrent callers can't both read the same pre-increment count
 * and both believe they got the last slot. A mocked Firestore (the unit
 * layer's `createFakeDb`) doesn't model real transaction isolation/retry —
 * it can't observe that race by construction. This runs the real thing:
 * genuinely concurrent calls against the real Firestore emulator, asserting
 * the total number of `true` results never exceeds the configured limit.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { consumeGlobalOtpBudget } = await import('../../src/auth/otpBudget');
const { OTP_GLOBAL_SEND_LIMIT } = await import('../../src/auth/otp');

async function clearCollection(name: string) {
  const snap = await db.collection(name).get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('otpGlobalBudget');
});

afterAll(async () => {
  await clearCollection('otpGlobalBudget');
});

describe('consumeGlobalOtpBudget — real Firestore transaction (issue #62)', () => {
  it('never lets concurrent callers exceed the configured limit, even when they race', async () => {
    // Fire well more attempts than the limit, all at once — if the
    // transaction weren't genuinely atomic, a naive read-then-write race
    // would let more than OTP_GLOBAL_SEND_LIMIT callers each read the same
    // pre-increment count and all get `true`.
    const attempts = OTP_GLOBAL_SEND_LIMIT + 20;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => consumeGlobalOtpBudget()),
    );

    const grantedCount = results.filter((r) => r === true).length;
    expect(grantedCount).toBe(OTP_GLOBAL_SEND_LIMIT);
    expect(results.filter((r) => r === false).length).toBe(attempts - OTP_GLOBAL_SEND_LIMIT);
  });

  it('persists the count through the real emulator, not an in-process variable', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await consumeGlobalOtpBudget()).toBe(true);
    }

    // Read the counter doc back directly — proves the state genuinely lives
    // in Firestore, not something a fresh module import would lose (the same
    // class of bug issue #63 fixed for OTP codes/sessions).
    const snap = await db.collection('otpGlobalBudget').get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].data().count).toBe(5);
  });
});
