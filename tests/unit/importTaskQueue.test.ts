import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #43: POST /api/import must hand off to a Cloud Task instead of a
// fire-and-forget in-process call, so the platform durably retries until the
// import actually finishes rather than silently dropping it if the `api`
// instance freezes/recycles mid-run.
const enqueueMock = vi.fn(async () => {});
const taskQueueMock = vi.fn(() => ({ enqueue: enqueueMock }));
const getFunctionsMock = vi.fn(() => ({ taskQueue: taskQueueMock }));

vi.mock('firebase-admin/functions', () => ({ getFunctions: getFunctionsMock }));
vi.mock('../../src/shared/firebase', () => ({ db: {} }));

const { enqueueImportTask } = await import('../../src/importer/taskQueue');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueImportTask', () => {
  it('enqueues onto the runImportTask task queue with the given options', async () => {
    await enqueueImportTask({ sources: ['EU'], csvPath: undefined });

    expect(taskQueueMock).toHaveBeenCalledWith('runImportTask');
    expect(enqueueMock).toHaveBeenCalledWith({ sources: ['EU'], csvPath: undefined });
  });

  it('propagates an enqueue failure to the caller rather than swallowing it', async () => {
    enqueueMock.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(enqueueImportTask({ sources: ['EU'] })).rejects.toThrow('queue unavailable');
  });
});
