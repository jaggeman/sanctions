import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAllowedEmail } from '../../../src/auth/emailAllowlist';
import { TEST_LOGIN_EMAIL } from '../../../src/auth/testAccount';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.ALLOWED_EMAIL_DOMAINS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isAllowedEmail — the domain allow-list', () => {
  it('denies everyone when ALLOWED_EMAIL_DOMAINS is unset and this is production', () => {
    process.env.NODE_ENV = 'production';
    expect(isAllowedEmail('anyone@example.com')).toBe(false);
    // Crucially, including the dev test account.
    expect(isAllowedEmail(TEST_LOGIN_EMAIL)).toBe(false);
  });

  it('falls back to the dev test account only outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(isAllowedEmail(TEST_LOGIN_EMAIL)).toBe(true);
    expect(isAllowedEmail('someone.else@example.com')).toBe(false);
  });

  it('matches by domain regardless of the local part', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(isAllowedEmail('a@corp.com')).toBe(true);
    expect(isAllowedEmail('completely.different.person@corp.com')).toBe(true);
    expect(isAllowedEmail('a@not-corp.com')).toBe(false);
  });

  it('reads a comma-separated list of domains', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com,partner.org';
    expect(isAllowedEmail('a@corp.com')).toBe(true);
    expect(isAllowedEmail('b@partner.org')).toBe(true);
    expect(isAllowedEmail('c@evil.com')).toBe(false);
  });

  it('normalises case and surrounding whitespace on both sides', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = '  Corp.com , Partner.org ';
    expect(isAllowedEmail('A@CORP.COM')).toBe(true);
    expect(isAllowedEmail('  b@PARTNER.ORG  ')).toBe(true);
  });

  it('once ALLOWED_EMAIL_DOMAINS is set, the dev test account is no longer implicitly allowed', () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(isAllowedEmail(TEST_LOGIN_EMAIL)).toBe(false);
  });

  it('treats an all-empty list as unset rather than as an allow-list of ""', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_EMAIL_DOMAINS = ' , ,, ';
    expect(isAllowedEmail('a@corp.com')).toBe(false);
  });

  it('never treats a blank or missing email as a match', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(isAllowedEmail('')).toBe(false);
    expect(isAllowedEmail('   ')).toBe(false);
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail(undefined)).toBe(false);
  });

  it('rejects a malformed address with no domain part', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(isAllowedEmail('not-an-email')).toBe(false);
  });
});
