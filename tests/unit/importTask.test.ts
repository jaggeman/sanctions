import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #43: this is what the Cloud Tasks queue actually invokes. Testing
// the plain async function directly (not firebase-functions' onTaskDispatched
// wrapper) keeps this a pure-logic unit test per CLAUDE.md's layering rule.
const runImportMock = vi.fn();
vi.mock('../../src/importer/index', () => ({ runImport: runImportMock }));

const { handleImportTask } = await import('../../src/importer/importTask');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleImportTask', () => {
  it('calls runImport with the task payload and resolves on success', async () => {
    runImportMock.mockResolvedValue({ success: true, importedCounts: { EU: 3 } });

    await expect(handleImportTask({ sources: ['EU'] })).resolves.toBeUndefined();
    expect(runImportMock).toHaveBeenCalledWith({ sources: ['EU'] });
  });

  it('throws when runImport reports failure, so Cloud Tasks retries instead of silently dropping it', async () => {
    runImportMock.mockResolvedValue({ success: false, importedCounts: {}, error: 'No records parsed' });

    await expect(handleImportTask({ sources: ['EU'] })).rejects.toThrow('No records parsed');
  });

  it('lets an unexpected runImport rejection propagate (it never actually throws today, but the task handler must not swallow one if it did)', async () => {
    runImportMock.mockRejectedValue(new Error('unexpected boom'));

    await expect(handleImportTask({ sources: ['EU'] })).rejects.toThrow('unexpected boom');
  });
});
