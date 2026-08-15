import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SanctionRecord } from '../../src/shared/types';

/**
 * issue #7: runImport's signature is reshaped to also accept a specific,
 * already-on-disk file of a KNOWN format (e.g. a user upload whose format was
 * already sniffed by src/importer/formatDetection.ts) — dispatching to the
 * right existing parser, instead of the old all-or-nothing "download from
 * SOURCE_URLS, or parse a CSV path" model. Existing sources/csvPath behaviour
 * (tests/unit/importer.test.ts, run-import-custom-guard.test.ts) must be
 * completely unaffected — this is purely additive.
 */

vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async () => { throw new Error('should not download when uploadedFile is set'); }),
  SOURCE_URLS: { EU: 'x', UN: 'y', US: 'z' },
}));
vi.mock('../../src/importer/parsers/eu', () => ({ parseEUListStreaming: vi.fn() }));
vi.mock('../../src/importer/parsers/un', () => ({ parseUNList: vi.fn() }));
vi.mock('../../src/importer/parsers/us', () => ({ parseUSList: vi.fn() }));
vi.mock('../../src/importer/parsers/csv', () => ({ parseCSVList: vi.fn() }));
vi.mock('../../src/importer/uploader', () => ({
  uploadRecords: vi.fn(async () => {}),
  filterAutomatedBatch: vi.fn((records: SanctionRecord[]) => records.filter((r) => r.source !== 'CUSTOM')),
}));
vi.mock('../../src/search', () => ({ invalidateSearchIndex: vi.fn() }));

import { runImport } from '../../src/importer/index';
import { parseEUListStreaming } from '../../src/importer/parsers/eu';
import { parseUNList } from '../../src/importer/parsers/un';
import { parseUSList } from '../../src/importer/parsers/us';
import { parseCSVList } from '../../src/importer/parsers/csv';
import { uploadRecords } from '../../src/importer/uploader';
import { invalidateSearchIndex } from '../../src/search';

function record(id: string, source: SanctionRecord['source'] = 'EU'): SanctionRecord {
  return {
    id, source, type: 'individual', primaryName: id, aliases: [], searchNames: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runImport({ uploadedFile }) — dispatches by detected format', () => {
  it('parses an eu-xml-1.1 file via the streaming EU parser, never downloading', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(record('EU-20'));
      return 1;
    });

    const result = await runImport({ uploadedFile: { path: '/tmp/upload.xml', format: 'eu-xml-1.1', source: 'EU' } });

    expect(result.success).toBe(true);
    expect(result.importedCounts.EU).toBe(1);
    expect(vi.mocked(uploadRecords)).toHaveBeenCalledWith([record('EU-20')]);
    expect(invalidateSearchIndex).toHaveBeenCalled();
  });

  it('parses a un-xml file via parseUNList', async () => {
    vi.mocked(parseUNList).mockResolvedValue([record('UN-1', 'UN')]);
    const result = await runImport({ uploadedFile: { path: '/tmp/upload.xml', format: 'un-xml', source: 'UN' } });

    expect(result.success).toBe(true);
    expect(result.importedCounts.UN).toBe(1);
    expect(vi.mocked(uploadRecords)).toHaveBeenCalledWith([record('UN-1', 'UN')]);
  });

  it('parses a us-xml file via parseUSList', async () => {
    vi.mocked(parseUSList).mockResolvedValue([record('US-SDN-1', 'US')]);
    const result = await runImport({ uploadedFile: { path: '/tmp/upload.xml', format: 'us-xml', source: 'US' } });

    expect(result.success).toBe(true);
    expect(result.importedCounts.US).toBe(1);
  });

  it('parses a generic csv file via parseCSVList, tagged with the given source', async () => {
    vi.mocked(parseCSVList).mockResolvedValue([record('PEP-1', 'PEP')]);
    const result = await runImport({ uploadedFile: { path: '/tmp/upload.csv', format: 'csv', source: 'PEP' } });

    expect(result.success).toBe(true);
    expect(result.importedCounts.PEP).toBe(1);
    expect(vi.mocked(parseCSVList)).toHaveBeenCalledWith('/tmp/upload.csv', expect.objectContaining({ defaultSource: 'PEP' }));
  });

  it('still drops CUSTOM-sourced records via filterAutomatedBatch', async () => {
    vi.mocked(parseCSVList).mockResolvedValue([record('CUSTOM-1', 'CUSTOM'), record('PEP-1', 'PEP')]);
    await runImport({ uploadedFile: { path: '/tmp/upload.csv', format: 'csv', source: 'PEP' } });

    const uploadedIds = vi.mocked(uploadRecords).mock.calls.flatMap(([chunk]) => chunk.map((r) => r.id));
    expect(uploadedIds).toEqual(['PEP-1']);
  });

  it('reports failure when nothing was parsed', async () => {
    vi.mocked(parseCSVList).mockResolvedValue([]);
    const result = await runImport({ uploadedFile: { path: '/tmp/upload.csv', format: 'csv', source: 'PEP' } });

    expect(result.success).toBe(false);
    expect(vi.mocked(uploadRecords)).not.toHaveBeenCalled();
  });

  it('reports the underlying parse error rather than throwing', async () => {
    vi.mocked(parseCSVList).mockRejectedValue(new Error('malformed csv'));
    const result = await runImport({ uploadedFile: { path: '/tmp/upload.csv', format: 'csv', source: 'PEP' } });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/malformed csv/);
  });

  it('never calls downloadFile for any uploadedFile format', async () => {
    vi.mocked(parseCSVList).mockResolvedValue([record('PEP-1', 'PEP')]);
    await runImport({ uploadedFile: { path: '/tmp/upload.csv', format: 'csv', source: 'PEP' } });
    const { downloadFile } = await import('../../src/importer/fetcher');
    expect(downloadFile).not.toHaveBeenCalled();
  });
});
