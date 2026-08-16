import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { ImportRecord, RecordVersion } from '../../src/shared/types';

// New read-only routes for issue #12: GET /api/imports, GET /api/imports/:id,
// GET /api/sanctions/:id/versions. Mocked at the module boundary (importRecord,
// uploader) rather than faking Firestore query chains — these functions already
// have their own dedicated, real-Firestore-shaped unit tests
// (tests/unit/importRecord.test.ts, tests/unit/uploader.test.ts).
const listImports = vi.fn();
const findImportBySha256 = vi.fn();
vi.mock('../../src/importer/importRecord', () => ({ listImports, findImportBySha256 }));

const listRecordVersions = vi.fn();
vi.mock('../../src/importer/uploader', async () => {
  const actual = await vi.importActual<typeof import('../../src/importer/uploader')>('../../src/importer/uploader');
  return { ...actual, listRecordVersions };
});

let docGetResult: { exists: boolean; data?: () => any } = { exists: false };

// session.ts (issue #63) reads/writes db.collection('sessions').doc(id) — a
// tiny in-memory store so verify-otp's set() is visible to requireAuth's
// later get(), same fix as tests/unit/api-import.test.ts.
const sessionStore = new Map<string, any>();

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name === 'sessions') {
      return {
        doc: vi.fn((id: string) => ({
          set: vi.fn(async (data: any) => {
            sessionStore.set(id, data);
          }),
          get: vi.fn(async () => ({
            exists: sessionStore.has(id),
            data: () => sessionStore.get(id),
          })),
          delete: vi.fn(async () => {
            sessionStore.delete(id);
          }),
        })),
      };
    }
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return { doc: vi.fn((id: string) => ({ get: vi.fn(async () => ({ ...docGetResult, id })) })) };
  }),
};
vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/importer/uploadPipeline', () => ({ processUpload: vi.fn() }));
vi.mock('../../src/search', () => ({ runSearch: vi.fn(async () => ({ results: [], totalMatches: 0, truncated: false })) }));
vi.stubEnv('NODE_ENV', 'test');

const { api } = await import('../../src/api');
const agent = request.agent(api);

function importRecord(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    importId: 'abc123',
    filename: 'eu_list.xml',
    sha256: 'abc123',
    sizeBytes: 2048,
    storagePath: 'imports/abc123/eu_list.xml',
    source: 'EU',
    format: 'eu-xml-1.1',
    fileGenerationDate: '2026-08-01',
    uploadedBy: 'analyst@example.com',
    uploadedAt: '2026-08-15T00:00:00.000Z',
    status: 'applied',
    counts: { parsed: 100, uploaded: 100 },
    ...overrides,
  };
}

function version(overrides: Partial<RecordVersion> = {}): RecordVersion {
  return {
    importId: 'abc123',
    changedAt: '2026-08-15T00:00:00.000Z',
    changeType: 'created',
    record: { id: 'EU-1', source: 'EU', type: 'individual', primaryName: 'Test Person', aliases: [], searchNames: [], createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' },
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  docGetResult = { exists: false };
  await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
});

describe('GET /api/imports', () => {
  it('requires authentication', async () => {
    const res = await request(api).get('/api/imports');
    expect(res.status).toBe(401);
  });

  it('lists imports, passing the limit through', async () => {
    listImports.mockResolvedValue([importRecord()]);
    const res = await agent.get('/api/imports').query({ limit: '10' });

    expect(res.status).toBe(200);
    expect(listImports).toHaveBeenCalledWith(10);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].importId).toBe('abc123');
  });

  it('defaults to 20 and caps at 100', async () => {
    listImports.mockResolvedValue([]);
    await agent.get('/api/imports');
    expect(listImports).toHaveBeenCalledWith(20);

    await agent.get('/api/imports').query({ limit: '9999' });
    expect(listImports).toHaveBeenCalledWith(100);
  });

  it('returns 500 with details when listImports throws', async () => {
    listImports.mockRejectedValue(new Error('boom'));
    const res = await agent.get('/api/imports');
    expect(res.status).toBe(500);
    expect(res.body.details).toBe('boom');
  });

  // issue #261: `|| 20` treated an explicit limit=0 the same as "not provided",
  // and let a negative limit reach Firestore's `.limit()` unvalidated (a 500).
  it('preserves an explicit limit=0 rather than defaulting to 20', async () => {
    listImports.mockResolvedValue([]);
    await agent.get('/api/imports').query({ limit: '0' });
    expect(listImports).toHaveBeenCalledWith(0);
  });

  it('falls back to the default 20 for a negative limit instead of passing it to Firestore', async () => {
    listImports.mockResolvedValue([]);
    const res = await agent.get('/api/imports').query({ limit: '-5' });
    expect(res.status).toBe(200);
    expect(listImports).toHaveBeenCalledWith(20);
  });
});

describe('GET /api/imports/:id', () => {
  it('requires authentication', async () => {
    const res = await request(api).get('/api/imports/abc123');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the import does not exist', async () => {
    findImportBySha256.mockResolvedValue(null);
    const res = await agent.get('/api/imports/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/does-not-exist/);
  });

  it('returns the import record when it exists', async () => {
    findImportBySha256.mockResolvedValue(importRecord());
    const res = await agent.get('/api/imports/abc123');
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('eu_list.xml');
    expect(res.body.counts).toEqual({ parsed: 100, uploaded: 100 });
  });

  it('rejects an id containing a path separator with 400, before ever querying Firestore', async () => {
    const res = await agent.get('/api/imports/' + encodeURIComponent('../other/doc'));
    expect(res.status).toBe(400);
    expect(findImportBySha256).not.toHaveBeenCalled();
  });
});

describe('GET /api/sanctions/:id/versions', () => {
  it('requires authentication', async () => {
    const res = await request(api).get('/api/sanctions/EU-1/versions');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the underlying sanction record does not exist', async () => {
    docGetResult = { exists: false };
    const res = await agent.get('/api/sanctions/EU-1/versions');
    expect(res.status).toBe(404);
    expect(listRecordVersions).not.toHaveBeenCalled();
  });

  it('returns the version trail when the record exists', async () => {
    docGetResult = { exists: true, data: () => ({ id: 'EU-1' }) };
    listRecordVersions.mockResolvedValue([version({ importId: 'import-2', changeType: 'updated' }), version({ importId: 'import-1' })]);

    const res = await agent.get('/api/sanctions/EU-1/versions');
    expect(res.status).toBe(200);
    expect(listRecordVersions).toHaveBeenCalledWith('EU-1');
    expect(res.body.map((v: any) => v.importId)).toEqual(['import-2', 'import-1']);
  });

  it('returns 500 with details when listRecordVersions throws', async () => {
    docGetResult = { exists: true, data: () => ({ id: 'EU-1' }) };
    listRecordVersions.mockRejectedValue(new Error('boom'));
    const res = await agent.get('/api/sanctions/EU-1/versions');
    expect(res.status).toBe(500);
    expect(res.body.details).toBe('boom');
  });

  it('rejects an id containing a path separator with 400, before ever touching Firestore', async () => {
    const res = await agent.get('/api/sanctions/' + encodeURIComponent('../other/doc') + '/versions');
    expect(res.status).toBe(400);
    expect(listRecordVersions).not.toHaveBeenCalled();
  });
});
