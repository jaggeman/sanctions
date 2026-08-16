import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Issue #43: POST /api/import used to fire-and-forget `runImport(...)` and
// respond 202 regardless of whether the import ever actually ran to
// completion. It now hands off to a durable Cloud Task
// (`enqueueImportTask`) instead, so a 202 means the work is actually queued,
// not just "we called an async function and didn't wait."
const enqueueImportTask = vi.fn(async () => {});
vi.mock('../../src/importer/taskQueue', () => ({ enqueueImportTask }));

const runImportMock = vi.fn();
vi.mock('../../src/importer', () => ({ runImport: runImportMock }));
vi.mock('../../src/importer/uploadPipeline', () => ({ processUpload: vi.fn() }));
// session.ts (issue #63) reads/writes db.collection('sessions').doc(id) — a
// tiny in-memory store behind the mock so verify-otp's set() is actually
// visible to the requireAuth check's later get(), instead of every doc
// looking permanently missing.
const sessionStore = new Map<string, any>();
vi.mock('../../src/shared/firebase', () => ({
  db: {
    collection: vi.fn(() => ({
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
    })),
  },
  getBucket: () => ({ file: vi.fn(() => ({ save: vi.fn() })) }),
}));
vi.mock('../../src/search', () => ({ runSearch: vi.fn() }));

// issue #153: drives the bearer-token auth path for the force-guard tests
// below. Only `verifyApiToken` is replaced; the rest of the module stays
// real so the tokens router keeps working.
const { mockVerifyApiToken } = vi.hoisted(() => ({ mockVerifyApiToken: vi.fn() }));
vi.mock('../../src/shared/apiTokens', async () => {
  const actual = await vi.importActual<typeof import('../../src/shared/apiTokens')>(
    '../../src/shared/apiTokens',
  );
  return { ...actual, verifyApiToken: mockVerifyApiToken };
});
vi.stubEnv('NODE_ENV', 'test');

const { api } = await import('../../src/api');
const agent = request.agent(api);

beforeEach(async () => {
  vi.clearAllMocks();
  await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
});

describe('POST /api/import', () => {
  it('rejects a non-array "sources" before ever touching the task queue', async () => {
    const res = await agent.post('/api/import').send({ sources: 'EU' });

    expect(res.status).toBe(400);
    expect(enqueueImportTask).not.toHaveBeenCalled();
  });

  it('enqueues a Cloud Task instead of running the import in-process, and responds 202', async () => {
    const res = await agent.post('/api/import').send({ sources: ['EU', 'UN'], csvPath: '/tmp/pep.csv' });

    expect(res.status).toBe(202);
    expect(enqueueImportTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: ['EU', 'UN'],
        csvPath: '/tmp/pep.csv',
        csvSource: 'PEP',
        csvSeparator: ';',
      })
    );
    // The old fire-and-forget in-process call must be gone entirely.
    expect(runImportMock).not.toHaveBeenCalled();
  });

  it('responds 500, not 202, when enqueueing itself fails — the 202 must not lie about a job that was never actually queued', async () => {
    enqueueImportTask.mockRejectedValueOnce(new Error('Cloud Tasks unavailable'));

    const res = await agent.post('/api/import').send({ sources: ['EU'] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  // issue #153 — see the matching block in api-upload.test.ts for the full
  // explanation. `admin@sanctions.com` is deliberately an admin address:
  // that is precisely what made the bypass reachable, since only an admin
  // can mint a token and the token carries its minter's address.
  describe('force:true is refused on the API-token path, even when the token owner is an admin (issue #153)', () => {
    const adminOwnedWriteToken = {
      valid: true,
      tokenId: 'tok_mcp_integration',
      scopes: ['write'],
      ownerEmail: 'admin@sanctions.com',
    };

    it('rejects force:true from a write-scoped token with 403 and never enqueues the task', async () => {
      mockVerifyApiToken.mockResolvedValue(adminOwnedWriteToken);

      const res = await request(api)
        .post('/api/import')
        .set('Authorization', 'Bearer tok_raw_value')
        .send({ sources: ['PEP'], force: true });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/admin/i);
      expect(enqueueImportTask).not.toHaveBeenCalled();
    });

    it('still allows a write-scoped token to enqueue an import when it is not asking to force', async () => {
      mockVerifyApiToken.mockResolvedValue(adminOwnedWriteToken);

      const res = await request(api)
        .post('/api/import')
        .set('Authorization', 'Bearer tok_raw_value')
        .send({ sources: ['EU'] });

      expect(res.status).toBe(202);
      expect(enqueueImportTask).toHaveBeenCalledWith(
        expect.objectContaining({ force: false }),
      );
    });
  });

  // The admin-session path must keep working — this is the behaviour #105
  // intended and the fix for #153 must not take it away.
  it('still allows force:true for a real admin session (issue #105 behaviour preserved)', async () => {
    const res = await agent.post('/api/import').send({ sources: ['PEP'], force: true });

    expect(res.status).toBe(202);
    expect(enqueueImportTask).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });
});
