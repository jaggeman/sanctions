import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SanctionRecord } from '../../src/shared/types';
import { createFakeDb } from './helpers/fakeFirestore';

let allRecords: SanctionRecord[] = [];
const { db: authFakeDb } = createFakeDb();

const fakeDb = {
  collection: vi.fn((name: string) => {
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
  }),
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

  it('filters by importId', async () => {
    const res = await agent.get('/api/export?importId=imp-1&status=all');

    expect(res.status).toBe(200);
    expect(res.text).toContain('EU-1');
    expect(res.text).not.toContain('US-2');
  });
});
