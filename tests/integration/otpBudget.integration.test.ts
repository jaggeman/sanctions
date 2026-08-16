import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

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

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await clearCollection('otpGlobalBudget');
});

describe('consumeGlobalOtpBudget — real Firestore transaction (issue #62)', () => {
  it(
    'never lets concurrent callers exceed the configured limit, even when they race',
    async () => {
      // Fire well more attempts than the limit, in concurrent batches — if
      // the transaction weren't genuinely atomic, a naive read-then-write
      // race would let more than OTP_GLOBAL_SEND_LIMIT callers each read the
      // same pre-increment count and all get `true`. Batched (10 at a time)
      // rather than all ~50 in one Promise.all: the real Firestore
      // emulator's transaction lock has a much lower contention ceiling on a
      // single document than production Firestore does, and the retries
      // Firestore itself performs under that contention can genuinely take
      // longer than this suite's default 20s test timeout — an
      // emulator-performance characteristic, not evidence against the
      // atomicity this test exists to prove (a raised per-test timeout below
      // gives real contention/retry time to resolve). Each batch is still
      // genuinely concurrent.
      //
      // Date is frozen (not full fake timers — real setTimeout/network I/O
      // must keep working for the emulator round-trips and the SDK's own
      // retry backoff) because this test can genuinely take 20+ real
      // seconds under contention, and OTP_GLOBAL_SEND_WINDOW_MS is only 60s
      // — without freezing, a run slow enough to cross that boundary mid-test
      // lands some calls in the next window, which has its own fresh budget,
      // and the count exceeds the limit for a reason that has nothing to do
      // with the transaction's atomicity (caught in practice: an intermittent
      // "expected 40 to be 30" failure straddling exactly this boundary).
      vi.useFakeTimers({ toFake: ['Date'] });

      const totalAttempts = OTP_GLOBAL_SEND_LIMIT + 20;
      const BATCH_SIZE = 10;
      const results: boolean[] = [];

      for (let done = 0; done < totalAttempts; done += BATCH_SIZE) {
        const batchSize = Math.min(BATCH_SIZE, totalAttempts - done);
        const batch = await Promise.all(
          Array.from({ length: batchSize }, () => consumeGlobalOtpBudget()),
        );
        results.push(...batch);
      }

      const grantedCount = results.filter((r) => r === true).length;
      expect(grantedCount).toBe(OTP_GLOBAL_SEND_LIMIT);
      expect(results.filter((r) => r === false).length).toBe(totalAttempts - OTP_GLOBAL_SEND_LIMIT);
    },
    60_000,
  );

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
