import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as admin from 'firebase-admin';

/**
 * Integration layer (CLAUDE.md §1) — issue #63's actual regression: OTP
 * codes and sessions used to live in an in-process Map, so a Cloud Functions
 * cold start or a second concurrent instance would silently lose them. A
 * mocked unit test can't observe that failure mode by construction (the
 * mock always agrees with itself). This runs against a REAL Firestore
 * emulator (via `npm run test:integration`) and proves the state is read
 * back through a COMPLETELY SEPARATE firebase-admin app instance — the
 * closest a single-process test suite can get to simulating "a different
 * Cloud Functions instance reads what instance A wrote."
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { createOtp, verifyOtp } = await import('../../src/auth/otpStore');
const { createSession, getSession } = await import('../../src/auth/session');

// A second, independent Admin SDK app instance pointed at the same
// emulator — its own connection, its own in-process state, nothing shared
// with the app instance src/shared/firebase.ts initializes. Standing in for
// "a separate Cloud Functions instance."
const secondaryApp = admin.initializeApp(
  { projectId: process.env.FIREBASE_PROJECT_ID },
  'session-durability-secondary-instance',
);
const secondaryDb = admin.firestore(secondaryApp);

async function clearCollection(name: string) {
  const snap = await db.collection(name).get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('otpCodes');
  await clearCollection('sessions');
});

afterAll(async () => {
  await clearCollection('otpCodes');
  await clearCollection('sessions');
  await secondaryApp.delete();
});

describe('durable session/OTP storage across instances (issue #63)', () => {
  it('a session created through one Firestore connection is readable through a completely separate one', async () => {
    const sessionId = await createSession('user@example.com');

    const doc = await secondaryDb.collection('sessions').doc(sessionId).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()?.email).toBe('user@example.com');

    // And the app's own getSession() genuinely round-trips through
    // Firestore too, not a coincidence of the raw doc shape above.
    expect((await getSession(sessionId))?.email).toBe('user@example.com');
  });

  it('an OTP code created through one Firestore connection can be verified through the app after being written by a separate connection', async () => {
    // Simulates request-otp landing on "instance A": write the OTP doc
    // directly via the secondary connection, exactly as a genuinely separate
    // instance's createOtp() would have.
    const crypto = await import('crypto');
    const emailHash = crypto.createHash('sha256').update('user@example.com').digest('hex');
    const code = '654321';
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await secondaryDb.collection('otpCodes').doc(emailHash).set({
      codeHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      attempts: 0,
      issuedAt: new Date().toISOString(),
    });

    // verify-otp landing on "instance B" (this process's own db connection)
    // must still find and accept it.
    expect(await verifyOtp('user@example.com', code)).toBe(true);
  });

  it('createOtp/verifyOtp round-trip through the real emulator end-to-end', async () => {
    const code = await createOtp('user@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(await verifyOtp('user@example.com', code as string)).toBe(true);
    // Consumed on success, same as the in-memory store's old contract.
    expect(await verifyOtp('user@example.com', code as string)).toBe(false);
  });
});
