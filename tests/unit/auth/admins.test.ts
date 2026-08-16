import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAdminEmail, findMisconfiguredAdminEmails } from '../../../src/auth/admins';
import { TEST_LOGIN_EMAIL } from '../../../src/auth/testAccount';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.ADMIN_EMAILS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isAdminEmail — existing behaviour (characterization, unchanged)', () => {
  it('denies everyone when ADMIN_EMAILS is unset and this is production', () => {
    process.env.NODE_ENV = 'production';
    expect(isAdminEmail('anyone@example.com')).toBe(false);
  });

  it('grants admin to a configured address', () => {
    process.env.ADMIN_EMAILS = 'alice@corp.com';
    expect(isAdminEmail('alice@corp.com')).toBe(true);
    expect(isAdminEmail('bob@corp.com')).toBe(false);
  });

  it('grants admin to the test login email in non-production even when ADMIN_EMAILS is configured with someone else', () => {
    process.env.NODE_ENV = 'development';
    process.env.ADMIN_EMAILS = 'alice@corp.com';
    expect(isAdminEmail(TEST_LOGIN_EMAIL)).toBe(true);
  });

  it('denies admin to the test login email in production when not in ADMIN_EMAILS', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_EMAILS = 'alice@corp.com';
    expect(isAdminEmail(TEST_LOGIN_EMAIL)).toBe(false);
  });
});

describe('findMisconfiguredAdminEmails — issue #65: ADMIN_EMAILS vs ALLOWED_EMAIL_DOMAINS cross-check', () => {
  it('returns nothing when ADMIN_EMAILS is unset', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(findMisconfiguredAdminEmails()).toEqual([]);
  });

  it('returns nothing when every admin email domain is in ALLOWED_EMAIL_DOMAINS', () => {
    process.env.ADMIN_EMAILS = 'alice@corp.com,bob@corp.com';
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(findMisconfiguredAdminEmails()).toEqual([]);
  });

  it('flags an admin email whose domain is not in ALLOWED_EMAIL_DOMAINS', () => {
    process.env.ADMIN_EMAILS = 'alice@corp.com,carol@not-corp.com';
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    const result = findMisconfiguredAdminEmails();
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe('not-corp.com');
  });

  it('flags every configured admin email when ALLOWED_EMAIL_DOMAINS is entirely unset', () => {
    process.env.ADMIN_EMAILS = 'alice@corp.com,bob@corp.com';
    expect(findMisconfiguredAdminEmails()).toHaveLength(2);
  });

  it('masks the local part of a flagged email rather than logging it in full (CLAUDE.md §6 — no unredacted PII)', () => {
    process.env.ADMIN_EMAILS = 'carol@not-corp.com';
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    const result = findMisconfiguredAdminEmails();
    expect(result[0].maskedEmail).not.toContain('carol');
    expect(result[0].maskedEmail).toContain('not-corp.com');
  });

  it('never flags the dev test login account, which has its own unconditional bypass regardless of domain', () => {
    process.env.NODE_ENV = 'development';
    process.env.ADMIN_EMAILS = TEST_LOGIN_EMAIL;
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(findMisconfiguredAdminEmails()).toEqual([]);
  });

  it('does flag the test login email in production, where the bypass does not apply', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_EMAILS = TEST_LOGIN_EMAIL;
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(findMisconfiguredAdminEmails()).toHaveLength(1);
  });

  it('normalises case and whitespace the same way isAdminEmail/isAllowedEmail do', () => {
    process.env.ADMIN_EMAILS = '  Alice@CORP.com ';
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    expect(findMisconfiguredAdminEmails()).toEqual([]);
  });
});
