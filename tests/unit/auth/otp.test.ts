import { describe, it, expect } from 'vitest';
import { generateOtpCode, hashOtpCode } from '../../../src/auth/otp';

describe('generateOtpCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generateOtpCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('produces different codes across calls (not deterministic)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOtpCode()));
    // astronomically unlikely to collide 20 times if using real randomness
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('hashOtpCode', () => {
  it('is deterministic for the same input', () => {
    expect(hashOtpCode('123456')).toBe(hashOtpCode('123456'));
  });

  it('produces different hashes for different codes', () => {
    expect(hashOtpCode('123456')).not.toBe(hashOtpCode('654321'));
  });

  it('never returns the plaintext code itself', () => {
    expect(hashOtpCode('123456')).not.toBe('123456');
  });
});
