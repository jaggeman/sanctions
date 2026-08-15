import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SanctionRecord } from '../../src/shared/types';

// GET /api/sanctions/:id still talks to Firestore directly, so it keeps a
// fake db. GET /api/search now goes through the shared src/search runSearch
// (see src/search/index.ts) instead of querying Firestore itself, so it's
// mocked separately below rather than via fakeDb.
let docGetResult: { exists: boolean; data?: () => any } = { exists: false };

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => ({ ...docGetResult, id })),
      })),
    };
  }),
};

const runSearch = vi.fn();

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/search', () => ({ runSearch }));
vi.stubEnv('NODE_ENV', 'test');

function record(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'PEP-1',
    source: 'PEP',
    type: 'individual',
    primaryName: 'Vladimir Putin',
    aliases: [],
    searchNames: ['vladimir', 'putin'],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// api under test — imported after the mocks above so it picks up the fakes.
const { api } = await import('../../src/api');

// All routes below require an authenticated session (see src/auth/middleware.ts);
// log in once via the hardcoded dev test account and reuse the session cookie.
const agent = request.agent(api);

beforeEach(async () => {
  docGetResult = { exists: false };
  runSearch.mockReset();
  runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
  vi.clearAllMocks();
  await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
});

function scoredRecord(overrides: Partial<SanctionRecord & { score: number; matchedAlias: string }> = {}) {
  return { ...record(overrides), score: 92, matchedAlias: 'Vladimir Putin', ...overrides };
}

describe('GET /api/search', () => {
  it('requires the q parameter', async () => {
    const res = await agent.get('/api/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(runSearch).not.toHaveBeenCalled();
  });

  it('delegates to the shared runSearch with the query and parsed options', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir Putin', source: 'PEP,EU', type: 'individual', limit: '5', threshold: '70' });

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', {
      source: 'PEP,EU',
      type: 'individual',
      limit: 5,
      threshold: 70,
      includeDelisted: false,
    });
  });

  it('returns each hit with its score and matched alias', async () => {
    runSearch.mockResolvedValue({ results: [scoredRecord()], totalMatches: 1, truncated: false });
    const res = await agent.get('/api/search').query({ q: 'Vladmir Putin' });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].score).toBe(92);
    expect(res.body.results[0].matchedAlias).toBe('Vladimir Putin');
  });

  it('reports totalMatches and truncated instead of silently capping', async () => {
    runSearch.mockResolvedValue({
      results: [scoredRecord({ id: 'PEP-1' })],
      totalMatches: 42,
      truncated: true,
    });
    const res = await agent.get('/api/search').query({ q: 'Vladimir' });

    expect(res.body.totalMatches).toBe(42);
    expect(res.body.truncated).toBe(true);
  });

  it('caps the requested limit at 100 regardless of what was asked for', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir', limit: '99999' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ limit: 100 }));
  });

  it('falls back to the default limit of 20 when limit is not a number', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir', limit: 'not-a-number' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ limit: 20 }));
  });

  it('returns 500 with details when the search engine throws', async () => {
    runSearch.mockRejectedValue(new Error('boom'));
    const res = await agent.get('/api/search').query({ q: 'Vladimir' });
    expect(res.status).toBe(500);
    expect(res.body.details).toBe('boom');
  });
});

describe('GET /api/sanctions/:id', () => {
  it('returns 404 when the document does not exist', async () => {
    docGetResult = { exists: false };
    const res = await agent.get('/api/sanctions/DOES-NOT-EXIST');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/DOES-NOT-EXIST/);
  });

  it('returns the record data when it exists', async () => {
    const rec = record({ id: 'PEP-1' });
    docGetResult = { exists: true, data: () => rec };
    const res = await agent.get('/api/sanctions/PEP-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('PEP-1');
  });
});

describe('POST /api/import', () => {
  it('rejects a non-array sources field', async () => {
    const res = await agent.post('/api/import').send({ sources: 'EU' });
    expect(res.status).toBe(400);
  });

  it('accepts the request immediately with 202, without waiting for the import to finish', async () => {
    const res = await agent.post('/api/import').send({ sources: ['EU'] });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('import_started');
  });
});

// POST /api/upload's tests live in tests/unit/api-upload.test.ts — the
// handler was rewritten for issue #7 (hashing, format detection, dedup,
// Storage, the imports audit collection), replacing the old fire-and-forget
// 202 response this block used to assert. The two multer-level validation
// tests (disallowed extension, oversized file) that were added here on main
// moved there too, alongside this rewrite's own source/dedup/format tests.
