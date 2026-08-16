import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runFetchTriggeredImport = vi.fn();
const processUpload = vi.fn();
const docGet = vi.fn();
const countGet = vi.fn();
const whereCountGet = vi.fn();
const verifyApiToken = vi.fn();

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
// issue #262: run_database_import now requires a write-scoped MCP_API_TOKEN,
// verified the same way requireScope's own tests verify it — only
// verifyApiToken is mocked; validateCsvPath (from '../../src/importer/csvPath')
// is left real and exercised directly, since it's a pure function with no
// external dependencies and the whole point of these tests is proving the
// real path-traversal guard actually runs before processUpload is reached.
vi.mock('../../src/shared/apiTokens', () => ({ verifyApiToken }));
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MCP_API_TOKEN;
  delete process.env.ALLOWED_CSV_DIR;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
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

  // issue #263: a "/" in the id addresses a nested subcollection document
  // via .doc(id) instead of erroring — the same hazard REST's
  // validateEntityIdParam guards against, but this tool never called it.
  it('rejects an id containing "/" before it ever reaches Firestore', async () => {
    const result = await handleGetSanctionDetails({ id: 'EU-1234/history/secretDoc' });

    expect(result.isError).toBe(true);
    expect(docGet).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/invalid id/i);
  });

  // issue #263: a Firestore-reserved id (e.g. "__proto__") throws a raw
  // driver error whose message leaks the real project id/doc path back to
  // the caller when unguarded.
  it('rejects a Firestore-reserved-pattern id without ever calling Firestore', async () => {
    const result = await handleGetSanctionDetails({ id: '__proto__' });

    expect(result.isError).toBe(true);
    expect(docGet).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/invalid id/i);
  });
});

describe('handleRunDatabaseImport — MCP run_database_import tool', () => {
  // issue #262: run_database_import is the only privileged-write MCP tool
  // with zero authorization — create_override/record_decision both require a
  // write-scoped MCP_API_TOKEN via callSanctionsApi's real HTTP round-trip;
  // this one called runFetchTriggeredImport/processUpload directly with
  // nothing checked at all. Every test below now needs a valid token unless
  // it's specifically testing the rejection path.
  const VALID_TOKEN_RESULT = { valid: true, tokenId: 'tok-1', scopes: ['imports:write'], ownerEmail: 'svc@corp.test' };

  describe('authorization (issue #262)', () => {
    it('rejects the call when MCP_API_TOKEN is unset, before touching the filesystem or database', async () => {
      const result = await handleRunDatabaseImport({ sources: ['EU'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/MCP_API_TOKEN/);
      expect(verifyApiToken).not.toHaveBeenCalled();
      expect(runFetchTriggeredImport).not.toHaveBeenCalled();
      expect(processUpload).not.toHaveBeenCalled();
    });

    it('rejects the call when MCP_API_TOKEN is set but invalid (not found)', async () => {
      process.env.MCP_API_TOKEN = 'sanc_bogus';
      verifyApiToken.mockResolvedValue({ valid: false, reason: 'not_found' });

      const result = await handleRunDatabaseImport({ sources: ['EU'] });

      expect(result.isError).toBe(true);
      expect(verifyApiToken).toHaveBeenCalledWith('sanc_bogus', 'imports:write');
      expect(runFetchTriggeredImport).not.toHaveBeenCalled();
    });

    it('rejects the call when the token lacks imports:write scope', async () => {
      process.env.MCP_API_TOKEN = 'sanc_readonly';
      verifyApiToken.mockResolvedValue({ valid: false, reason: 'insufficient_scope', tokenId: 'tok-2', scopes: ['imports:read'] });

      const result = await handleRunDatabaseImport({ sources: ['EU'] });

      expect(result.isError).toBe(true);
      expect(runFetchTriggeredImport).not.toHaveBeenCalled();
    });

    it('rejects the call when the token is revoked', async () => {
      process.env.MCP_API_TOKEN = 'sanc_revoked';
      verifyApiToken.mockResolvedValue({ valid: false, reason: 'revoked' });

      const result = await handleRunDatabaseImport({ sources: ['EU'] });

      expect(result.isError).toBe(true);
      expect(runFetchTriggeredImport).not.toHaveBeenCalled();
    });

    it('also gates a bare csvPath call with no sources — the vulnerability is not limited to the sources path', async () => {
      const result = await handleRunDatabaseImport({ csvPath: 'pep.csv' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/MCP_API_TOKEN/);
      expect(processUpload).not.toHaveBeenCalled();
    });
  });

  describe('with a valid write-scoped token', () => {
    beforeEach(() => {
      process.env.MCP_API_TOKEN = 'sanc_validtoken';
      verifyApiToken.mockResolvedValue(VALID_TOKEN_RESULT);
    });

    it('with only sources: delegates to runFetchTriggeredImport and never calls processUpload', async () => {
      runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: { EU: 5 } });

      await handleRunDatabaseImport({ sources: ['EU'] });

      expect(verifyApiToken).toHaveBeenCalledWith('sanc_validtoken', 'imports:write');
      expect(runFetchTriggeredImport).toHaveBeenCalledWith({ sources: ['EU'], uploadedBy: 'svc@corp.test' });
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
      it('with only csvPath (no sources): calls processUpload with the validated path and never calls runFetchTriggeredImport', async () => {
        processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 5, uploaded: 5 } });

        await handleRunDatabaseImport({ csvPath: 'pep.csv' });

        // 'pep.csv' is relative, so it resolves under the default allowed
        // directory (./data) — validateCsvPath's real logic, not a stub.
        expect(processUpload).toHaveBeenCalledWith({
          filePath: expect.stringMatching(/[/\\]data[/\\]pep\.csv$/),
          originalFilename: 'pep.csv',
          sourceHint: 'PEP',
          uploadedBy: 'svc@corp.test',
          importOptions: {},
        });
        expect(runFetchTriggeredImport).not.toHaveBeenCalled();
      });

      it('with both sources and csvPath: calls both runFetchTriggeredImport and processUpload', async () => {
        runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: { EU: 5 } });
        processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 2, uploaded: 2 } });

        await handleRunDatabaseImport({ sources: ['EU'], csvPath: 'pep.csv' });

        expect(runFetchTriggeredImport).toHaveBeenCalledWith({ sources: ['EU'], uploadedBy: 'svc@corp.test' });
        expect(processUpload).toHaveBeenCalledWith(expect.objectContaining({ filePath: expect.stringMatching(/pep\.csv$/) }));
      });

      it('reports the csv import outcome to the caller on success', async () => {
        processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 5, uploaded: 5 } });

        const result = await handleRunDatabaseImport({ csvPath: 'pep.csv' });

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('imp_1');
      });

      it('marks the result as an error when the csv upload fails', async () => {
        processUpload.mockResolvedValue({ outcome: 'failed', importId: 'imp_1', error: 'boom' });

        const result = await handleRunDatabaseImport({ csvPath: 'pep.csv' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('boom');
      });

      it('does not mark it as an error for a rejected (duplicate) csv upload', async () => {
        processUpload.mockResolvedValue({ outcome: 'rejected', importId: 'imp_2', duplicateOfImportId: 'imp_1' });

        const result = await handleRunDatabaseImport({ csvPath: 'pep.csv' });

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('imp_1');
      });
    });

    // The actual security fix: a client-supplied csvPath must be constrained
    // to the permitted directory, mirroring what the REST route
    // (POST /api/import, validateCsvPath) and runImport's own csvPath option
    // already enforce. Before this fix, run_database_import's csvPath went
    // straight to processUpload()'s fs.readFile with no check at all.
    describe('csvPath validation (issue #262)', () => {
      it('rejects an absolute path outside the permitted directory before calling processUpload', async () => {
        const result = await handleRunDatabaseImport({ csvPath: '/etc/passwd' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/permitted|traversal|Forbidden/i);
        expect(processUpload).not.toHaveBeenCalled();
      });

      it('rejects a directory-traversal relative path before calling processUpload', async () => {
        const result = await handleRunDatabaseImport({ csvPath: '../.env' });

        expect(result.isError).toBe(true);
        expect(processUpload).not.toHaveBeenCalled();
      });

      it('rejects a path containing a null byte before calling processUpload', async () => {
        const result = await handleRunDatabaseImport({ csvPath: 'pep.csv\0.txt' });

        expect(result.isError).toBe(true);
        expect(processUpload).not.toHaveBeenCalled();
      });
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
