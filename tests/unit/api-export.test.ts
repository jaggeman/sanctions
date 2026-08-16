import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SanctionRecord } from '../../src/shared/types';
import { createFakeDb } from './helpers/fakeFirestore';

let allRecords: SanctionRecord[] = [];
const { db: authFakeDb } = createFakeDb();

const defaultCollectionImpl = (name: string) => {
  if (name === 'sessions' || name === 'otpCodes') {
    return authFakeDb.collection(name);
  }
  if (name === 'sanctions') {
    return {
      get: vi.fn(async () => ({
        docs: allRecords.map((r) => ({ id: r.id, data: () => r })),
      })),
    };
  }
  return authFakeDb.collection(name);
};

const fakeDb = {
  collection: vi.fn(defaultCollectionImpl),
};

const verifyApiToken = vi.fn();

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/shared/apiTokens', () => ({ verifyApiToken }));
vi.stubEnv('NODE_ENV', 'test');

const { app } = await import('../../src/api');

describe('GET /api/export', () => {
  const record1: SanctionRecord = {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    names: [{ wholeName: 'Vladimir Putin', strong: true }],
    searchNames: [],
    status: 'active',
    firstSeenImport: 'imp-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const record2: SanctionRecord = {
    id: 'US-2',
    source: 'US',
    type: 'entity',
    names: [{ wholeName: 'Gazprom Bank', strong: true }],
    searchNames: [],
    status: 'delisted',
    firstSeenImport: 'imp-2',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  let agent: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    allRecords = [record1, record2];
    verifyApiToken.mockReset();
    vi.clearAllMocks();
    fakeDb.collection.mockImplementation(defaultCollectionImpl);
    agent = request.agent(app);
    await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const unauthed = request(app);
    const res = await unauthed.get('/api/export');
    expect(res.status).toBe(401);
  });

  it('exports active records as CSV for authenticated session', async () => {
    const res = await agent.get('/api/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename=');
    expect(res.text).toContain('EU-1');
    expect(res.text).toContain('Vladimir Putin');
    // Delisted record excluded by default
    expect(res.text).not.toContain('US-2');
  });

  it('allows read-scoped API token bearer authorization', async () => {
    verifyApiToken.mockResolvedValue({
      valid: true,
      tokenId: 'tok-123',
      ownerEmail: 'user@sanctions.com',
    });

    const res = await request(app)
      .get('/api/export')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.text).toContain('EU-1');
  });

  it('filters by source and status=all', async () => {
    const res = await agent.get('/api/export?source=US&status=all');

    expect(res.status).toBe(200);
    expect(res.text).toContain('US-2');
    expect(res.text).toContain('Gazprom Bank');
    expect(res.text).not.toContain('EU-1');
  });

  it('filters by importId and formats filename safely', async () => {
    const res = await agent.get('/api/export?importId=imp-1&status=all');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="sanctions-import-imp-1-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.text).toContain('EU-1');
    expect(res.text).not.toContain('US-2');
  });

  describe('importId validation & Content-Disposition header safety (issue #299)', () => {
    it('rejects invalid importId with path separators with 400', async () => {
      const res = await agent.get('/api/export?importId=../bad/id');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects importId with header injection characters with 400', async () => {
      const res = await agent.get('/api/export?importId=foo;filename*=UTF-8\'\'evil.csv');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects importId with quotes or whitespace with 400', async () => {
      const res = await agent.get('/api/export?importId="malicious"');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  it('issue #260: returns 500 instead of crashing when Firestore read fails', async () => {
    // Session-cookie auth also calls db.collection('sessions') on this same
    // request, so only the 'sanctions' branch should fail here.
    fakeDb.collection.mockImplementation((name: string) => {
      if (name === 'sanctions') {
        return {
          get: vi.fn(async () => {
            throw new Error('Firestore unavailable');
          }),
        };
      }
      return authFakeDb.collection(name);
    });

    const res = await agent.get('/api/export?status=all');

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('issue #260: skips a malformed record missing source/type instead of throwing (corrupt/manually-edited document)', async () => {
    const malformed = { id: 'BAD-1', names: [{ wholeName: 'No Source Or Type', strong: true }], status: 'active' } as unknown as SanctionRecord;
    allRecords = [record1, malformed];

    const res = await agent.get('/api/export?status=all');

    expect(res.status).toBe(200);
    expect(res.text).toContain('EU-1');
    expect(res.text).not.toContain('No Source Or Type');
  });
});
