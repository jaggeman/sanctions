import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createFakeDb } from './helpers/fakeFirestore';

const {
  mockCreateCustomRecord,
  mockUpdateCustomRecord,
  mockDeleteCustomRecord,
  mockGetCustomRecord,
} = vi.hoisted(() => ({
  mockCreateCustomRecord: vi.fn(),
  mockUpdateCustomRecord: vi.fn(),
  mockDeleteCustomRecord: vi.fn(),
  mockGetCustomRecord: vi.fn(),
}));

vi.mock('../../src/customRecords', () => ({
  createCustomRecord: mockCreateCustomRecord,
  updateCustomRecord: mockUpdateCustomRecord,
  deleteCustomRecord: mockDeleteCustomRecord,
  getCustomRecord: mockGetCustomRecord,
}));

// src/auth/session.ts persists sessions through `db` (issue #63).
const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

// Dynamic imports: these modules transitively import src/shared/firebase, and
// a static import would be hoisted above the fakeDb initialization above
// (Vitest hoists vi.mock/import ordering), throwing "Cannot access 'fakeDb'
// before initialization".
const { customRecordsRouter } = await import('../../src/api/routes/customRecords');
const { createSession } = await import('../../src/auth/session');
const { SESSION_COOKIE_NAME } = await import('../../src/auth/middleware');
const { createApiToken } = await import('../../src/shared/apiTokens');

const ADMIN_EMAIL = 'admin@corp.test';
const NON_ADMIN_EMAIL = 'regular.user@corp.test';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/custom-records', customRecordsRouter);
  return app;
}

/** Every route on this router is behind requireAdmin, so requests need a real admin session. */
const adminCookie = async () => `${SESSION_COOKIE_NAME}=${await createSession(ADMIN_EMAIL)}`;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeDb();
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.ALLOWED_EMAIL_DOMAINS = 'corp.test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('admin gate on /api/admin/custom-records', () => {
  const routes: Array<[string, () => request.Test]> = [
    ['POST /', () => request(buildApp()).post('/api/admin/custom-records').send({ id: 'CUSTOM-1', type: 'individual', primaryName: 'x' })],
    ['PUT /:id', () => request(buildApp()).put('/api/admin/custom-records/CUSTOM-1').send({ primaryName: 'x' })],
    ['DELETE /:id', () => request(buildApp()).delete('/api/admin/custom-records/CUSTOM-1').send({ confirm: true })],
    ['GET /:id', () => request(buildApp()).get('/api/admin/custom-records/CUSTOM-1')],
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

  it('does not create a record for a non-admin caller', async () => {
    await request(buildApp())
      .post('/api/admin/custom-records')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${await createSession(NON_ADMIN_EMAIL)}`)
      .send({ id: 'CUSTOM-1', type: 'individual', primaryName: 'x' });

    expect(mockCreateCustomRecord).not.toHaveBeenCalled();
  });

  describe('bearer token admin demotion (issue #297)', () => {
    it('authorizes custom record creation with a valid token when owner is in ADMIN_EMAILS', async () => {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL;
      process.env.ALLOWED_EMAIL_DOMAINS = 'corp.test';
      const { token } = await createApiToken('admin token', ['custom:write'], ADMIN_EMAIL);

      mockCreateCustomRecord.mockResolvedValueOnce({
        id: 'CUSTOM-1',
        source: 'CUSTOM',
        type: 'individual',
        primaryName: 'Jane Doe',
      });

      const res = await request(buildApp())
        .post('/api/admin/custom-records')
        .set('Authorization', `Bearer ${token}`)
        .send({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });

      expect(res.status).toBe(201);
      expect(mockCreateCustomRecord).toHaveBeenCalled();
    });

    it('rejects custom record operations with 403 when the token owner is removed from ADMIN_EMAILS', async () => {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL;
      process.env.ALLOWED_EMAIL_DOMAINS = 'corp.test';
      const { token } = await createApiToken('admin token', ['custom:write'], ADMIN_EMAIL);

      // Owner is demoted: removed from ADMIN_EMAILS, but stays in ALLOWED_EMAIL_DOMAINS
      process.env.ADMIN_EMAILS = 'otheradmin@corp.test';

      const res = await request(buildApp())
        .post('/api/admin/custom-records')
        .set('Authorization', `Bearer ${token}`)
        .send({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/no longer an administrator/i);
      expect(mockCreateCustomRecord).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/admin/custom-records', () => {
  it('requires a non-empty primaryName', async () => {
    const res = await request(buildApp())
      .post('/api/admin/custom-records')
      .set('Cookie', await adminCookie())
      .send({ id: 'CUSTOM-1', type: 'individual' });

    expect(res.status).toBe(400);
    expect(mockCreateCustomRecord).not.toHaveBeenCalled();
  });

  it('rejects an id containing a URL-encoded slash before calling createCustomRecord', async () => {
    const res = await request(buildApp())
      .post('/api/admin/custom-records')
      .set('Cookie', await adminCookie())
      .send({ id: 'CUSTOM-1/../admins', type: 'individual', primaryName: 'x' });

    expect(res.status).toBe(400);
    expect(mockCreateCustomRecord).not.toHaveBeenCalled();
  });

  it('creates a record and returns it with 201', async () => {
    mockCreateCustomRecord.mockResolvedValueOnce({
      id: 'CUSTOM-1',
      source: 'CUSTOM',
      type: 'individual',
      primaryName: 'Jane Doe',
      aliases: [],
      searchNames: ['jane', 'doe'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(buildApp())
      .post('/api/admin/custom-records')
      .set('Cookie', await adminCookie())
      .send({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('CUSTOM-1');
    expect(mockCreateCustomRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'CUSTOM-1', primaryName: 'Jane Doe' }),
    );
  });

  it('returns 409 when createCustomRecord rejects a duplicate', async () => {
    mockCreateCustomRecord.mockRejectedValueOnce(new Error('A record with id "CUSTOM-1" already exists — cannot create a duplicate custom record.'));

    const res = await request(buildApp())
      .post('/api/admin/custom-records')
      .set('Cookie', await adminCookie())
      .send({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });

    expect(res.status).toBe(409);
  });

  it('returns 500 on an unexpected error without leaking details', async () => {
    mockCreateCustomRecord.mockRejectedValueOnce(new Error('boom'));

    const res = await request(buildApp())
      .post('/api/admin/custom-records')
      .set('Cookie', await adminCookie())
      .send({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.details).toBeUndefined();
  });
});

describe('PUT /api/admin/custom-records/:id', () => {
  it('updates a record and returns it', async () => {
    mockUpdateCustomRecord.mockResolvedValueOnce({ id: 'CUSTOM-1', source: 'CUSTOM', primaryName: 'Janet Doe' });

    const res = await request(buildApp())
      .put('/api/admin/custom-records/CUSTOM-1')
      .set('Cookie', await adminCookie())
      .send({ primaryName: 'Janet Doe' });

    expect(res.status).toBe(200);
    expect(res.body.primaryName).toBe('Janet Doe');
    expect(mockUpdateCustomRecord).toHaveBeenCalledWith('CUSTOM-1', { primaryName: 'Janet Doe' });
  });

  it('returns 404 when the target record does not exist', async () => {
    mockUpdateCustomRecord.mockRejectedValueOnce(new Error('No custom record found with id "CUSTOM-404".'));

    const res = await request(buildApp())
      .put('/api/admin/custom-records/CUSTOM-404')
      .set('Cookie', await adminCookie())
      .send({ primaryName: 'x' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when the target is not a custom record', async () => {
    mockUpdateCustomRecord.mockRejectedValueOnce(new Error('Record "EU-1" is not a custom record (source: EU) — use the overrides path instead.'));

    const res = await request(buildApp())
      .put('/api/admin/custom-records/EU-1')
      .set('Cookie', await adminCookie())
      .send({ primaryName: 'x' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/custom-records/:id', () => {
  it('requires confirm: true in the body', async () => {
    const res = await request(buildApp())
      .delete('/api/admin/custom-records/CUSTOM-1')
      .set('Cookie', await adminCookie())
      .send({});

    expect(res.status).toBe(400);
    expect(mockDeleteCustomRecord).not.toHaveBeenCalled();
  });

  it('deletes the record when confirm is true', async () => {
    mockDeleteCustomRecord.mockResolvedValueOnce(undefined);

    const res = await request(buildApp())
      .delete('/api/admin/custom-records/CUSTOM-1')
      .set('Cookie', await adminCookie())
      .send({ confirm: true });

    expect(res.status).toBe(200);
    expect(mockDeleteCustomRecord).toHaveBeenCalledWith('CUSTOM-1', { confirm: true });
  });

  it('returns 404 when the target record does not exist', async () => {
    mockDeleteCustomRecord.mockRejectedValueOnce(new Error('No custom record found with id "CUSTOM-404".'));

    const res = await request(buildApp())
      .delete('/api/admin/custom-records/CUSTOM-404')
      .set('Cookie', await adminCookie())
      .send({ confirm: true });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/custom-records/:id', () => {
  it('returns the record when it exists', async () => {
    mockGetCustomRecord.mockResolvedValueOnce({ id: 'CUSTOM-1', source: 'CUSTOM', primaryName: 'Jane Doe' });

    const res = await request(buildApp()).get('/api/admin/custom-records/CUSTOM-1').set('Cookie', await adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.primaryName).toBe('Jane Doe');
  });

  it('returns 404 when the record does not exist', async () => {
    mockGetCustomRecord.mockResolvedValueOnce(null);

    const res = await request(buildApp()).get('/api/admin/custom-records/CUSTOM-404').set('Cookie', await adminCookie());

    expect(res.status).toBe(404);
  });
});
