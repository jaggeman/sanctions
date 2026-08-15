import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const { mockVerifyApiToken } = vi.hoisted(() => ({
  mockVerifyApiToken: vi.fn(),
}));

vi.mock('../../src/shared/apiTokens', () => ({
  verifyApiToken: mockVerifyApiToken,
}));

import { requireScope } from '../../src/api/middleware/requireScope';

function makeReq(authHeader?: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined),
  } as unknown as Request;
}

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireScope', () => {
  it('responds 401 when the Authorization header is missing', async () => {
    mockVerifyApiToken.mockResolvedValueOnce({ valid: false, reason: 'missing' });
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await requireScope('read')(req, res, next);

    expect(mockVerifyApiToken).toHaveBeenCalledWith(undefined, 'read');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('extracts the bearer token and responds 401 for an invalid token', async () => {
    mockVerifyApiToken.mockResolvedValueOnce({ valid: false, reason: 'not_found' });
    const req = makeReq('Bearer sanc_bogus');
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await requireScope('read')(req, res, next);

    expect(mockVerifyApiToken).toHaveBeenCalledWith('sanc_bogus', 'read');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 403 when the token lacks the required scope', async () => {
    mockVerifyApiToken.mockResolvedValueOnce({
      valid: false,
      reason: 'insufficient_scope',
      tokenId: 'tok-1',
      scopes: ['read'],
    });
    const req = makeReq('Bearer sanc_readonly');
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await requireScope('write')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches the token id when valid', async () => {
    mockVerifyApiToken.mockResolvedValueOnce({ valid: true, tokenId: 'tok-1', scopes: ['read', 'write'] });
    const req = makeReq('Bearer sanc_good') as any;
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await requireScope('read')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.apiTokenId).toBe('tok-1');
  });
});
