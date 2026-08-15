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
});
