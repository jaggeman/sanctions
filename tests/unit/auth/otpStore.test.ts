import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createOtp, verifyOtp, _resetOtpStoreForTests } from '../../../src/auth/otpStore';

describe('otpStore', () => {
  beforeEach(() => {
    _resetOtpStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies successfully with the code just created', () => {
    const code = createOtp('user@example.com');
    expect(verifyOtp('user@example.com', code)).toBe(true);
  });

  it('is case-insensitive on email', () => {
    const code = createOtp('User@Example.com');
    expect(verifyOtp('user@example.com', code)).toBe(true);
  });

  it('rejects a wrong code', () => {
    createOtp('user@example.com');
    expect(verifyOtp('user@example.com', '000000')).toBe(false);
  });

  it('rejects verification for an email with no pending code', () => {
    expect(verifyOtp('nobody@example.com', '123456')).toBe(false);
  });

  it('consumes the code after a successful verify (cannot be reused)', () => {
    const code = createOtp('user@example.com');
    expect(verifyOtp('user@example.com', code)).toBe(true);
    expect(verifyOtp('user@example.com', code)).toBe(false);
  });

  it('rejects an expired code', () => {
    vi.useFakeTimers();
    const code = createOtp('user@example.com');
    vi.advanceTimersByTime(11 * 60 * 1000); // TTL is 10 minutes
    expect(verifyOtp('user@example.com', code)).toBe(false);
  });

  it('locks out after too many wrong attempts, even with the right code', () => {
    const code = createOtp('user@example.com');
    for (let i = 0; i < 5; i++) {
      expect(verifyOtp('user@example.com', 'wrong-code')).toBe(false);
    }
    expect(verifyOtp('user@example.com', code)).toBe(false);
  });

  it('creating a new code resets the attempt counter', () => {
    vi.useFakeTimers();
    createOtp('user@example.com');
    for (let i = 0; i < 5; i++) verifyOtp('user@example.com', 'wrong-code');
    vi.advanceTimersByTime(61 * 1000); // past the request cooldown
    const freshCode = createOtp('user@example.com');
    expect(verifyOtp('user@example.com', freshCode as string)).toBe(true);
  });

  describe('request cooldown (issue #16)', () => {
    it('returns null (rate limited) when requested again for the same email within the cooldown', () => {
      const first = createOtp('user@example.com');
      expect(first).toBeTruthy();
      expect(createOtp('user@example.com')).toBeNull();
    });

    it('allows a new request once the cooldown window has passed', () => {
      vi.useFakeTimers();
      const first = createOtp('user@example.com');
      vi.advanceTimersByTime(61 * 1000);
      const second = createOtp('user@example.com');
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    });

    it('cools down independently per email', () => {
      expect(createOtp('a@example.com')).toBeTruthy();
      expect(createOtp('b@example.com')).toBeTruthy();
    });
  });
});
