import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb } from '../helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../../src/shared/firebase', () => ({ db: fakeDb }));

const { consumeGlobalOtpBudget, consumeIpOtpBudget } = await import('../../../src/auth/otpBudget');
const { OTP_GLOBAL_SEND_LIMIT, OTP_GLOBAL_SEND_WINDOW_MS, OTP_IP_SEND_LIMIT, OTP_IP_SEND_WINDOW_MS } = await import('../../../src/auth/otp');

describe('consumeGlobalOtpBudget (issue #62)', () => {
  beforeEach(() => {
    resetFakeDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows sends up to the configured limit within one window', async () => {
    for (let i = 0; i < OTP_GLOBAL_SEND_LIMIT; i++) {
      expect(await consumeGlobalOtpBudget()).toBe(true);
    }
  });

  it('rejects once the limit is reached within the same window', async () => {
    for (let i = 0; i < OTP_GLOBAL_SEND_LIMIT; i++) {
      await consumeGlobalOtpBudget();
    }
    expect(await consumeGlobalOtpBudget()).toBe(false);
  });

  it('resets once a new window begins', async () => {
    for (let i = 0; i < OTP_GLOBAL_SEND_LIMIT; i++) {
      await consumeGlobalOtpBudget();
    }
    expect(await consumeGlobalOtpBudget()).toBe(false);

    vi.advanceTimersByTime(OTP_GLOBAL_SEND_WINDOW_MS + 1);

    expect(await consumeGlobalOtpBudget()).toBe(true);
  });

  it('does not let one window bleed into the next (independent counters)', async () => {
    for (let i = 0; i < OTP_GLOBAL_SEND_LIMIT; i++) {
      await consumeGlobalOtpBudget();
    }
    vi.advanceTimersByTime(OTP_GLOBAL_SEND_WINDOW_MS + 1);
    // Exhaust the new window too — proves the counter for window N doesn't
    // somehow keep counting against window N+1.
    for (let i = 0; i < OTP_GLOBAL_SEND_LIMIT; i++) {
      expect(await consumeGlobalOtpBudget()).toBe(true);
    }
    expect(await consumeGlobalOtpBudget()).toBe(false);
  });
});

describe('consumeIpOtpBudget (issue #144)', () => {
  beforeEach(() => {
    resetFakeDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows sends up to the configured limit per IP within one window', async () => {
    for (let i = 0; i < OTP_IP_SEND_LIMIT; i++) {
      expect(await consumeIpOtpBudget('192.168.1.1')).toBe(true);
    }
  });

  it('rejects once the per-IP limit is reached within the same window', async () => {
    for (let i = 0; i < OTP_IP_SEND_LIMIT; i++) {
      await consumeIpOtpBudget('192.168.1.1');
    }
    expect(await consumeIpOtpBudget('192.168.1.1')).toBe(false);
  });

  it('maintains independent budgets for different IPs', async () => {
    for (let i = 0; i < OTP_IP_SEND_LIMIT; i++) {
      await consumeIpOtpBudget('192.168.1.1');
    }
    expect(await consumeIpOtpBudget('192.168.1.1')).toBe(false);
    expect(await consumeIpOtpBudget('192.168.1.2')).toBe(true);
  });

  it('resets IP budget once a new window begins', async () => {
    for (let i = 0; i < OTP_IP_SEND_LIMIT; i++) {
      await consumeIpOtpBudget('192.168.1.1');
    }
    expect(await consumeIpOtpBudget('192.168.1.1')).toBe(false);

    vi.advanceTimersByTime(OTP_IP_SEND_WINDOW_MS + 1);

    expect(await consumeIpOtpBudget('192.168.1.1')).toBe(true);
  });

  it('safely handles IPv6 addresses containing colons', async () => {
    for (let i = 0; i < OTP_IP_SEND_LIMIT; i++) {
      expect(await consumeIpOtpBudget('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
    }
    expect(await consumeIpOtpBudget('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(false);
  });
});
