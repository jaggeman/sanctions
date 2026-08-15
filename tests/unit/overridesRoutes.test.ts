import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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
vi.mock('../../src/shared/firebase', () => ({
  db: {
    collection: vi.fn((name: string) => {
      if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
      return { doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: sanctionsDocExists })) })) };
    }),
  },
}));

import { overridesRouter } from '../../src/api/routes/overrides';

const CALLER_EMAIL = 'analyst@example.com';

// In production, req.userEmail is set by the blanket requireAuth gate that
// runs before overridesRouter (src/api/index.ts). This standalone app
// simulates that directly.
function buildApp(callerEmail: string | undefined = CALLER_EMAIL) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (callerEmail) (req as any).userEmail = callerEmail;
    next();
  });
  app.use('/api/overrides', overridesRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('PUT /api/overrides/:id', () => {
  it('requires a non-empty "fields" object', async () => {
    const res = await request(buildApp()).put('/api/overrides/EU-1').send({ reason: 'Fix' });
    expect(res.status).toBe(400);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('rejects an empty "fields" object', async () => {
    const res = await request(buildApp()).put('/api/overrides/EU-1').send({ fields: {}, reason: 'Fix' });
    expect(res.status).toBe(400);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('requires a non-empty "reason"', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .send({ fields: { sanctionReason: 'Corrected' } });
    expect(res.status).toBe(400);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('rejects a write attempt at an immutable key with a clear 400, not a silent no-op', async () => {
    const res = await request(buildApp())
      .put('/api/overrides/EU-1')
      .send({ fields: { status: 'active', sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('404s when the target sanctions record does not exist — cannot override a record that is not there', async () => {
    sanctionsDocExists = false;
    const res = await request(buildApp())
      .put('/api/overrides/DOES-NOT-EXIST')
      .send({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(res.status).toBe(404);
    expect(mockSaveOverride).not.toHaveBeenCalled();
  });

  it('saves the override with overriddenBy from the authenticated caller, not the request body', async () => {
    const res = await request(buildApp(CALLER_EMAIL))
      .put('/api/overrides/EU-1')
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
      .send({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(mockInvalidateSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate the index when the request was rejected before saving', async () => {
    await request(buildApp()).put('/api/overrides/EU-1').send({ reason: 'Fix' }); // missing fields
    expect(mockInvalidateSearchIndex).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/overrides/:id', () => {
  it('deletes the override and invalidates the search index', async () => {
    const res = await request(buildApp()).delete('/api/overrides/EU-1');

    expect(res.status).toBe(200);
    expect(mockDeleteOverride).toHaveBeenCalledWith('EU-1');
    expect(mockInvalidateSearchIndex).toHaveBeenCalledTimes(1);
  });
});
