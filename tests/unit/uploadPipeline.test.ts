import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

const hashFileStreaming = vi.fn();
vi.mock('../../src/importer/hashFile', () => ({ hashFileStreaming }));

const detectFormat = vi.fn();
vi.mock('../../src/importer/formatDetection', () => ({ detectFormat }));

const findAppliedImportBySha256 = vi.fn();
const createPendingImport = vi.fn();
const createFetchImportRecord = vi.fn();
const markImportApplied = vi.fn();
const markImportFailed = vi.fn();
class ImportAlreadyInFlightError extends Error {}
vi.mock('../../src/importer/importRecord', () => ({
  findAppliedImportBySha256,
  createPendingImport,
  createFetchImportRecord,
  markImportApplied,
  markImportFailed,
  ImportAlreadyInFlightError,
}));

const generateImportId = vi.fn();
vi.mock('../../src/importer/uploader', () => ({ generateImportId }));

const runImport = vi.fn();
vi.mock('../../src/importer', () => ({ runImport }));

const bucketFileSave = vi.fn(async () => {});
vi.mock('../../src/shared/firebase', () => ({
  getBucket: () => ({ file: vi.fn(() => ({ save: bucketFileSave })) }),
}));

const { processUpload, runFetchTriggeredImport } = await import('../../src/importer/uploadPipeline');

let tmpFile: string;

beforeEach(async () => {
  vi.clearAllMocks();
  hashFileStreaming.mockResolvedValue({ sha256: 'abc123', sizeBytes: 42 });
  detectFormat.mockReturnValue({ format: 'csv', fileGenerationDate: null });
  findAppliedImportBySha256.mockResolvedValue(null);
  createPendingImport.mockResolvedValue(undefined);
  createFetchImportRecord.mockResolvedValue(undefined);
  generateImportId.mockReturnValue('import_fetch_1');
  runImport.mockResolvedValue({ success: true, importedCounts: { PEP: 5 } });

  tmpFile = path.join(os.tmpdir(), `upload-pipeline-test-${Date.now()}.csv`);
  await fs.writeFile(tmpFile, 'id;name\n1;Test Person\n');
});

function baseOptions(overrides: Partial<Parameters<typeof processUpload>[0]> = {}) {
  return {
    filePath: tmpFile,
    originalFilename: 'people.csv',
    sourceHint: 'PEP' as const,
    uploadedBy: 'user@example.com',
    ...overrides,
  };
}

describe('processUpload — happy path', () => {
  it('hashes, detects format, creates a pending import, uploads to storage, runs the import, marks applied', async () => {
    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('applied');
    expect(hashFileStreaming).toHaveBeenCalledWith(tmpFile);
    expect(createPendingImport).toHaveBeenCalledWith(
      expect.objectContaining({
        sha256: 'abc123',
        source: 'PEP',
        format: 'csv',
        filename: 'people.csv',
      }),
    );
    expect(bucketFileSave).toHaveBeenCalled();
    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedFile: expect.objectContaining({ path: tmpFile, format: 'csv', source: 'PEP' }),
      }),
    );
    expect(markImportApplied).toHaveBeenCalledWith(result.importId, { parsed: 5, uploaded: 5 });
  });

  it('maps uk-xml format to source UK and runs streamed UK import', async () => {
    detectFormat.mockReturnValue({ format: 'uk-xml', fileGenerationDate: '14/08/2026' });
    runImport.mockResolvedValue({ success: true, importedCounts: { UK: 6334 } });

    const result = await processUpload(baseOptions({ originalFilename: 'uk.xml' }));

    expect(result.outcome).toBe('applied');
    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedFile: expect.objectContaining({
          format: 'uk-xml',
          source: 'UK',
        }),
      }),
    );
  });

  it('maps ch-xml format to source CH and runs streamed CH import', async () => {
    detectFormat.mockReturnValue({ format: 'ch-xml', fileGenerationDate: '2026-08-15' });
    runImport.mockResolvedValue({ success: true, importedCounts: { CH: 8664 } });

    const result = await processUpload(baseOptions({ originalFilename: 'ch.xml' }));

    expect(result.outcome).toBe('applied');
    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedFile: expect.objectContaining({
          format: 'ch-xml',
          source: 'CH',
        }),
      }),
    );
  });

  it('infers the source from the detected format for EU/UN/US, ignoring the source hint', async () => {
    detectFormat.mockReturnValue({ format: 'eu-xml-1.1', fileGenerationDate: '2026-08-05T00:00:00Z' });
    runImport.mockResolvedValue({ success: true, importedCounts: { EU: 3 } });

    await processUpload(baseOptions({ sourceHint: 'PEP' }));

    expect(createPendingImport).toHaveBeenCalledWith(expect.objectContaining({ source: 'EU' }));
    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({
      uploadedFile: expect.objectContaining({ source: 'EU' }),
    }));
  });
});

describe('processUpload — storage key never trusts the client-supplied filename (issue #94)', () => {
  it('drops path separators and ".." from a malicious filename entirely', async () => {
    await processUpload(baseOptions({ originalFilename: '../../other-import/evil.csv' }));

    expect(createPendingImport).toHaveBeenCalledWith(expect.objectContaining({
      // Original name still preserved for display/audit purposes...
      filename: '../../other-import/evil.csv',
      // ...but the storage key is derived, never the raw client string.
      storagePath: 'imports/abc123/upload.csv',
    }));
  });

  it('drops an unrecognized/oversized/control-character extension rather than smuggling it into the key', async () => {
    await processUpload(baseOptions({ originalFilename: 'evil\x00\x0a.php\x00.csv' }));

    const call = createPendingImport.mock.calls[0][0];
    expect(call.storagePath).toMatch(/^imports\/abc123\/upload(\.[a-z0-9]{1,10})?$/);
  });

  it('preserves a normal, safe extension case-insensitively', async () => {
    await processUpload(baseOptions({ originalFilename: 'People.XML' }));

    expect(createPendingImport).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: 'imports/abc123/upload.xml',
    }));
  });

  it('produces no extension at all when the filename has none', async () => {
    await processUpload(baseOptions({ originalFilename: 'noextension' }));

    expect(createPendingImport).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: 'imports/abc123/upload',
    }));
  });
});

describe('processUpload — dedup', () => {
  it('rejects a duplicate of an already-applied import without parsing or touching Storage', async () => {
    findAppliedImportBySha256.mockResolvedValue({ importId: 'earlier-import', filename: 'old.csv', status: 'applied' });

    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.duplicateOfImportId).toBe('earlier-import');
    }
    expect(createPendingImport).not.toHaveBeenCalled();
    expect(bucketFileSave).not.toHaveBeenCalled();
    expect(runImport).not.toHaveBeenCalled();
  });

  it('reports in_flight rather than crashing when two uploads race on the same content', async () => {
    createPendingImport.mockRejectedValue(new ImportAlreadyInFlightError('racing'));

    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('in_flight');
    expect(bucketFileSave).not.toHaveBeenCalled();
    expect(runImport).not.toHaveBeenCalled();
  });
});

describe('processUpload — unsupported EU CSV formats', () => {
  it.each(['eu-csv-1.0', 'eu-csv-1.1'] as const)('marks %s failed with a clear message instead of silently mis-parsing', async (format) => {
    detectFormat.mockReturnValue({ format, fileGenerationDate: '05/08/2026' });

    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('unsupported_format');
    expect(markImportFailed).toHaveBeenCalledWith('abc123', expect.stringMatching(/not yet implemented/i));
    expect(bucketFileSave).not.toHaveBeenCalled();
    expect(runImport).not.toHaveBeenCalled();
  });
});

describe('processUpload — failure handling', () => {
  it('marks the import failed (not left dangling pending) when runImport reports failure', async () => {
    runImport.mockResolvedValue({ success: false, importedCounts: {}, error: 'no records parsed' });

    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('failed');
    expect(markImportFailed).toHaveBeenCalledWith('abc123', 'no records parsed');
  });

  it('proceeds with import even if raw Storage archive upload throws', async () => {
    bucketFileSave.mockRejectedValueOnce(new Error('storage quota exceeded'));

    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('applied');
    expect(runImport).toHaveBeenCalled();
  });

  // issue #60: a bookkeeping failure AFTER a real success must never get
  // mislabeled as a failed import — the sanction records were already
  // written by runImport by this point.
  it('does not mark a genuinely successful import as failed when only the bookkeeping markImportApplied call throws', async () => {
    markImportApplied.mockRejectedValueOnce(new Error('Firestore write blip'));

    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('applied');
    expect(markImportFailed).not.toHaveBeenCalled();
  });
});

// issue #256 (followup to #192): the official-sources fetch path has no
// local file to sha256-dedup on before the download runs, so it reuses
// POST /api/import's own solution to that exact problem (issue #111) — a
// durable `imports` audit doc keyed by a fresh importId, created before the
// fetch runs and marked applied/failed once it resolves — instead of
// inventing a new mechanism. Synchronous rather than that route's
// fire-and-forget Cloud Task, since a CLI/MCP caller already IS a
// long-running process that wants the real result back directly.
describe('runFetchTriggeredImport — durable audit trail for official-source imports (issue #256)', () => {
  it('creates a fetch-triggered audit record before running the import, and marks it applied on success', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: { EU: 12 } });

    const result = await runFetchTriggeredImport({ sources: ['EU'], mode: 'append', uploadedBy: 'cli' });

    expect(createFetchImportRecord).toHaveBeenCalledWith(expect.objectContaining({
      importId: 'import_fetch_1',
      sources: ['EU'],
      mode: 'append',
      uploadedBy: 'cli',
    }));
    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({
      sources: ['EU'],
      mode: 'append',
      importId: 'import_fetch_1',
    }));
    expect(markImportApplied).toHaveBeenCalledWith('import_fetch_1', { parsed: 12, uploaded: 12 });
    expect(result).toEqual({ success: true, importedCounts: { EU: 12 } });
  });

  it('marks the audit record failed when runImport reports failure, without throwing', async () => {
    runImport.mockResolvedValue({ success: false, importedCounts: {}, error: 'download failed' });

    const result = await runFetchTriggeredImport({ sources: ['UN'], uploadedBy: null });

    expect(markImportFailed).toHaveBeenCalledWith('import_fetch_1', 'download failed');
    expect(result.success).toBe(false);
  });

  it('marks the audit record failed and rethrows when runImport itself throws', async () => {
    runImport.mockRejectedValue(new Error('network down'));

    await expect(runFetchTriggeredImport({ sources: ['US'], uploadedBy: null })).rejects.toThrow('network down');

    expect(markImportFailed).toHaveBeenCalledWith('import_fetch_1', 'network down');
  });

  it('does not mark a genuinely successful import as failed when only the bookkeeping markImportApplied call throws', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: { EU: 3 } });
    markImportApplied.mockRejectedValueOnce(new Error('Firestore write blip'));

    const result = await runFetchTriggeredImport({ sources: ['EU'], uploadedBy: null });

    expect(result.success).toBe(true);
    expect(markImportFailed).not.toHaveBeenCalled();
  });

  it('dry-run leaves no trace: creates no audit record, calls runImport with dryRun: true', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: { EU: 3 }, diffs: [] });

    await runFetchTriggeredImport({ sources: ['EU'], dryRun: true, uploadedBy: 'cli' });

    expect(createFetchImportRecord).not.toHaveBeenCalled();
    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ sources: ['EU'], dryRun: true }));
    expect(markImportApplied).not.toHaveBeenCalled();
  });
});
