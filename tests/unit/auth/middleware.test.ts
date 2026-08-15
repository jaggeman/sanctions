import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { requireAuth, SESSION_COOKIE_NAME } from '../../../src/auth/middleware';
import {
  createSession,
  destroySession,
  _resetSessionStoreForTests,
} from '../../../src/auth/session';
import { TEST_LOGIN_EMAIL } from '../../../src/auth/testAccount';

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.get('/protected', requireAuth, (req, res) => {
    res.json({ ok: true, email: (req as any).userEmail });
  });
  return app;
}

const asUser = (email: string) =>
  request(buildApp()).get('/protected').set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(email)}`);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetSessionStoreForTests();
  process.env.NODE_ENV = 'test';
  delete process.env.ALLOWED_EMAIL_DOMAINS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

describe('requireAuth middleware', () => {
  it('rejects a request with no session cookie', async () => {
    const res = await request(buildApp()).get('/protected');
    expect(res.status).toBe(401);
  });

  it('rejects a session cookie that does not correspond to a session', async () => {
    const res = await request(buildApp())
      .get('/protected')
      .set('Cookie', `${SESSION_COOKIE_NAME}=not-a-real-session`);
    expect(res.status).toBe(401);
  });

  it('rejects a destroyed session', async () => {
    const sessionId = createSession(TEST_LOGIN_EMAIL);
    destroySession(sessionId);
    const res = await request(buildApp())
      .get('/protected')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionId}`);
    expect(res.status).toBe(401);
  });

  it('admits a session for the dev test account when ALLOWED_EMAIL_DOMAINS is unset outside production', async () => {
    const res = await asUser(TEST_LOGIN_EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(TEST_LOGIN_EMAIL);
  });

  it('rejects a valid session whose email is not on the domain allow-list (issue #33)', async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    const res = await asUser('someone@not-corp.com');
    expect(res.status).toBe(401);
  });

  it('admits a valid session whose email is on the domain allow-list', async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    const res = await asUser('someone@corp.com');
    expect(res.status).toBe(200);
  });

  it('still admits the dev test account once ALLOWED_EMAIL_DOMAINS is configured, outside production (issue #92)', async () => {
    // Reproduces the live pen-test finding: verify-otp lets the test account
    // log in unconditionally outside production, but this middleware used to
    // 401 that very same session on its next request the moment a real
    // domain list was set — exactly the config any non-dev deployment must
    // have per issue #33.
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    const res = await asUser(TEST_LOGIN_EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(TEST_LOGIN_EMAIL);
  });

  it('admits nobody when ALLOWED_EMAIL_DOMAINS is unset in production, not even the test account', async () => {
    process.env.NODE_ENV = 'production';
    const res = await asUser(TEST_LOGIN_EMAIL);
    expect(res.status).toBe(401);
  });

  it('re-checks the allow-list on every call, so an already-issued session loses access immediately once its domain is removed', async () => {
    // CLAUDE.md §6 — re-verify current state from the source of truth, don't
    // trust a cached claim. Same pattern already established for requireAdmin
    // (#32) but applied to the whole-API gate rather than just admin routes.
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
    const app = buildApp();
    const cookie = `${SESSION_COOKIE_NAME}=${createSession('someone@corp.com')}`;

    expect((await request(app).get('/protected').set('Cookie', cookie)).status).toBe(200);

    process.env.ALLOWED_EMAIL_DOMAINS = 'a-different-company.com';

    expect((await request(app).get('/protected').set('Cookie', cookie)).status).toBe(401);
  });

  it('does not trust a caller-supplied identity header', async () => {
    const res = await request(buildApp())
      .get('/protected')
      .set('X-User-Email', TEST_LOGIN_EMAIL)
      .set('userEmail', TEST_LOGIN_EMAIL);
    expect(res.status).toBe(401);
  });
});
