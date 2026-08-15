import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createFakeDb } from './helpers/fakeFirestore';

const { mockSaveDecision, mockListDecisionsForEntity } = vi.hoisted(() => ({
  mockSaveDecision: vi.fn(),
  mockListDecisionsForEntity: vi.fn(),
}));

vi.mock('../../src/decisions', () => ({
  saveDecision: mockSaveDecision,
  listDecisionsForEntity: mockListDecisionsForEntity,
}));

// src/auth/session.ts now persists sessions through `db` (issue #63), so
// this suite's authedCookie() needs a working fake Firestore, not just a
// bare stub.
const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

// Dynamic imports, not static ones: these modules transitively import
// src/shared/firebase, and a static import would be hoisted above the
// `fakeDb` initialization above (Vitest hoists vi.mock/import ordering),
// throwing "Cannot access 'fakeDb' before initialization".
const { decisionsRouter } = await import('../../src/api/routes/decisions');
const { SESSION_COOKIE_NAME } = await import('../../src/auth/middleware');
const { createSession } = await import('../../src/auth/session');

const ANALYST_EMAIL = 'analyst@example.com';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // decisionsRouter carries its own requireAuthOrScope gate internally (a
  // prior version relied on a blanket app.use('/api', requireAuth) that no
  // longer exists — see the "requires authentication" tests below, which
  // mount the bare router with no test-only auth shim, so they only pass if
  // the router itself actually enforces auth).
  app.use('/api/decisions', decisionsRouter);
  return app;
}

const authedCookie = async () => `${SESSION_COOKIE_NAME}=${await createSession(ANALYST_EMAIL)}`;

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeDb();
  // requireAuth re-checks the email allow-list (issue #33) on every request,
  // not just at login — analyst@example.com needs its domain allow-listed
  // for the "authenticated" test cases below to actually authenticate.
  vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
});

describe('requires authentication', () => {
  it('rejects POST / without a session', async () => {
    const res = await request(buildApp()).post('/api/decisions').send({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive' });
    expect(res.status).toBe(401);
  });

  it('rejects GET /:entityId without a session', async () => {
    const res = await request(buildApp()).get('/api/decisions/EU-1');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/decisions', () => {
  // Field validation itself lives in src/decisions (already covered by
  // tests/unit/decisions.test.ts) — the route's job is just to translate a
  // rejected saveDecision() into a 400 with the underlying message, so these
  // simulate that rejection rather than duplicating the validation rules here.
  it('rejects a missing entityId', async () => {
    mockSaveDecision.mockRejectedValue(new Error('"entityId" must be a non-empty string of letters, numbers, "-", or "_".'));
    const res = await request(buildApp())
      .post('/api/decisions')
      .set('Cookie', await authedCookie())
      .send({ subjectId: 'cust-a', verdict: 'false_positive' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/entityId/i);
  });

  it('rejects a missing subjectId', async () => {
    mockSaveDecision.mockRejectedValue(new Error('"subjectId" must be a non-empty string of letters, numbers, "-", or "_".'));
    const res = await request(buildApp())
      .post('/api/decisions')
      .set('Cookie', await authedCookie())
      .send({ entityId: 'EU-1', verdict: 'false_positive' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subjectId/i);
  });

  it('rejects an invalid verdict', async () => {
    mockSaveDecision.mockRejectedValue(new Error('"verdict" must be "false_positive" or "true_positive".'));
    const res = await request(buildApp())
      .post('/api/decisions')
      .set('Cookie', await authedCookie())
      .send({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'unsure' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verdict/i);
  });

  it('ignores a client-supplied decidedBy and uses the authenticated session email instead', async () => {
    mockSaveDecision.mockResolvedValue({
      entityId: 'EU-1',
      subjectId: 'cust-a',
      verdict: 'false_positive',
      decidedBy: ANALYST_EMAIL,
      decidedAt: '2026-08-15T00:00:00.000Z',
    });

    await request(buildApp())
      .post('/api/decisions')
      .set('Cookie', await authedCookie())
      .send({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive', decidedBy: 'someone-else@evil.test' });

    expect(mockSaveDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decidedBy: ANALYST_EMAIL }),
    );
  });

  it('returns 201 with the saved decision on success', async () => {
    const saved = {
      entityId: 'EU-1',
      subjectId: 'cust-a',
      verdict: 'false_positive',
      decidedBy: ANALYST_EMAIL,
      decidedAt: '2026-08-15T00:00:00.000Z',
    };
    mockSaveDecision.mockResolvedValue(saved);

    const res = await request(buildApp())
      .post('/api/decisions')
      .set('Cookie', await authedCookie())
      .send({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(saved);
  });

  it('returns 400 with the underlying message when saveDecision rejects validation', async () => {
    mockSaveDecision.mockRejectedValue(new Error('"entityId" must be a non-empty string of letters, numbers, "-", or "_".'));

    const res = await request(buildApp())
      .post('/api/decisions')
      .set('Cookie', await authedCookie())
      .send({ entityId: 'bad/id', subjectId: 'cust-a', verdict: 'false_positive' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/entityId/i);
  });
});

describe('GET /api/decisions/:entityId', () => {
  it('returns the list of decisions for the entity', async () => {
    const decisions = [
      { entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive', decidedBy: ANALYST_EMAIL, decidedAt: '2026-08-15T00:00:00.000Z' },
    ];
    mockListDecisionsForEntity.mockResolvedValue(decisions);

    const res = await request(buildApp()).get('/api/decisions/EU-1').set('Cookie', await authedCookie());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(decisions);
    expect(mockListDecisionsForEntity).toHaveBeenCalledWith('EU-1');
  });

  it('returns an empty array when there are none', async () => {
    mockListDecisionsForEntity.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/decisions/EU-404').set('Cookie', await authedCookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
