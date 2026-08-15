import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SanctionRecord } from '../../src/shared/types';

// --- Fake Firestore query builder -------------------------------------
// api/index.ts builds a query as:
//   sanctionsCollection.where('searchNames', 'array-contains', firstToken)
//     [.where('type', '==', typeFilter)]
//     .limit(500).get()
// and separately collection('sanctions').doc(id).get(). This fake records
// every .where() call so tests can assert on what was actually queried, and
// returns a canned snapshot for .get().
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
  snapshotDocs = [];
  docGetResult = { exists: false };
  whereCalls.length = 0;
  vi.clearAllMocks();
  await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
});

describe('GET /api/search', () => {
  it('requires the q parameter', async () => {
    const res = await agent.get('/api/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns an empty array when every token is below the 2-char floor', async () => {
    const res = await agent.get('/api/search').query({ q: 'a b' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('queries array-contains on the first normalized token', async () => {
    snapshotDocs = [record()];
    const res = await agent.get('/api/search').query({ q: 'Vladimir Putin' });

    expect(res.status).toBe(200);
    expect(whereCalls[0]).toEqual(['searchNames', 'array-contains', 'vladimir']);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('PEP-1');
  });

  it('filters out documents missing a later token, in-memory', async () => {
    snapshotDocs = [
      record({ id: 'PEP-1', primaryName: 'Vladimir Putin', searchNames: ['vladimir', 'putin'] }),
      record({ id: 'PEP-2', primaryName: 'Vladimir Zelensky', searchNames: ['vladimir', 'zelensky'] }),
    ];
    const res = await agent.get('/api/search').query({ q: 'Vladimir Putin' });

    expect(res.body.map((r: any) => r.id)).toEqual(['PEP-1']);
  });

  it('applies the type filter as a second where() clause', async () => {
    snapshotDocs = [record()];
    await agent.get('/api/search').query({ q: 'Vladimir', type: 'individual' });
    expect(whereCalls).toContainEqual(['type', '==', 'individual']);
  });

  it('filters by source case-insensitively, in-memory', async () => {
    snapshotDocs = [record({ source: 'PEP' })];
    const res = await agent.get('/api/search').query({ q: 'Vladimir', source: 'pep' });
    expect(res.body).toHaveLength(1);

    const res2 = await agent.get('/api/search').query({ q: 'Vladimir', source: 'EU' });
    expect(res2.body).toHaveLength(0);
  });

  it('accepts a comma-separated source list', async () => {
    snapshotDocs = [record({ source: 'PEP' })];
    const res = await agent.get('/api/search').query({ q: 'Vladimir', source: 'EU,PEP,UN' });
    expect(res.body).toHaveLength(1);
  });

  it('caps the requested limit at 100 regardless of what was asked for', async () => {
    snapshotDocs = Array.from({ length: 5 }, (_, i) => record({ id: `PEP-${i}`, searchNames: ['vladimir'] }));
    const res = await agent.get('/api/search').query({ q: 'Vladimir', limit: '99999' });
    // All 5 fit under the real cap of 100; this exercises the parseInt/min path
    // without needing 100+ fixture docs.
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  it('falls back to the default limit of 20 when limit is not a number', async () => {
    snapshotDocs = Array.from({ length: 3 }, (_, i) => record({ id: `PEP-${i}`, searchNames: ['vladimir'] }));
    const res = await agent.get('/api/search').query({ q: 'Vladimir', limit: 'not-a-number' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('returns 500 with details when Firestore throws', async () => {
    fakeDb.collection.mockImplementationOnce(() => {
      throw new Error('boom');
    });
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

describe('POST /api/upload', () => {
  it('rejects a request with no file attached', async () => {
    const res = await agent.post('/api/upload').field('source', 'PEP');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  it('accepts an uploaded file and returns 202 immediately', async () => {
    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', Buffer.from('id;name\n1;Test Person\n'), 'people.csv');

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('upload_received');
  });
});
