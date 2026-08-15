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
const markImportApplied = vi.fn();
const markImportFailed = vi.fn();
class ImportAlreadyInFlightError extends Error {}
vi.mock('../../src/importer/importRecord', () => ({
  findAppliedImportBySha256,
  createPendingImport,
  markImportApplied,
  markImportFailed,
  ImportAlreadyInFlightError,
}));

const runImport = vi.fn();
vi.mock('../../src/importer', () => ({ runImport }));

const bucketFileSave = vi.fn(async () => {});
vi.mock('../../src/shared/firebase', () => ({
  getBucket: () => ({ file: vi.fn(() => ({ save: bucketFileSave })) }),
}));

const { processUpload } = await import('../../src/importer/uploadPipeline');

let tmpFile: string;

beforeEach(async () => {
  vi.clearAllMocks();
  hashFileStreaming.mockResolvedValue({ sha256: 'abc123', sizeBytes: 42 });
  detectFormat.mockReturnValue({ format: 'csv', fileGenerationDate: null });
  findAppliedImportBySha256.mockResolvedValue(null);
  createPendingImport.mockResolvedValue(undefined);
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
    expect(createPendingImport).toHaveBeenCalledWith(expect.objectContaining({
      sha256: 'abc123',
      filename: 'people.csv',
      storagePath: 'imports/abc123/people.csv',
      uploadedBy: 'user@example.com',
    }));
    expect(bucketFileSave).toHaveBeenCalled();
    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({
      uploadedFile: expect.objectContaining({ path: tmpFile, format: 'csv' }),
    }));
    expect(markImportApplied).toHaveBeenCalledWith('abc123', { parsed: 5, uploaded: 5 });
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

  it('marks the import failed when the Storage upload itself throws', async () => {
    bucketFileSave.mockRejectedValueOnce(new Error('storage quota exceeded'));

    const result = await processUpload(baseOptions());

    expect(result.outcome).toBe('failed');
    expect(markImportFailed).toHaveBeenCalledWith('abc123', 'storage quota exceeded');
  });
});
