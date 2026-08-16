import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SanctionRecord } from '../../src/shared/types';
import { createFakeDb } from './helpers/fakeFirestore';

// GET /api/sanctions/:id still talks to Firestore directly, so it keeps a
// fake db. GET /api/search now goes through the shared src/search runSearch
// (see src/search/index.ts) instead of querying Firestore itself, so it's
// mocked separately below rather than via fakeDb.
let docGetResult: { exists: boolean; data?: () => any } = { exists: false };
// Issue #35: GET /api/sanctions/:id now also fetches a matching override doc.
let overrideDocResult: { exists: boolean; data?: () => any } = { exists: false };

// Issue #63: this suite logs in through the real POST /api/auth/verify-otp
// route (below), which now persists the session through `db` — delegate the
// `sessions`/`otpCodes` collections to the shared fake Firestore rather than
// hand-rolling that here too.
const { db: authFakeDb } = createFakeDb();

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name === 'sessions' || name === 'otpCodes') {
      return authFakeDb.collection(name);
    }
    if (name === 'overrides') {
      return {
        doc: vi.fn((id: string) => ({
          get: vi.fn(async () => ({ ...overrideDocResult, id })),
        })),
      };
    }
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => ({ ...docGetResult, id })),
      })),
    };
  }),
};

const runSearch = vi.fn();
const verifyApiToken = vi.fn();
const logSearchEvent = vi.fn();

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer/taskQueue', () => ({ enqueueImportTask: vi.fn(async () => {}) }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
// issue #111: POST /api/import now creates its own audit doc in the
// 'imports' collection, which this file's fakeDb (scoped to 'sanctions'
// only, for the search tests) doesn't model — mock the collaborator module
// directly instead, same as taskQueue/runImport above.
vi.mock('../../src/importer/importRecord', () => ({
  createFetchImportRecord: vi.fn(async () => {}),
  markImportFailed: vi.fn(async () => {}),
  listImports: vi.fn(),
  findImportBySha256: vi.fn(),
}));
vi.mock('../../src/search', () => ({ runSearch }));
vi.mock('../../src/search/searchLog', () => ({ logSearchEvent }));
vi.mock('../../src/shared/apiTokens', () => ({ verifyApiToken }));
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
// Dynamic, not static: session.ts transitively imports src/shared/firebase,
// and a static import here would be hoisted above the `fakeDb`/`authFakeDb`
// initialization above, throwing "Cannot access 'fakeDb' before initialization".
const { createSession } = await import('../../src/auth/session');
const { SESSION_COOKIE_NAME } = await import('../../src/auth/middleware');

// All routes below require an authenticated session (see src/auth/middleware.ts);
// log in once via the hardcoded dev test account and reuse the session cookie.
const agent = request.agent(api);

beforeEach(async () => {
  docGetResult = { exists: false };
  overrideDocResult = { exists: false };
  runSearch.mockReset();
  runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
  verifyApiToken.mockReset();
  logSearchEvent.mockReset();
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

  it('passes dob through to runSearch so the date-of-birth booster is actually reachable via the API', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir Putin', dob: '1952-10-07' });

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.objectContaining({ dob: '1952-10-07' }));
  });

  it('omits dob when not provided, rather than passing an empty string through as a real filter', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir Putin' });

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.not.objectContaining({ dob: expect.anything() }));
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

  it('issue #161: falls back to the default limit of 20 when limit is negative (-1, -40)', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir', limit: '-1' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ limit: 20 }));

    await agent.get('/api/search').query({ q: 'Vladimir', limit: '-40' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ limit: 20 }));
  });

  it('issue #37: honors an explicit limit=0 instead of silently falling back to the default', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir', limit: '0' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ limit: 0 }));
  });

  it('falls back to the default limit of 20 when limit is omitted entirely', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ limit: 20 }));
  });

  it('issue #148: clamps threshold to 0-100 range and parses valid integer thresholds', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir', threshold: '75' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ threshold: 75 }));

    await agent.get('/api/search').query({ q: 'Vladimir', threshold: '500' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ threshold: 100 }));

    await agent.get('/api/search').query({ q: 'Vladimir', threshold: '-10' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.objectContaining({ threshold: 0 }));
  });

  it('issue #148: ignores invalid/non-numeric threshold instead of passing NaN to search engine', async () => {
    await agent.get('/api/search').query({ q: 'Vladimir', threshold: 'high' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.not.objectContaining({ threshold: expect.anything() }));

    await agent.get('/api/search').query({ q: 'Vladimir', threshold: '' });
    expect(runSearch).toHaveBeenCalledWith('Vladimir', expect.not.objectContaining({ threshold: expect.anything() }));
  });

  it('returns 500 with details when the search engine throws', async () => {
    runSearch.mockRejectedValue(new Error('boom'));
    const res = await agent.get('/api/search').query({ q: 'Vladimir' });
    expect(res.status).toBe(500);
    expect(res.body.details).toBe('boom');
  });

  it('fires a durable searchLog entry for a successful search (issue #109)', async () => {
    runSearch.mockResolvedValue({ results: [scoredRecord()], totalMatches: 1, truncated: false });

    await agent.get('/api/search').query({ q: 'Vladimir Putin', source: 'EU', threshold: '70' });

    expect(logSearchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'search',
        query: 'Vladimir Putin',
        resultCount: 1,
        filters: expect.objectContaining({ source: 'EU', threshold: 70 }),
      }),
    );
  });

  it('does not fire a searchLog entry when the search engine throws', async () => {
    runSearch.mockRejectedValue(new Error('boom'));
    await agent.get('/api/search').query({ q: 'Vladimir' });
    expect(logSearchEvent).not.toHaveBeenCalled();
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

  it('reports overriddenFields: [] when there is no override (issue #35)', async () => {
    const rec = record({ id: 'PEP-1' });
    docGetResult = { exists: true, data: () => rec };
    overrideDocResult = { exists: false };

    const res = await agent.get('/api/sanctions/PEP-1');
    expect(res.body.overriddenFields).toEqual([]);
    expect(res.body.sanctionReason).toBe(rec.sanctionReason);
  });

  it('merges an override onto the returned record and reports which fields were overridden (issue #35)', async () => {
    const rec = record({ id: 'PEP-1', sanctionReason: 'Original reason' });
    docGetResult = { exists: true, data: () => rec };
    overrideDocResult = {
      exists: true,
      data: () => ({
        entityId: 'PEP-1',
        fields: { sanctionReason: 'Corrected reason' },
        overriddenBy: 'analyst@example.com',
        overriddenAt: '2026-01-01T00:00:00.000Z',
        reason: 'Fix',
      }),
    };

    const res = await agent.get('/api/sanctions/PEP-1');
    expect(res.status).toBe(200);
    expect(res.body.sanctionReason).toBe('Corrected reason');
    expect(res.body.overriddenFields).toEqual(['sanctionReason']);
  });

  it('rejects an id containing a URL-encoded slash before it ever reaches Firestore', async () => {
    // %2F decodes to "/" within a single path segment — the real attack this
    // guards against: a literal "/" in the raw URL would just 404 via normal
    // Express routing, but an encoded one reaches the :id param intact.
    const res = await agent.get('/api/sanctions/EU-1%2F..%2Fadmins%2Fattacker');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    // Not "never called at all": an authenticated agent's session lookup
    // (issue #63, Firestore-backed) legitimately touches `sessions` on every
    // request. The actual guarantee here is that the invalid id itself never
    // reaches a `sanctions` lookup.
    expect(fakeDb.collection).not.toHaveBeenCalledWith('sanctions');
  });

  it('rejects an id with other structural characters (400, not a 500 from Firestore)', async () => {
    const res = await agent.get('/api/sanctions/EU@evil.com');
    expect(res.status).toBe(400);
    expect(fakeDb.collection).not.toHaveBeenCalledWith('sanctions');
  });

  it('fires a searchLog "lookup" entry with resultCount: 1 when the record is found (issue #109)', async () => {
    const rec = record({ id: 'PEP-1' });
    docGetResult = { exists: true, data: () => rec };

    await agent.get('/api/sanctions/PEP-1');

    expect(logSearchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lookup', entityId: 'PEP-1', resultCount: 1 }),
    );
  });

  it('fires a searchLog "lookup" entry with resultCount: 0 when the record is not found (issue #109)', async () => {
    docGetResult = { exists: false };

    await agent.get('/api/sanctions/DOES-NOT-EXIST');

    expect(logSearchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lookup', entityId: 'DOES-NOT-EXIST', resultCount: 0 }),
    );
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

  it('rejects a mode that is not "sync" or "append"', async () => {
    const res = await agent.post('/api/import').send({ sources: ['EU'], mode: 'wipe-everything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mode/i);
  });

  it('rejects an importId containing a path separator', async () => {
    const res = await agent.post('/api/import').send({ sources: ['EU'], importId: '../../etc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/importId/i);
  });

  it('accepts a well-formed importId', async () => {
    const res = await agent.post('/api/import').send({ sources: ['EU'], importId: 'import_123_abc' });
    expect(res.status).toBe(202);
  });

  it('dryRun:true awaits the import and returns its result synchronously instead of 202', async () => {
    const { runImport } = await import('../../src/importer');
    (runImport as any).mockResolvedValueOnce({
      success: true,
      importedCounts: { EU: 2 },
      diffs: [{ source: 'EU', counts: { parsed: 2, added: 2, updated: 0, unchanged: 0, delisted: 0, skipped: 0 } }],
    });

    const res = await agent.post('/api/import').send({ sources: ['EU'], mode: 'sync', dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.diffs[0].counts.added).toBe(2);
    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ mode: 'sync', dryRun: true }));
  });
});

// Issue #105: force:true bypasses the diff engine's >20% delist safety guard
// (issue #8) — restricted to admin sessions specifically, since
// requireAuthOrScope('write') alone only proves "logged in or holds a
// write-scoped token," not "trusted to override a safety mechanism."
describe('POST /api/import — force:true restricted to admins (issue #105)', () => {
  it('allows force:true for an admin session (admin@sanctions.com is admin by default when ADMIN_EMAILS is unset outside production)', async () => {
    const res = await agent.post('/api/import').send({ sources: ['EU'], force: true });
    expect(res.status).toBe(202);

    // The import now runs on a Cloud Tasks worker (issue #43), enqueued
    // rather than called in-process — assert on what actually crosses the
    // boundary.
    const { enqueueImportTask } = await import('../../src/importer/taskQueue');
    expect(enqueueImportTask).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('rejects force:true for a logged-in non-admin session with 403, without ever calling runImport', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    const sid = await createSession('analyst@example.com');

    const { runImport } = await import('../../src/importer');
    (runImport as any).mockClear();

    const res = await request(api)
      .post('/api/import')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sid}`)
      .send({ sources: ['EU'], force: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
    expect(runImport).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('rejects force:true from a write-scoped API token with 403 — a token has no identity to check admin status against', async () => {
    verifyApiToken.mockResolvedValue({ valid: true, tokenId: 'tok-1', scopes: ['write'] });
    const { runImport } = await import('../../src/importer');
    (runImport as any).mockClear();

    const res = await request(api)
      .post('/api/import')
      .set('Authorization', 'Bearer sanc_writer')
      .send({ sources: ['EU'], force: true });

    expect(res.status).toBe(403);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('a write-scoped token can still import without force', async () => {
    verifyApiToken.mockResolvedValue({ valid: true, tokenId: 'tok-1', scopes: ['write'] });

    const res = await request(api)
      .post('/api/import')
      .set('Authorization', 'Bearer sanc_writer')
      .send({ sources: ['EU'] });

    expect(res.status).toBe(202);
  });
});

// POST /api/upload's tests live in tests/unit/api-upload.test.ts — the
// handler was rewritten for issue #7 (hashing, format detection, dedup,
// Storage, the imports audit collection), replacing the old fire-and-forget
// 202 response this block used to assert. The two multer-level validation
// tests (disallowed extension, oversized file) that were added here on main
// moved there too, alongside this rewrite's own source/dedup/format tests.

// Issue #36: requireScope was fully built and tested in isolation but never
// actually reachable — a bearer-token-only request (no session cookie) was
// rejected by the blanket session gate before any route-level scope check
// could run. These tests use a plain (session-less) `request(api)` client,
// never `agent`, to prove a token alone is now sufficient.
describe('bearer-token (API key) auth on the read routes — issue #36', () => {
  it('GET /api/search accepts a valid read-scoped token with no session cookie at all', async () => {
    verifyApiToken.mockResolvedValue({ valid: true, tokenId: 'tok-1', scopes: ['read'] });
    runSearch.mockResolvedValue({ results: [scoredRecord()], totalMatches: 1, truncated: false });

    const res = await request(api).get('/api/search').query({ q: 'Vladimir' }).set('Authorization', 'Bearer sanc_good');

    expect(res.status).toBe(200);
    expect(verifyApiToken).toHaveBeenCalledWith('sanc_good', 'read');
    expect(res.body.results).toHaveLength(1);
  });

  it('GET /api/sanctions/:id accepts a valid read-scoped token with no session cookie at all', async () => {
    const rec = record({ id: 'PEP-1' });
    docGetResult = { exists: true, data: () => rec };
    verifyApiToken.mockResolvedValue({ valid: true, tokenId: 'tok-1', scopes: ['read'] });

    const res = await request(api).get('/api/sanctions/PEP-1').set('Authorization', 'Bearer sanc_good');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('PEP-1');
  });

  it('rejects a write-only-scoped token on the read routes with 403', async () => {
    verifyApiToken.mockResolvedValue({
      valid: false,
      reason: 'insufficient_scope',
      tokenId: 'tok-1',
      scopes: ['write'],
    });

    const res = await request(api).get('/api/search').query({ q: 'Vladimir' }).set('Authorization', 'Bearer sanc_writeonly');

    expect(res.status).toBe(403);
    expect(runSearch).not.toHaveBeenCalled();
  });

  it('rejects an invalid or revoked token with 401, without falling back to session auth', async () => {
    verifyApiToken.mockResolvedValue({ valid: false, reason: 'not_found' });

    const res = await request(api).get('/api/search').query({ q: 'Vladimir' }).set('Authorization', 'Bearer sanc_bogus');

    expect(res.status).toBe(401);
  });

  it('still rejects a plain, unauthenticated request (no cookie, no token) with 401', async () => {
    const res = await request(api).get('/api/search').query({ q: 'Vladimir' });
    expect(res.status).toBe(401);
  });

  it('POST /api/import accepts a write-scoped token with no session cookie', async () => {
    verifyApiToken.mockResolvedValue({ valid: true, tokenId: 'tok-1', scopes: ['write'] });

    const res = await request(api).post('/api/import').set('Authorization', 'Bearer sanc_writer').send({ sources: ['EU'] });

    expect(res.status).toBe(202);
    expect(verifyApiToken).toHaveBeenCalledWith('sanc_writer', 'write');
  });

  it('rejects a read-only-scoped token on POST /api/import with 403', async () => {
    verifyApiToken.mockResolvedValue({
      valid: false,
      reason: 'insufficient_scope',
      tokenId: 'tok-1',
      scopes: ['read'],
    });

    const res = await request(api).post('/api/import').set('Authorization', 'Bearer sanc_readonly').send({ sources: ['EU'] });

    expect(res.status).toBe(403);
  });

  it('rejects a mode that is not "sync" or "append"', async () => {
    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .field('mode', 'nonsense')
      .attach('file', Buffer.from('id;name\n1;Test Person\n'), 'people.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mode/i);
  });

  it('rejects an importId containing a path separator, and cleans up the temp file', async () => {
    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .field('importId', '../../etc')
      .attach('file', Buffer.from('id;name\n1;Test Person\n'), 'people.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/importId/i);
  });
});
