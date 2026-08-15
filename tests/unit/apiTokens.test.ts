import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSet,
  mockDocGet,
  mockDocUpdate,
  mockDoc,
  mockOrderByGet,
  mockOrderBy,
  mockWhereLimitGet,
  mockLimit,
  mockWhere,
  mockCollection,
} = vi.hoisted(() => {
  const mockSet = vi.fn();
  const mockDocGet = vi.fn();
  const mockDocUpdate = vi.fn();
  const mockDoc = vi.fn(() => ({
    id: 'generated-id',
    set: mockSet,
    get: mockDocGet,
    update: mockDocUpdate,
  }));
  const mockOrderByGet = vi.fn();
  const mockOrderBy = vi.fn(() => ({ get: mockOrderByGet }));
  const mockWhereLimitGet = vi.fn();
  const mockLimit = vi.fn(() => ({ get: mockWhereLimitGet }));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockCollection = vi.fn(() => ({
    doc: mockDoc,
    orderBy: mockOrderBy,
    where: mockWhere,
  }));
  return {
    mockSet,
    mockDocGet,
    mockDocUpdate,
    mockDoc,
    mockOrderByGet,
    mockOrderBy,
    mockWhereLimitGet,
    mockLimit,
    mockWhere,
    mockCollection,
  };
});

vi.mock('../../src/shared/firebase', () => ({
  db: { collection: mockCollection },
  default: { collection: mockCollection },
}));

import {
  generateRawToken,
  hashToken,
  previewFromRawToken,
  validateScopes,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from '../../src/shared/apiTokens';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateRawToken', () => {
  it('starts with the sanc_ prefix', () => {
    expect(generateRawToken()).toMatch(/^sanc_[0-9a-f]{64}$/);
  });

  it('is different on every call', () => {
    expect(generateRawToken()).not.toBe(generateRawToken());
  });
});

describe('hashToken', () => {
  it('produces a deterministic 64-char sha256 hex digest', () => {
    const hash = hashToken('sanc_abc123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('sanc_abc123')).toBe(hash);
  });

  it('produces different hashes for different tokens', () => {
    expect(hashToken('sanc_abc123')).not.toBe(hashToken('sanc_xyz789'));
  });
});

describe('previewFromRawToken', () => {
  it('shows the prefix and only the last 4 characters', () => {
    expect(previewFromRawToken('sanc_0123456789abcdef')).toBe('sanc_...cdef');
  });
});

describe('validateScopes', () => {
  it('accepts ["read"], ["write"], and ["read","write"]', () => {
    expect(validateScopes(['read'])).toBe(true);
    expect(validateScopes(['write'])).toBe(true);
    expect(validateScopes(['read', 'write'])).toBe(true);
  });

  it('rejects empty arrays, unknown scopes, and non-arrays', () => {
    expect(validateScopes([])).toBe(false);
    expect(validateScopes(['admin'])).toBe(false);
    expect(validateScopes('read')).toBe(false);
    expect(validateScopes(undefined)).toBe(false);
  });
});

describe('createApiToken', () => {
  it('persists a hash (never the raw token) and returns the raw token once', async () => {
    mockSet.mockResolvedValueOnce(undefined);

    const { token, record } = await createApiToken('CI pipeline', ['read']);

    expect(token).toMatch(/^sanc_[0-9a-f]{64}$/);
    expect(mockCollection).toHaveBeenCalledWith('apiTokens');
    expect(mockSet).toHaveBeenCalledTimes(1);

    const persisted = mockSet.mock.calls[0][0];
    expect(persisted.tokenHash).toBe(hashToken(token));
    expect(persisted).not.toHaveProperty('token');

    expect(record).toEqual({
      id: 'generated-id',
      name: 'CI pipeline',
      tokenPreview: previewFromRawToken(token),
      scopes: ['read'],
      createdAt: persisted.createdAt,
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
    });
    expect(record).not.toHaveProperty('tokenHash');
  });
});

describe('listApiTokens', () => {
  it('returns public records without the token hash', async () => {
    const stored = {
      id: 'tok-1',
      name: 'Partner integration',
      tokenHash: 'deadbeef',
      tokenPreview: 'sanc_...beef',
      scopes: ['read', 'write'],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
    };
    mockOrderByGet.mockResolvedValueOnce({ docs: [{ data: () => stored }] });

    const tokens = await listApiTokens();

    expect(mockCollection).toHaveBeenCalledWith('apiTokens');
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toHaveProperty('tokenHash');
    expect(tokens[0]).toMatchObject({ id: 'tok-1', name: 'Partner integration' });
  });
});

describe('revokeApiToken', () => {
  it('marks an existing token revoked and returns the updated record', async () => {
    const stored = {
      id: 'tok-1',
      name: 'Partner integration',
      tokenHash: 'deadbeef',
      tokenPreview: 'sanc_...beef',
      scopes: ['read'],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
    };
    mockDocGet.mockResolvedValueOnce({ exists: true, data: () => stored });
    mockDocUpdate.mockResolvedValueOnce(undefined);

    const result = await revokeApiToken('tok-1');

    expect(mockDoc).toHaveBeenCalledWith('tok-1');
    expect(mockDocUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ revoked: true, revokedAt: expect.any(String) })
    );
    expect(result?.revoked).toBe(true);
    expect(result).not.toHaveProperty('tokenHash');
  });

  it('returns null when the token does not exist', async () => {
    mockDocGet.mockResolvedValueOnce({ exists: false });

    const result = await revokeApiToken('missing-id');

    expect(result).toBeNull();
    expect(mockDocUpdate).not.toHaveBeenCalled();
  });
});

describe('verifyApiToken', () => {
  it('rejects when no token is provided', async () => {
    const result = await verifyApiToken(undefined, 'read');
    expect(result).toEqual({ valid: false, reason: 'missing' });
  });

  it('rejects an unknown token', async () => {
    mockWhereLimitGet.mockResolvedValueOnce({ empty: true, docs: [] });

    const result = await verifyApiToken('sanc_unknown', 'read');

    expect(result).toEqual({ valid: false, reason: 'not_found' });
  });

  it('rejects a revoked token', async () => {
    const stored = {
      id: 'tok-1',
      scopes: ['read', 'write'],
      revoked: true,
    };
    mockWhereLimitGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => stored, ref: { update: mockDocUpdate } }],
    });

    const result = await verifyApiToken('sanc_revoked', 'read');

    expect(result).toEqual({ valid: false, reason: 'revoked' });
  });

  it('rejects a token missing the required scope', async () => {
    const stored = { id: 'tok-1', scopes: ['read'], revoked: false };
    mockWhereLimitGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => stored, ref: { update: mockDocUpdate } }],
    });

    const result = await verifyApiToken('sanc_readonly', 'write');

    expect(result).toEqual({
      valid: false,
      reason: 'insufficient_scope',
      tokenId: 'tok-1',
      scopes: ['read'],
    });
  });

  it('accepts a valid token and records last-used time', async () => {
    const stored = { id: 'tok-1', scopes: ['read', 'write'], revoked: false };
    mockDocUpdate.mockResolvedValueOnce(undefined);
    mockWhereLimitGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => stored, ref: { update: mockDocUpdate } }],
    });

    const result = await verifyApiToken('sanc_valid', 'read');

    expect(result).toEqual({ valid: true, tokenId: 'tok-1', scopes: ['read', 'write'] });
    expect(mockDocUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ lastUsedAt: expect.any(String) })
    );
  });
});
