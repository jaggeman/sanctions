import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createFakeDb } from '../helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb, dumpIds } = createFakeDb();
vi.mock('../../../src/shared/firebase', () => ({ db: fakeDb }));

const { createOtp, verifyOtp, isInCooldown } = await import('../../../src/auth/otpStore');

describe('otpStore (issue #63: Firestore-backed, survives multi-instance/cold-start)', () => {
  beforeEach(() => {
    resetFakeDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies successfully with the code just created', async () => {
    const code = await createOtp('user@example.com');
    expect(await verifyOtp('user@example.com', code as string)).toBe(true);
  });

  it('is case-insensitive on email', async () => {
    const code = await createOtp('User@Example.com');
    expect(await verifyOtp('user@example.com', code as string)).toBe(true);
  });

  it('rejects a wrong code', async () => {
    await createOtp('user@example.com');
    expect(await verifyOtp('user@example.com', '000000')).toBe(false);
  });

  it('rejects verification for an email with no pending code', async () => {
    expect(await verifyOtp('nobody@example.com', '123456')).toBe(false);
  });

  it('consumes the code after a successful verify (cannot be reused)', async () => {
    const code = await createOtp('user@example.com');
    expect(await verifyOtp('user@example.com', code as string)).toBe(true);
    expect(await verifyOtp('user@example.com', code as string)).toBe(false);
  });

  it('rejects an expired code', async () => {
    vi.useFakeTimers();
    const code = await createOtp('user@example.com');
    vi.advanceTimersByTime(11 * 60 * 1000); // TTL is 10 minutes
    expect(await verifyOtp('user@example.com', code as string)).toBe(false);
  });

  it('locks out after too many wrong attempts, even with the right code', async () => {
    const code = await createOtp('user@example.com');
    for (let i = 0; i < 5; i++) {
      expect(await verifyOtp('user@example.com', 'wrong-code')).toBe(false);
    }
    expect(await verifyOtp('user@example.com', code as string)).toBe(false);

    // Extra attempts beyond the cap still return false
    expect(await verifyOtp('user@example.com', 'another-wrong-code')).toBe(false);
  });

  it('deletes the expired code document on verification attempt', async () => {
    vi.useFakeTimers();
    const code = await createOtp('user@example.com');
    expect(dumpIds('otpCodes')).toHaveLength(1);
    vi.advanceTimersByTime(11 * 60 * 1000); // TTL is 10 minutes
    expect(await verifyOtp('user@example.com', code as string)).toBe(false);
    expect(dumpIds('otpCodes')).toHaveLength(0);
  });

  it('creating a new code resets the attempt counter', async () => {
    vi.useFakeTimers();
    await createOtp('user@example.com');
    for (let i = 0; i < 5; i++) await verifyOtp('user@example.com', 'wrong-code');
    vi.advanceTimersByTime(61 * 1000); // past the request cooldown
    const freshCode = await createOtp('user@example.com');
    expect(await verifyOtp('user@example.com', freshCode as string)).toBe(true);
  });

  describe('request cooldown (issue #16)', () => {
    it('returns null (rate limited) when requested again for the same email within the cooldown', async () => {
      const first = await createOtp('user@example.com');
      expect(first).toBeTruthy();
      expect(await createOtp('user@example.com')).toBeNull();
    });

    it('allows a new request once the cooldown window has passed', async () => {
      vi.useFakeTimers();
      const first = await createOtp('user@example.com');
      vi.advanceTimersByTime(61 * 1000);
      const second = await createOtp('user@example.com');
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    });

    it('cools down independently per email', async () => {
      expect(await createOtp('a@example.com')).toBeTruthy();
      expect(await createOtp('b@example.com')).toBeTruthy();
    });
  });

  describe('isInCooldown — read-only peek (issue #62)', () => {
    it('is false for an email with no pending code', async () => {
      expect(await isInCooldown('nobody@example.com')).toBe(false);
    });

    it('is true right after createOtp succeeds', async () => {
      await createOtp('user@example.com');
      expect(await isInCooldown('user@example.com')).toBe(true);
    });

    it('is false once the cooldown window has passed', async () => {
      vi.useFakeTimers();
      await createOtp('user@example.com');
      vi.advanceTimersByTime(61 * 1000);
      expect(await isInCooldown('user@example.com')).toBe(false);
    });

    it('does not write anything — checking cooldown status has no side effect', async () => {
      await createOtp('user@example.com');
      const before = dumpIds('otpCodes');
      await isInCooldown('user@example.com');
      await isInCooldown('someone-else@example.com');
      expect(dumpIds('otpCodes')).toEqual(before);
    });
  });

  describe('storage key safety (issue #63 / CLAUDE.md §6)', () => {
    it('never uses the raw email address as the Firestore document id', async () => {
      await createOtp('user@example.com');
      const ids = dumpIds('otpCodes');
      expect(ids).toHaveLength(1);
      expect(ids).not.toContain('user@example.com');

      const rawIdDoc = await fakeDb.collection('otpCodes').doc('user@example.com').get();
      expect(rawIdDoc.exists).toBe(false);
    });

    it('persists through the db module rather than any local in-process variable', async () => {
      const code = await createOtp('user@example.com');
      // A second, independent import of the module (simulating a separate
      // Cloud Function instance/cold start) must still see the same state,
      // since nothing is cached in a module-level Map anymore.
      vi.resetModules();
      const { verifyOtp: verifyOtpFromFreshImport } = await import('../../../src/auth/otpStore');
      expect(await verifyOtpFromFreshImport('user@example.com', code as string)).toBe(true);
    });
  });
});
