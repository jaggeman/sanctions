import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SanctionRecord } from '../../src/shared/types';

// Deliberately a separate fake/mock setup from tests/unit/api-search.test.ts
// (kept as its own file rather than editing that one, which several other
// in-flight branches already touch — see .agents/active/soft-delete-versioning.md).
let snapshotDocs: SanctionRecord[] = [];
let docGetResult: { exists: boolean; data?: () => any } = { exists: false };
const whereCalls: Array<[string, string, any]> = [];

function makeQuery() {
  return {
    where: vi.fn((field: string, op: string, value: any) => {
      whereCalls.push([field, op, value]);
      return makeQuery();
    }),
    limit: vi.fn(() => ({
      get: vi.fn(async () => ({
        forEach: (cb: (doc: any) => void) => {
          snapshotDocs.forEach((record) => cb({ data: () => record }));
        },
      })),
    })),
  };
}

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      ...makeQuery(),
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => ({ ...docGetResult, id })),
      })),
    };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.stubEnv('NODE_ENV', 'test');

function record(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'PEP-1',
    source: 'PEP',
    type: 'individual',
    primaryName: 'Vladimir Putin',
    aliases: [],
    searchNames: ['vladimir', 'putin'],
    status: 'active',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  } as SanctionRecord;
}

// api under test — imported after the mocks above so it picks up the fakes.
const { api } = await import('../../src/api');

// All routes below require an authenticated session (see src/auth/middleware.ts);
// log in once via the hardcoded dev test account and reuse the session cookie,
// same pattern as tests/unit/api-search.test.ts.
const agent = request.agent(api);

beforeEach(async () => {
  snapshotDocs = [];
  docGetResult = { exists: false };
  whereCalls.length = 0;
  vi.clearAllMocks();
  await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
});

describe('GET /api/search — status filtering (issue #9)', () => {
  it('filters to status=="active" by default', async () => {
    snapshotDocs = [record()];
    await agent.get('/api/search').query({ q: 'Vladimir' });
    expect(whereCalls).toContainEqual(['status', '==', 'active']);
  });

  it('does not add the status filter when includeDelisted=true', async () => {
    snapshotDocs = [record({ status: 'delisted' } as any)];
    const res = await agent.get('/api/search').query({ q: 'Vladimir', includeDelisted: 'true' });
    expect(whereCalls).not.toContainEqual(['status', '==', 'active']);
    expect(res.body).toHaveLength(1);
  });

  it('still applies the status filter for any other includeDelisted value', async () => {
    snapshotDocs = [record()];
    await agent.get('/api/search').query({ q: 'Vladimir', includeDelisted: 'nope' });
    expect(whereCalls).toContainEqual(['status', '==', 'active']);
  });
});

describe('GET /api/sanctions/:id — delisted records (issue #9)', () => {
  it('returns a delisted record with its status and delistedAt, not a 404', async () => {
    const rec = record({ status: 'delisted', delistedAt: '2025-06-01T00:00:00.000Z' } as any);
    docGetResult = { exists: true, data: () => rec };

    const res = await agent.get('/api/sanctions/PEP-1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('delisted');
    expect(res.body.delistedAt).toBe('2025-06-01T00:00:00.000Z');
  });
});
