import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SanctionRecord } from '../../src/shared/types';

// Deliberately a separate fake/mock setup from tests/unit/api-search.test.ts
// (kept as its own file rather than editing that one, which several other
// in-flight branches already touch — see .agents/active/soft-delete-versioning.md).
let snapshotDocs: SanctionRecord[] = [];
let docGetResult: { exists: boolean; data?: () => any } = { exists: false };
const whereCalls: Array<[string, string, any]> = [];
// Issue #43: src/search's getRecords() checks this shared version marker
// before trusting its cache — undefined mirrors the doc not existing yet.
let metaVersion: number | undefined = undefined;

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
    // Issue #35: both src/search/getRecords() (whole-collection get()) and
    // GET /api/sanctions/:id (per-id doc().get()) now also touch `overrides`.
    // Empty/not-found here since this file isn't testing override merging.
    if (name === 'overrides') {
      return {
        get: vi.fn(async () => ({ docs: [] })),
        doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: false })) })),
      };
    }
    if (name === 'meta') {
      return {
        doc: vi.fn((id: string) => {
          if (id !== 'searchIndex') throw new Error(`unexpected meta doc ${id}`);
          return {
            get: vi.fn(async () => ({
              exists: metaVersion !== undefined,
              data: () => (metaVersion !== undefined ? { version: metaVersion } : undefined),
            })),
            set: vi.fn(async () => {
              metaVersion = (metaVersion || 0) + 1;
            }),
          };
        }),
      };
    }
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      ...makeQuery(),
      // src/search/getRecords() reads the whole collection in one go.
      get: vi.fn(async () => ({
        docs: snapshotDocs.map((record) => ({ data: () => record })),
      })),
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => ({ ...docGetResult, id })),
      })),
    };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer/taskQueue', () => ({ enqueueImportTask: vi.fn(async () => {}) }));
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
// Same for the search module: a static import would be hoisted above the
// vi.mock factory and read fakeDb before it exists.
const { api } = await import('../../src/api');
const { invalidateSearchIndex } = await import('../../src/search');

// All routes below require an authenticated session (see src/auth/middleware.ts);
// log in once via the hardcoded dev test account and reuse the session cookie,
// same pattern as tests/unit/api-search.test.ts.
const agent = request.agent(api);

beforeEach(async () => {
  snapshotDocs = [];
  docGetResult = { exists: false };
  whereCalls.length = 0;
  // runSearch caches the whole collection in memory; drop it so each test's
  // snapshotDocs are actually read.
  await invalidateSearchIndex();
  vi.clearAllMocks();
  await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
});

// Rewritten when this branch merged with main: #23 replaced the hand-rolled
// Firestore query these tests asserted on (`whereCalls`) with the in-memory
// matcher in src/search. The status filter now lives in runSearch's candidate
// filter, so a delisted record never enters the matcher at all — these test
// that behaviour end-to-end through the real search module rather than
// asserting on a `.where()` call that no longer exists.
describe('GET /api/search — status filtering (issue #9)', () => {
  it('excludes a delisted record by default', async () => {
    snapshotDocs = [record({ id: 'PEP-DEL', status: 'delisted' } as any)];
    const res = await agent.get('/api/search').query({ q: 'Vladimir' });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it('returns a delisted record when includeDelisted=true', async () => {
    snapshotDocs = [record({ id: 'PEP-DEL', status: 'delisted' } as any)];
    const res = await agent.get('/api/search').query({ q: 'Vladimir', includeDelisted: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].status).toBe('delisted');
  });

  it('still hides delisted records for any other includeDelisted value', async () => {
    snapshotDocs = [record({ id: 'PEP-DEL', status: 'delisted' } as any)];
    const res = await agent.get('/api/search').query({ q: 'Vladimir', includeDelisted: 'nope' });

    expect(res.body.results).toHaveLength(0);
  });

  it('still returns active records, so the filter is not simply hiding everything', async () => {
    snapshotDocs = [record({ id: 'PEP-ACTIVE', status: 'active' } as any)];
    const res = await agent.get('/api/search').query({ q: 'Vladimir' });

    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].id).toBe('PEP-ACTIVE');
  });

  it('treats a record with no status field as active, not as delisted', async () => {
    // Records written before the status field existed must not silently vanish
    // from search the moment this ships.
    const legacy = record({ id: 'PEP-LEGACY' });
    delete (legacy as any).status;
    snapshotDocs = [legacy];

    const res = await agent.get('/api/search').query({ q: 'Vladimir' });
    expect(res.body.results).toHaveLength(1);
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
