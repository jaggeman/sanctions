import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1 / Issue #155) — tests atomic transaction
 * behaviour for createOtp (cooldown race) and verifyOtp (attempt-cap brute-force race)
 * against the real Firestore emulator.
 *
 * Offline mocks cannot reproduce real interleaved read-modify-writes or transaction
 * retries under contention.
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { createOtp, verifyOtp } = await import('../../src/auth/otpStore');
const { OTP_MAX_ATTEMPTS } = await import('../../src/auth/otp');

async function clearCollection(name: string) {
  const snap = await db.collection(name).get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('otpCodes');
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await clearCollection('otpCodes');
});

describe('otpStore — real Firestore transactions (issue #155)', () => {
  describe('createOtp — atomic cooldown check', () => {
    it(
      'issues exactly ONE code when multiple createOtp calls race concurrently for the same email',
      async () => {
        const email = 'racer@example.com';
        const CONCURRENT_REQUESTS = 10;

        const results = await Promise.all(
          Array.from({ length: CONCURRENT_REQUESTS }, () => createOtp(email)),
        );

        const grantedCodes = results.filter((c): c is string => c !== null);
        const rejectedCalls = results.filter((c) => c === null);

        expect(grantedCodes).toHaveLength(1);
        expect(rejectedCalls).toHaveLength(CONCURRENT_REQUESTS - 1);

        // Verify that the code granted is valid and can be verified
        const code = grantedCodes[0];
        expect(await verifyOtp(email, code)).toBe(true);
      },
      30_000,
    );
  });

  describe('verifyOtp — atomic attempt counter and brute-force lockout', () => {
    it(
      'strictly caps wrong attempts at OTP_MAX_ATTEMPTS under concurrent guessing and locks out',
      async () => {
        const email = 'victim@example.com';
        const code = (await createOtp(email)) as string;
        expect(code).toBeTruthy();

        // Fire 10 concurrent wrong guesses
        const CONCURRENT_WRONG_GUESSES = 10;
        const results = await Promise.all(
          Array.from({ length: CONCURRENT_WRONG_GUESSES }, (_, i) =>
            verifyOtp(email, `wrong-${i}`),
          ),
        );

        // All wrong guesses should return false
        expect(results.every((r) => r === false)).toBe(true);

        // Now attempt to verify with the actual correct code:
        // Must be rejected because 10 attempts >= OTP_MAX_ATTEMPTS (5)
        const correctVerifyResult = await verifyOtp(email, code);
        expect(correctVerifyResult).toBe(false);

        // Inspect document in Firestore — attempts should be capped at OTP_MAX_ATTEMPTS (5)
        const snap = await db.collection('otpCodes').get();
        expect(snap.size).toBe(1);
        const data = snap.docs[0].data();
        expect(data.attempts).toBe(OTP_MAX_ATTEMPTS);
      },
      30_000,
    );
  });
});
