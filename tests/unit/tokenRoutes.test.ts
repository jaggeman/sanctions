import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createFakeDb } from './helpers/fakeFirestore';

const {
  mockCreateApiToken,
  mockListApiTokens,
  mockRevokeApiToken,
  mockValidateScopes,
} = vi.hoisted(() => ({
  mockCreateApiToken: vi.fn(),
  mockListApiTokens: vi.fn(),
  mockRevokeApiToken: vi.fn(),
  mockValidateScopes: vi.fn(),
}));

vi.mock('../../src/shared/apiTokens', () => ({
  createApiToken: mockCreateApiToken,
  listApiTokens: mockListApiTokens,
  revokeApiToken: mockRevokeApiToken,
  validateScopes: mockValidateScopes,
}));

// src/auth/session.ts now persists sessions through `db` (issue #63).
const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

// Dynamic imports, not static ones: these modules transitively import
// src/shared/firebase, and a static import would be hoisted above the
// `fakeDb` initialization above (Vitest hoists vi.mock/import ordering),
// throwing "Cannot access 'fakeDb' before initialization".
const { tokensRouter } = await import('../../src/api/routes/tokens');
const { createSession } = await import('../../src/auth/session');
const { SESSION_COOKIE_NAME } = await import('../../src/auth/middleware');

const ADMIN_EMAIL = 'admin@corp.test';
const NON_ADMIN_EMAIL = 'regular.user@corp.test';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/tokens', tokensRouter);
  return app;
}

/** Every route on this router is behind requireAdmin, so requests need a real admin session. */
const adminCookie = async () => `${SESSION_COOKIE_NAME}=${await createSession(ADMIN_EMAIL)}`;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeDb();
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  mockValidateScopes.mockImplementation(
    (scopes: unknown) => Array.isArray(scopes) && scopes.length > 0
  );
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('admin gate on /api/admin/tokens', () => {
  const routes: Array<[string, () => request.Test]> = [
    ['POST /', () => request(buildApp()).post('/api/admin/tokens').send({ name: 'x', scopes: ['read'] })],
    ['GET /', () => request(buildApp()).get('/api/admin/tokens')],
    ['POST /:id/revoke', () => request(buildApp()).post('/api/admin/tokens/abc/revoke')],
  ];

  for (const [label, call] of routes) {
    it(`${label} rejects an unauthenticated caller`, async () => {
      expect((await call()).status).toBe(401);
    });

    it(`${label} rejects an authenticated non-admin`, async () => {
      const res = await call().set(
        'Cookie',
        `${SESSION_COOKIE_NAME}=${await createSession(NON_ADMIN_EMAIL)}`,
      );
      expect(res.status).toBe(403);
    });
  }

  it('does not create a token for a non-admin caller', async () => {
    await request(buildApp())
      .post('/api/admin/tokens')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${await createSession(NON_ADMIN_EMAIL)}`)
      .send({ name: 'escalation', scopes: ['write'] });

    expect(mockCreateApiToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/tokens', () => {
  it('requires a non-empty name', async () => {
    const res = await request(buildApp())
      .post('/api/admin/tokens')
      .set('Cookie', await adminCookie())
      .send({ scopes: ['read'] });

    expect(res.status).toBe(400);
    expect(mockCreateApiToken).not.toHaveBeenCalled();
  });

  it('requires valid scopes', async () => {
    mockValidateScopes.mockReturnValueOnce(false);

    const res = await request(buildApp())
      .post('/api/admin/tokens')
      .set('Cookie', await adminCookie())
      .send({ name: 'CI pipeline', scopes: ['admin'] });

    expect(res.status).toBe(400);
    expect(mockCreateApiToken).not.toHaveBeenCalled();
  });

  it('creates a token and returns it with 201', async () => {
    mockCreateApiToken.mockResolvedValueOnce({
      token: 'sanc_rawtoken',
      record: {
        id: 'tok-1',
        name: 'CI pipeline',
        tokenPreview: 'sanc_...oken',
        scopes: ['read'],
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
        revoked: false,
        revokedAt: null,
      },
    });

    const res = await request(buildApp())
      .post('/api/admin/tokens')
      .set('Cookie', await adminCookie())
      .send({ name: 'CI pipeline', scopes: ['read'] });

    expect(res.status).toBe(201);
    expect(res.body.token).toBe('sanc_rawtoken');
    expect(res.body.id).toBe('tok-1');
    expect(mockCreateApiToken).toHaveBeenCalledWith('CI pipeline', ['read']);
  });

  it('returns 500 with details when createApiToken throws', async () => {
    mockCreateApiToken.mockRejectedValueOnce(new Error('boom'));

    const res = await request(buildApp())
      .post('/api/admin/tokens')
      .set('Cookie', adminCookie())
      .send({ name: 'CI pipeline', scopes: ['read'] });

    expect(res.status).toBe(500);
    expect(res.body.details).toBe('boom');
  });
});

describe('GET /api/admin/tokens', () => {
  it('returns the token list', async () => {
    mockListApiTokens.mockResolvedValueOnce([
      { id: 'tok-1', name: 'CI pipeline', scopes: ['read'] },
    ]);

    const res = await request(buildApp()).get('/api/admin/tokens').set('Cookie', await adminCookie());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('tok-1');
  });

  it('returns 500 with details when listApiTokens throws', async () => {
    mockListApiTokens.mockRejectedValueOnce(new Error('boom'));

    const res = await request(buildApp()).get('/api/admin/tokens').set('Cookie', adminCookie());

    expect(res.status).toBe(500);
    expect(res.body.details).toBe('boom');
  });
});

describe('POST /api/admin/tokens/:id/revoke', () => {
  it('returns 404 when the token does not exist', async () => {
    mockRevokeApiToken.mockResolvedValueOnce(null);

    const res = await request(buildApp()).post('/api/admin/tokens/missing/revoke').set('Cookie', await adminCookie());

    expect(res.status).toBe(404);
  });

  it('revokes an existing token', async () => {
    mockRevokeApiToken.mockResolvedValueOnce({ id: 'tok-1', revoked: true });

    const res = await request(buildApp()).post('/api/admin/tokens/tok-1/revoke').set('Cookie', await adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(mockRevokeApiToken).toHaveBeenCalledWith('tok-1');
  });

  it('rejects an id containing a URL-encoded slash before calling revokeApiToken', async () => {
    const res = await request(buildApp())
      .post('/api/admin/tokens/tok-1%2F..%2Fadmins%2Fattacker/revoke')
      .set('Cookie', adminCookie());

    expect(res.status).toBe(400);
    expect(mockRevokeApiToken).not.toHaveBeenCalled();
  });

  it('returns 500 with details when revokeApiToken throws', async () => {
    mockRevokeApiToken.mockRejectedValueOnce(new Error('boom'));

    const res = await request(buildApp()).post('/api/admin/tokens/tok-1/revoke').set('Cookie', adminCookie());

    expect(res.status).toBe(500);
    expect(res.body.details).toBe('boom');
  });
});
