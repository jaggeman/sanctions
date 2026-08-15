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
    createOtp('user@example.com');
    for (let i = 0; i < 5; i++) verifyOtp('user@example.com', 'wrong-code');
    const freshCode = createOtp('user@example.com');
    expect(verifyOtp('user@example.com', freshCode)).toBe(true);
  });
});
