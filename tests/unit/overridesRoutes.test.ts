import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createFakeDb } from './helpers/fakeFirestore';

const {
  mockSaveOverride,
  mockDeleteOverride,
  mockInvalidateSearchIndex,
} = vi.hoisted(() => ({
  mockSaveOverride: vi.fn(),
  mockDeleteOverride: vi.fn(),
  mockInvalidateSearchIndex: vi.fn(),
}));

vi.mock('../../src/overrides', async () => {
  const actual = await vi.importActual<typeof import('../../src/overrides')>('../../src/overrides');
  return {
    ...actual,
    saveOverride: mockSaveOverride,
    deleteOverride: mockDeleteOverride,
  };
});

vi.mock('../../src/search', () => ({ invalidateSearchIndex: mockInvalidateSearchIndex }));

// The route checks the target entity exists before accepting a write.
let sanctionsDocExists = true;
// Issue #63: this suite logs sessions in through the real session store
// (below), which now persists through `db` — delegate `sessions`/`otpCodes`
// to the shared fake Firestore rather than hand-rolling that here too.
const { db: authFakeDb, reset: resetAuthFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({
  db: {
    collection: vi.fn((name: string) => {
      if (name === 'sessions' || name === 'otpCodes') {
        return authFakeDb.collection(name);
      }
      if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
      return { doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: sanctionsDocExists })) })) };
    }),
  },
}));

import { overridesRouter } from '../../src/api/routes/overrides';
import { createSession } from '../../src/auth/session';
import { SESSION_COOKIE_NAME } from '../../src/auth/middleware';

const CALLER_EMAIL = 'analyst@example.com';

// overridesRouter carries its own requireAuthOrScope('write') gate
// internally — no test-only auth shim here, so a request only succeeds if
// the router itself authenticates it, the same as production.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/overrides', overridesRouter);
  return app;
}

const authedCookie = async (email: string = CALLER_EMAIL) => `${SESSION_COOKIE_NAME}=${await createSession(email)}`;

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthFakeDb();
  vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
  sanctionsDocExists = true;
  mockSaveOverride.mockImplementation(async (entityId: string, fields: any, meta: any) => ({
    entityId,
    fields,
    overriddenBy: meta.overriddenBy,
    overriddenAt: '2026-01-01T00:00:00.000Z',
    reason: meta.reason,
  }));
  mockDeleteOverride.mockResolvedValue(undefined);
});

describe('requires authentication', () => {
  it('rejects PUT /:id without a session', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .send({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });
    expect(res.status).toBe(401);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('rejects DELETE /:id without a session', async () => {
    const res = await request(buildApp()).delete('/api/overrides/EU-1');
    expect(res.status).toBe(401);
    expect(mockDeleteOverride).not.toHaveBeenCalled();
  });
});

describe('PUT /api/overrides/:id', () => {
  it('requires a non-empty "fields" object', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .set('Cookie', await authedCookie())
      .send({ reason: 'Fix' });
    expect(res.status).toBe(400);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('rejects an empty "fields" object', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .set('Cookie', await authedCookie())
      .send({ fields: {}, reason: 'Fix' });
    expect(res.status).toBe(400);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('requires a non-empty "reason"', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .set('Cookie', await authedCookie())
      .send({ fields: { sanctionReason: 'Corrected' } });
    expect(res.status).toBe(400);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('rejects a write attempt at an immutable key with a clear 400, not a silent no-op', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .set('Cookie', await authedCookie())
      .send({ fields: { status: 'active', sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('404s when the target sanctions record does not exist — cannot override a record that is not there', async () => {
    sanctionsDocExists = false;
    const res = await request(buildApp())
      .put('/api/overrides/DOES-NOT-EXIST')
      .set('Cookie', await authedCookie())
      .send({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(res.status).toBe(404);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('saves the override with overriddenBy from the authenticated caller, not the request body', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .set('Cookie', await authedCookie())
      .send({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix', overriddenBy: 'spoofed@evil.com' });

    expect(res.status).toBe(200);
    expect(mockSaveOverride).toHaveBeenCalledWith(
      'EU-1',
      { sanctionReason: 'Corrected' },
      { overriddenBy: CALLER_EMAIL, reason: 'Fix' },
    );
    expect(res.body.overriddenBy).toBe(CALLER_EMAIL);
  });

  it('invalidates the search index after a successful save, so search never serves stale data', async () => {
    await request(buildApp())
      .put('/api/overrides/EU-1')
      .set('Cookie', await authedCookie())
      .send({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(mockInvalidateSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate the index when the request was rejected before saving', async () => {
    await request(buildApp())
      .put('/api/overrides/EU-1')
      .set('Cookie', await authedCookie())
      .send({ reason: 'Fix' }); // missing fields
    expect(mockInvalidateSearchIndex).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/overrides/:id', () => {
  it('deletes the override and invalidates the search index', async () => {
    const res = await request(buildApp())
      .delete('/api/overrides/EU-1')
      .set('Cookie', await authedCookie());

    expect(res.status).toBe(200);
    expect(mockDeleteOverride).toHaveBeenCalledWith('EU-1');
    expect(mockInvalidateSearchIndex).toHaveBeenCalledTimes(1);
  });
});

describe('id validation on /api/overrides/:id', () => {
  it('rejects a PUT with a URL-encoded slash in the id before touching Firestore or saveOverride', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1%2F..%2Fadmins%2Fattacker')
      .set('Cookie', await authedCookie())
      .send({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(res.status).toBe(400);
    expect(mockSaveOverride).not.toHaveBeenCalled();
    expect(mockInvalidateSearchIndex).not.toHaveBeenCalled();
  });

  it('rejects a DELETE with an invalid id before calling deleteOverride', async () => {
    const res = await request(buildApp())
      .delete('/api/overrides/EU%401')
      .set('Cookie', await authedCookie());
    expect(res.status).toBe(400);
    expect(mockDeleteOverride).not.toHaveBeenCalled();
  });
});
