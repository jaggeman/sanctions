import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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

import { tokensRouter } from '../../src/api/routes/tokens';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/tokens', tokensRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateScopes.mockImplementation(
    (scopes: unknown) => Array.isArray(scopes) && scopes.length > 0
  );
});

describe('POST /api/admin/tokens', () => {
  it('requires a non-empty name', async () => {
    const res = await request(buildApp())
      .post('/api/admin/tokens')
      .send({ scopes: ['read'] });

    expect(res.status).toBe(400);
    expect(mockCreateApiToken).not.toHaveBeenCalled();
  });

  it('requires valid scopes', async () => {
    mockValidateScopes.mockReturnValueOnce(false);

    const res = await request(buildApp())
      .post('/api/admin/tokens')
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
      .send({ name: 'CI pipeline', scopes: ['read'] });

    expect(res.status).toBe(201);
    expect(res.body.token).toBe('sanc_rawtoken');
    expect(res.body.id).toBe('tok-1');
    expect(mockCreateApiToken).toHaveBeenCalledWith('CI pipeline', ['read']);
  });
});

describe('GET /api/admin/tokens', () => {
  it('returns the token list', async () => {
    mockListApiTokens.mockResolvedValueOnce([
      { id: 'tok-1', name: 'CI pipeline', scopes: ['read'] },
    ]);

    const res = await request(buildApp()).get('/api/admin/tokens');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('tok-1');
  });
});

describe('POST /api/admin/tokens/:id/revoke', () => {
  it('returns 404 when the token does not exist', async () => {
    mockRevokeApiToken.mockResolvedValueOnce(null);

    const res = await request(buildApp()).post('/api/admin/tokens/missing/revoke');

    expect(res.status).toBe(404);
  });

  it('revokes an existing token', async () => {
    mockRevokeApiToken.mockResolvedValueOnce({ id: 'tok-1', revoked: true });

    const res = await request(buildApp()).post('/api/admin/tokens/tok-1/revoke');

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(mockRevokeApiToken).toHaveBeenCalledWith('tok-1');
  });
});
