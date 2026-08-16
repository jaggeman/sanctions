import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createFakeDb } from '../helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../../src/shared/firebase', () => ({ db: fakeDb }));

const { requireAdmin } = await import('../../../src/api/middleware/requireAdmin');
const { isAdminEmail } = await import('../../../src/auth/admins');
const { createSession, destroySession } = await import('../../../src/auth/session');
const { SESSION_COOKIE_NAME } = await import('../../../src/auth/middleware');
const { TEST_LOGIN_EMAIL } = await import('../../../src/auth/testAccount');
const { requestLogger } = await import('../../../src/api/middleware/requestLogger');

function readJsonLines(spy: ReturnType<typeof vi.spyOn>): any[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.get('/admin', requireAdmin, (req, res) => {
    res.json({ ok: true, email: (req as any).userEmail });
  });
  return app;
}

const asUser = async (email: string) =>
  request(buildApp()).get('/admin').set('Cookie', `${SESSION_COOKIE_NAME}=${await createSession(email)}`);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetFakeDb();
  process.env.NODE_ENV = 'test';
  process.env.ALLOWED_EMAIL_DOMAINS = 'corp.com';
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

  it('in non-production, the dev test account is always admin even when ADMIN_EMAILS is set', () => {
    process.env.NODE_ENV = 'development';
    process.env.ADMIN_EMAILS = 'a@corp.com';
    expect(isAdminEmail(TEST_LOGIN_EMAIL)).toBe(true);
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
    const res = await asUser('user@corp.com');
    expect(res.status).toBe(403);
  });

  it('re-checks the allow-list on every call, so revoking admin takes effect immediately', async () => {
    // A live session must not keep admin rights after being removed from the
    // allow-list (CLAUDE.md §6 — re-verify, don't trust a cached claim).
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const app = buildApp();
    const cookie = `${SESSION_COOKIE_NAME}=${await createSession('a@corp.com')}`;

    expect((await request(app).get('/admin').set('Cookie', cookie)).status).toBe(200);

    process.env.ADMIN_EMAILS = 'someone.else@corp.com';

    expect((await request(app).get('/admin').set('Cookie', cookie)).status).toBe(403);
  });

  it('rejects a destroyed session even for an admin address', async () => {
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const sessionId = await createSession('a@corp.com');
    await destroySession(sessionId);
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

  it('binds the admin email into req.log, so request.finish includes it (issue #110)', async () => {
    process.env.ADMIN_EMAILS = 'a@corp.com';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const app = express();
      app.use(requestLogger);
      app.use(cookieParser());
      app.get('/admin', requireAdmin, (req, res) => res.json({ ok: true }));

      const cookie = `${SESSION_COOKIE_NAME}=${await createSession('a@corp.com')}`;
      await request(app).get('/admin').set('Cookie', cookie);

      const entries = readJsonLines(logSpy);
      const finish = entries.find((e) => e.message === 'request.finish');
      expect(finish.userEmail).toBe('a***@corp.com');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('rejects an admin whose email domain is not in ALLOWED_EMAIL_DOMAINS with 401', async () => {
    process.env.ADMIN_EMAILS = 'admin@revoked-domain.com';
    process.env.ALLOWED_EMAIL_DOMAINS = 'allowed-domain.com';

    const cookie = `${SESSION_COOKIE_NAME}=${await createSession('admin@revoked-domain.com')}`;
    const res = await request(buildApp()).get('/admin').set('Cookie', cookie);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('returns 500 without leaking error details when session retrieval throws', async () => {
    const brokenDb = {
      collection: () => ({
        doc: () => ({
          get: vi.fn().mockRejectedValueOnce(new Error('firestore timeout')),
        }),
      }),
    };
    vi.spyOn(fakeDb, 'collection').mockImplementationOnce(brokenDb.collection as any);

    const res = await request(buildApp())
      .get('/admin')
      .set('Cookie', `${SESSION_COOKIE_NAME}=some-session-id`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.details).toBeUndefined();
  });
});
