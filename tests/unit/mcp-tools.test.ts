import { describe, it, expect, vi, beforeEach } from 'vitest';

const runFetchTriggeredImport = vi.fn();
const processUpload = vi.fn();
const docGet = vi.fn();
const countGet = vi.fn();
const whereCountGet = vi.fn();

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      doc: vi.fn((id: string) => ({ get: () => docGet(id) })),
      count: vi.fn(() => ({ get: countGet })),
      where: vi.fn((field: string, _op: string, value: string) => ({
        count: vi.fn(() => ({ get: () => whereCountGet(field, value) })),
      })),
    };
  }),
};

vi.mock('../../src/search', () => ({ runSearch: vi.fn(), invalidateSearchIndex: vi.fn() }));
vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer/uploadPipeline', () => ({ processUpload, runFetchTriggeredImport }));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler() {}
    connect() { return Promise.resolve(); }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

const {
  handleGetSanctionDetails,
  handleRunDatabaseImport,
  handleReadStatistics,
} = await import('../../src/mcp/index');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleGetSanctionDetails — MCP get_sanction_details tool', () => {
  it('returns the record data as JSON when the id exists', async () => {
    const rec = { id: 'PEP-1', primaryName: 'Vladimir Putin', source: 'PEP' };
    docGet.mockResolvedValue({ exists: true, data: () => rec });

    const result = await handleGetSanctionDetails({ id: 'PEP-1' });

    expect(docGet).toHaveBeenCalledWith('PEP-1');
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(rec);
  });

  it('returns a sensible error when the id does not exist', async () => {
    docGet.mockResolvedValue({ exists: false });

    const result = await handleGetSanctionDetails({ id: 'DOES-NOT-EXIST' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DOES-NOT-EXIST');
  });
});

describe('handleRunDatabaseImport — MCP run_database_import tool', () => {
  it('with only sources: delegates to runFetchTriggeredImport and never calls processUpload', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: { EU: 5 } });

    await handleRunDatabaseImport({ sources: ['EU'] });

    expect(runFetchTriggeredImport).toHaveBeenCalledWith({ sources: ['EU'], uploadedBy: null });
    expect(processUpload).not.toHaveBeenCalled();
  });

  it('surfaces success with the imported counts to the caller', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: { EU: 5, UN: 3 } });

    const result = await handleRunDatabaseImport({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('5');
    expect(result.content[0].text).toContain('3');
  });

  it('surfaces failure with the error message and marks it as an error', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: false, error: 'download failed' });

    const result = await handleRunDatabaseImport({ sources: ['US'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('download failed');
  });

  // issue #192: a script/AI-driven call to run_database_import with only
  // csvPath (no sources) previously still triggered a full, undedup'd,
  // unaudited EU/UN/US/UK/CH download+import as a side effect of runImport's
  // own default-to-all-sources fallback. csvPath is a genuine local file, so
  // it now routes through processUpload() — sha256 dedup, in-flight lock,
  // durable audit record — instead, and no longer drags in an unrelated
  // full refresh the caller never asked for.
  describe('csvPath routes through processUpload (issue #192)', () => {
    it('with only csvPath (no sources): calls processUpload and never calls runImport', async () => {
      processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 5, uploaded: 5 } });

      await handleRunDatabaseImport({ csvPath: '/tmp/pep.csv' });

      expect(processUpload).toHaveBeenCalledWith({
        filePath: '/tmp/pep.csv',
        originalFilename: 'pep.csv',
        sourceHint: 'PEP',
        uploadedBy: null,
        importOptions: {},
      });
      expect(runFetchTriggeredImport).not.toHaveBeenCalled();
    });

    it('with both sources and csvPath: calls both runFetchTriggeredImport and processUpload', async () => {
      runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: { EU: 5 } });
      processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 2, uploaded: 2 } });

      await handleRunDatabaseImport({ sources: ['EU'], csvPath: '/tmp/pep.csv' });

      expect(runFetchTriggeredImport).toHaveBeenCalledWith({ sources: ['EU'], uploadedBy: null });
      expect(processUpload).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/tmp/pep.csv' }));
    });

    it('reports the csv import outcome to the caller on success', async () => {
      processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 5, uploaded: 5 } });

      const result = await handleRunDatabaseImport({ csvPath: '/tmp/pep.csv' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('imp_1');
    });

    it('marks the result as an error when the csv upload fails', async () => {
      processUpload.mockResolvedValue({ outcome: 'failed', importId: 'imp_1', error: 'boom' });

      const result = await handleRunDatabaseImport({ csvPath: '/tmp/pep.csv' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('boom');
    });

    it('does not mark it as an error for a rejected (duplicate) csv upload', async () => {
      processUpload.mockResolvedValue({ outcome: 'rejected', importId: 'imp_2', duplicateOfImportId: 'imp_1' });

      const result = await handleRunDatabaseImport({ csvPath: '/tmp/pep.csv' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('imp_1');
    });
  });
});

describe('handleReadStatistics — MCP sanctions://statistics resource', () => {
  it('returns the expected breakdown shape against a mocked data source', async () => {
    countGet.mockResolvedValue({ data: () => ({ count: 100 }) });
    whereCountGet.mockImplementation((_field: string, value: string) => {
      const counts: Record<string, number> = { EU: 40, UN: 20, US: 30, PEP: 10 };
      return Promise.resolve({ data: () => ({ count: counts[value] ?? 0 }) });
    });

    const result = await handleReadStatistics();

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.totalRecords).toBe(100);
    expect(parsed.breakdown).toEqual({ EU: 40, UN: 20, US_OFAC: 30, PEP: 10 });
    expect(result.contents[0].uri).toBe('sanctions://statistics');
  });
});
