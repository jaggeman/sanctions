import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { requireAdmin } from '../../../src/api/middleware/requireAdmin';
import { isAdminEmail } from '../../../src/auth/admins';
import {
  createSession,
  destroySession,
  _resetSessionStoreForTests,
} from '../../../src/auth/session';
import { SESSION_COOKIE_NAME } from '../../../src/auth/middleware';
import { TEST_LOGIN_EMAIL } from '../../../src/auth/testAccount';

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.get('/admin', requireAdmin, (req, res) => {
    res.json({ ok: true, email: (req as any).userEmail });
  });
  return app;
}

const asUser = (email: string) =>
  request(buildApp()).get('/admin').set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(email)}`);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetSessionStoreForTests();
  process.env.NODE_ENV = 'test';
  delete process.env.ADMIN_EMAILS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

describe('isAdminEmail — the allow-list', () => {
  it('denies everyone when ADMIN_EMAILS is unset and this is production', () => {
    process.env.NODE_ENV = 'production';
    expect(isAdminEmail('anyone@example.com')).toBe(false);
    // Crucially, including the dev test account.
    expect(isAdminEmail(TEST_LOGIN_EMAIL)).toBe(false);
  });

  it('falls back to the dev test account only outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(isAdminEmail(TEST_LOGIN_EMAIL)).toBe(true);
    expect(isAdminEmail('someone.else@example.com')).toBe(false);
  });

  it('reads a comma-separated allow-list', () => {
    process.env.ADMIN_EMAILS = 'a@corp.com,b@corp.com';
    expect(isAdminEmail('a@corp.com')).toBe(true);
    expect(isAdminEmail('b@corp.com')).toBe(true);
    expect(isAdminEmail('c@corp.com')).toBe(false);
  });

  it('normalises case and surrounding whitespace on both sides', () => {
    process.env.ADMIN_EMAILS = '  Admin@Corp.com , b@corp.com ';
    expect(isAdminEmail('admin@corp.com')).toBe(true);
    expect(isAdminEmail('  ADMIN@CORP.COM  ')).toBe(true);
  });

  it('once ADMIN_EMAILS is set, the dev test account is no longer implicitly admin', () => {
    process.env.NODE_ENV = 'development';
    process.env.ADMIN_EMAILS = 'a@corp.com';
    expect(isAdminEmail(TEST_LOGIN_EMAIL)).toBe(false);
  });

  it('treats an all-empty list as unset rather than as an allow-list of ""', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_EMAILS = ' , ,, ';
    expect(isAdminEmail('')).toBe(false);
    expect(isAdminEmail('a@corp.com')).toBe(false);
  });

  it('never treats a blank email as a match', () => {
    process.env.ADMIN_EMAILS = 'a@corp.com';
    expect(isAdminEmail('')).toBe(false);
    expect(isAdminEmail('   ')).toBe(false);
  });
});

describe('requireAdmin middleware', () => {
  it('rejects a request with no session cookie', async () => {
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const res = await request(buildApp()).get('/admin');
    expect(res.status).toBe(401);
  });

  it('rejects a session cookie that does not correspond to a session', async () => {
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const res = await request(buildApp())
      .get('/admin')
      .set('Cookie', `${SESSION_COOKIE_NAME}=not-a-real-session`);
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated non-admin with 403, not 401', async () => {
    // The distinction matters: 401 tells the client to log in again, which is
    // wrong and confusing when they are already logged in.
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const res = await asUser('regular.user@corp.com');
    expect(res.status).toBe(403);
  });

  it('admits an authenticated admin', async () => {
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const res = await asUser('a@corp.com');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('a@corp.com');
  });

  it('does not admit anyone when the allow-list is unset in production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await asUser(TEST_LOGIN_EMAIL);
    expect(res.status).toBe(403);
  });

  it('re-checks the allow-list on every call, so revoking admin takes effect immediately', async () => {
    // A live session must not keep admin rights after being removed from the
    // allow-list (CLAUDE.md §6 — re-verify, don't trust a cached claim).
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const app = buildApp();
    const cookie = `${SESSION_COOKIE_NAME}=${createSession('a@corp.com')}`;

    expect((await request(app).get('/admin').set('Cookie', cookie)).status).toBe(200);

    process.env.ADMIN_EMAILS = 'someone.else@corp.com';

    expect((await request(app).get('/admin').set('Cookie', cookie)).status).toBe(403);
  });

  it('rejects a destroyed session even for an admin address', async () => {
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const sessionId = createSession('a@corp.com');
    destroySession(sessionId);
    const res = await request(buildApp())
      .get('/admin')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionId}`);
    expect(res.status).toBe(401);
  });

  it('does not trust a caller-supplied identity header', async () => {
    // requireAdmin must resolve identity from the session store, never from
    // anything the client can set.
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const res = await request(buildApp())
      .get('/admin')
      .set('X-User-Email', 'a@corp.com')
      .set('userEmail', 'a@corp.com');
    expect(res.status).toBe(401);
  });
});
