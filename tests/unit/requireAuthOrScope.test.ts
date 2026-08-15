import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const { mockRequireAuth, mockRequireScope, mockScopeMiddleware } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockRequireScope: vi.fn(),
  mockScopeMiddleware: vi.fn(),
}));

vi.mock('../../src/auth/middleware', () => ({
  requireAuth: mockRequireAuth,
}));
vi.mock('../../src/api/middleware/requireScope', () => ({
  requireScope: mockRequireScope,
}));

import { requireAuthOrScope } from '../../src/api/middleware/requireAuthOrScope';

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
  mockRequireScope.mockReturnValue(mockScopeMiddleware);
});

describe('requireAuthOrScope', () => {
  it('delegates to requireScope(scope) when an Authorization header is present', async () => {
    const req = makeReq('Bearer sanc_abc123');
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await requireAuthOrScope('read')(req, res, next);

    expect(mockRequireScope).toHaveBeenCalledWith('read');
    expect(mockScopeMiddleware).toHaveBeenCalledWith(req, res, next);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('delegates to requireAuth (session cookie) when no Authorization header is present', async () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await requireAuthOrScope('read')(req, res, next);

    expect(mockRequireAuth).toHaveBeenCalledWith(req, res, next);
    expect(mockRequireScope).not.toHaveBeenCalled();
  });

  it('builds the requireScope middleware fresh per required scope', async () => {
    const req = makeReq('Bearer sanc_abc123');
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await requireAuthOrScope('write')(req, res, next);

    expect(mockRequireScope).toHaveBeenCalledWith('write');
  });
});
