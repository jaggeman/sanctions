import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #43: this is what the Cloud Tasks queue actually invokes. Testing
// the plain async function directly (not firebase-functions' onTaskDispatched
// wrapper) keeps this a pure-logic unit test per CLAUDE.md's layering rule.
const runImportMock = vi.fn();
vi.mock('../../src/importer/index', () => ({ runImport: runImportMock }));

// issue #111: the fetch-triggered audit record's outcome is only knowable
// from inside this task (POST /api/import returns 202 before the import
// itself has even run) — mocked here the same way runImport already is.
const markImportApplied = vi.fn(async () => {});
const markImportFailed = vi.fn(async () => {});
vi.mock('../../src/importer/importRecord', () => ({ markImportApplied, markImportFailed }));

const { handleImportTask } = await import('../../src/importer/importTask');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleImportTask', () => {
  it('calls runImport with the task payload and resolves on success', async () => {
    runImportMock.mockResolvedValue({ success: true, importedCounts: { EU: 3 } });

    await expect(handleImportTask({ sources: ['EU'], importId: 'import_abc' })).resolves.toBeUndefined();
    expect(runImportMock).toHaveBeenCalledWith({ sources: ['EU'], importId: 'import_abc' });
  });

  it('throws when runImport reports failure, so Cloud Tasks retries instead of silently dropping it', async () => {
    runImportMock.mockResolvedValue({ success: false, importedCounts: {}, error: 'No records parsed' });

    await expect(handleImportTask({ sources: ['EU'], importId: 'import_abc' })).rejects.toThrow('No records parsed');
  });

  it('lets an unexpected runImport rejection propagate (it never actually throws today, but the task handler must not swallow one if it did)', async () => {
    runImportMock.mockRejectedValue(new Error('unexpected boom'));

    await expect(handleImportTask({ sources: ['EU'], importId: 'import_abc' })).rejects.toThrow('unexpected boom');
  });

  // issue #111: this task is the only place a fetch-triggered import's real
  // outcome is ever known — the HTTP request already got its 202 and moved on.
  describe('audit record (issue #111)', () => {
    it('marks the audit record applied with counts on success', async () => {
      runImportMock.mockResolvedValue({ success: true, importedCounts: { EU: 3, UN: 2 } });

      await handleImportTask({ sources: ['EU', 'UN'], importId: 'import_abc' });

      expect(markImportApplied).toHaveBeenCalledWith('import_abc', { parsed: 5, uploaded: 5 });
      expect(markImportFailed).not.toHaveBeenCalled();
    });

    it('marks the audit record failed with the error when runImport reports failure', async () => {
      runImportMock.mockResolvedValue({ success: false, importedCounts: {}, error: 'No records parsed' });

      await expect(handleImportTask({ sources: ['EU'], importId: 'import_abc' })).rejects.toThrow();

      expect(markImportFailed).toHaveBeenCalledWith('import_abc', 'No records parsed');
      expect(markImportApplied).not.toHaveBeenCalled();
    });

    it('marks the audit record failed when runImport itself rejects unexpectedly', async () => {
      runImportMock.mockRejectedValue(new Error('unexpected boom'));

      await expect(handleImportTask({ sources: ['EU'], importId: 'import_abc' })).rejects.toThrow();

      expect(markImportFailed).toHaveBeenCalledWith('import_abc', 'unexpected boom');
    });

    it('does not touch the audit record at all when the task has no importId (e.g. a legacy/manual enqueue)', async () => {
      runImportMock.mockResolvedValue({ success: true, importedCounts: { EU: 1 } });

      await handleImportTask({ sources: ['EU'] });

      expect(markImportApplied).not.toHaveBeenCalled();
      expect(markImportFailed).not.toHaveBeenCalled();
    });
  });
});
