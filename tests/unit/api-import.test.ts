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

// issue #111: POST /api/import creates its own durable audit doc (fetch
// imports have no file to hash-dedup on, unlike uploads) before enqueueing
// the Cloud Task — mocked here the same way enqueueImportTask/runImport are,
// rather than exercising the real Firestore-shaped importRecord internals.
const createFetchImportRecord = vi.fn(async () => {});
const markImportFailed = vi.fn(async () => {});
vi.mock('../../src/importer/importRecord', () => ({
  createFetchImportRecord,
  markImportFailed,
  listImports: vi.fn(),
  findImportBySha256: vi.fn(),
}));
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

  // issue #111: this endpoint had no durable audit trail at all — no record
  // of who triggered a fetch import, what was requested, or the outcome.
  describe('audit record (issue #111)', () => {
    it('creates a durable pending audit record, attributed to the caller, before enqueueing', async () => {
      await agent.post('/api/import').send({ sources: ['EU', 'UN'], mode: 'sync' });

      expect(createFetchImportRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          uploadedBy: 'admin@sanctions.com',
          sources: ['EU', 'UN'],
          mode: 'sync',
          force: false,
        }),
      );
      // The audit record must exist before the task is handed off, not after.
      const auditCallOrder = createFetchImportRecord.mock.invocationCallOrder[0];
      const enqueueCallOrder = enqueueImportTask.mock.invocationCallOrder[0];
      expect(auditCallOrder).toBeLessThan(enqueueCallOrder);
    });

    it('threads the same importId used for the audit record through to the enqueued task', async () => {
      await agent.post('/api/import').send({ sources: ['EU'] });

      const auditImportId = createFetchImportRecord.mock.calls[0][0].importId;
      expect(auditImportId).toMatch(/^import_/);
      expect(enqueueImportTask).toHaveBeenCalledWith(
        expect.objectContaining({ importId: auditImportId }),
      );
    });

    it('reuses a valid client-supplied importId instead of generating a new one', async () => {
      await agent.post('/api/import').send({ sources: ['EU'], importId: 'import_client_abc123' });

      expect(createFetchImportRecord).toHaveBeenCalledWith(
        expect.objectContaining({ importId: 'import_client_abc123' }),
      );
    });

    it('marks the audit record failed (not left dangling pending) when enqueueing itself fails', async () => {
      enqueueImportTask.mockRejectedValueOnce(new Error('Cloud Tasks unavailable'));

      await agent.post('/api/import').send({ sources: ['EU'] });

      const auditImportId = createFetchImportRecord.mock.calls[0][0].importId;
      expect(markImportFailed).toHaveBeenCalledWith(auditImportId, 'Cloud Tasks unavailable');
    });

    it('does not create an audit record for a dry run — it must leave no trace, same as an upload dry run', async () => {
      runImportMock.mockResolvedValue({ success: true, importedCounts: { EU: 2 }, diffs: [] });

      await agent.post('/api/import').send({ sources: ['EU'], dryRun: true });

      expect(createFetchImportRecord).not.toHaveBeenCalled();
    });
  });
});
