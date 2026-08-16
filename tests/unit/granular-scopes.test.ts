import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock dependencies
const mockVerifyApiToken = vi.fn();
vi.mock('../../src/shared/apiTokens', async () => {
  const actual = await vi.importActual<typeof import('../../src/shared/apiTokens')>('../../src/shared/apiTokens');
  return {
    ...actual,
    verifyApiToken: mockVerifyApiToken,
  };
});

vi.mock('../../src/shared/firebase', () => ({
  db: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn().mockResolvedValue({ exists: false }),
        set: vi.fn().mockResolvedValue(undefined),
      })),
      where: vi.fn(() => ({
        limit: vi.fn(() => ({
          get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
        })),
      })),
    })),
  },
}));

vi.mock('../../src/auth/mailer', () => ({ sendOtpEmail: vi.fn(async () => {}) }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));

const { api } = await import('../../src/api');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Granular Scope Enforcement on API Routes (Issue #221)', () => {
  describe('GET /api/search (requires sanctions:read)', () => {
    it('allows request with valid sanctions:read scope', async () => {
      mockVerifyApiToken.mockResolvedValueOnce({
        valid: true,
        tokenId: 'tok-search',
        scopes: ['sanctions:read'],
      });

      const res = await request(api)
        .get('/api/search?q=test')
        .set('Authorization', 'Bearer sanc_search');

      expect(mockVerifyApiToken).toHaveBeenCalledWith('sanc_search', 'sanctions:read');
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('denies (403) request when token lacks sanctions:read scope', async () => {
      mockVerifyApiToken.mockResolvedValueOnce({
        valid: false,
        reason: 'insufficient_scope',
        tokenId: 'tok-custom',
        scopes: ['custom:read'],
      });

      const res = await request(api)
        .get('/api/search?q=test')
        .set('Authorization', 'Bearer sanc_custom_only');

      expect(mockVerifyApiToken).toHaveBeenCalledWith('sanc_custom_only', 'sanctions:read');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/does not have the required scope/i);
    });
  });

  describe('POST /api/custom-records (requires custom:write)', () => {
    it('enforces custom:write scope', async () => {
      mockVerifyApiToken.mockResolvedValueOnce({
        valid: false,
        reason: 'insufficient_scope',
        tokenId: 'tok-search',
        scopes: ['sanctions:read'],
      });

      const res = await request(api)
        .post('/api/custom-records')
        .set('Authorization', 'Bearer sanc_search')
        .send({ name: 'Test Entity' });

      expect(mockVerifyApiToken).toHaveBeenCalledWith('sanc_search', 'custom:write');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/overrides (requires overrides:read)', () => {
    it('enforces overrides:read scope', async () => {
      mockVerifyApiToken.mockResolvedValueOnce({
        valid: false,
        reason: 'insufficient_scope',
        tokenId: 'tok-search',
        scopes: ['sanctions:read'],
      });

      const res = await request(api)
        .get('/api/overrides')
        .set('Authorization', 'Bearer sanc_search');

      expect(mockVerifyApiToken).toHaveBeenCalledWith('sanc_search', 'overrides:read');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/decisions (requires decisions:read)', () => {
    it('enforces decisions:read scope', async () => {
      mockVerifyApiToken.mockResolvedValueOnce({
        valid: false,
        reason: 'insufficient_scope',
        tokenId: 'tok-search',
        scopes: ['sanctions:read'],
      });

      const res = await request(api)
        .get('/api/decisions')
        .set('Authorization', 'Bearer sanc_search');

      expect(mockVerifyApiToken).toHaveBeenCalledWith('sanc_search', 'decisions:read');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/imports (requires imports:read)', () => {
    it('enforces imports:read scope', async () => {
      mockVerifyApiToken.mockResolvedValueOnce({
        valid: false,
        reason: 'insufficient_scope',
        tokenId: 'tok-search',
        scopes: ['sanctions:read'],
      });

      const res = await request(api)
        .get('/api/imports')
        .set('Authorization', 'Bearer sanc_search');

      expect(mockVerifyApiToken).toHaveBeenCalledWith('sanc_search', 'imports:read');
      expect(res.status).toBe(403);
    });
  });
});
