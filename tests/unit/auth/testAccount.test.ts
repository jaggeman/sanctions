import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isTestLoginEnabled } from '../../../src/auth/testAccount';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isTestLoginEnabled — security fix, fail-closed by default', () => {
  it('is enabled outside production when explicitly opted in (the normal dev/test setup)', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_TEST_LOGIN = 'true';
    expect(isTestLoginEnabled()).toBe(true);
  });

  it('is NEVER enabled in production, even with the opt-in flag set', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_TEST_LOGIN = 'true';
    expect(isTestLoginEnabled()).toBe(false);
  });

  // This is the actual incident: a deployed Cloud Function inherited
  // NODE_ENV=development (via a stray root .env Firebase's own tooling
  // shipped) with no ENABLE_TEST_LOGIN set at all. The old
  // `NODE_ENV !== 'production'` gate was fail-OPEN and enabled the
  // hardcoded admin@sanctions.com / 123456 login unauthenticated, in a
  // live production deployment.
  it('is OFF when NODE_ENV is misconfigured to non-production and ENABLE_TEST_LOGIN is unset (the live incident)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ENABLE_TEST_LOGIN;
    expect(isTestLoginEnabled()).toBe(false);
  });

  it('is OFF when NODE_ENV is entirely unset and ENABLE_TEST_LOGIN is unset', () => {
    delete process.env.NODE_ENV;
    delete process.env.ENABLE_TEST_LOGIN;
    expect(isTestLoginEnabled()).toBe(false);
  });

  it('is OFF outside production when ENABLE_TEST_LOGIN is set to anything other than the literal string "true"', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_TEST_LOGIN = '1';
    expect(isTestLoginEnabled()).toBe(false);

    process.env.ENABLE_TEST_LOGIN = 'TRUE';
    expect(isTestLoginEnabled()).toBe(false);

    process.env.ENABLE_TEST_LOGIN = 'yes';
    expect(isTestLoginEnabled()).toBe(false);
  });
});
