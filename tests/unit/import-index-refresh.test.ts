import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

let realCsvPath: string;

const invalidateSearchIndex = vi.fn();
vi.mock('../../src/search', () => ({ invalidateSearchIndex }));

const runDiffForSource = vi.fn(async (source: string, records: unknown[]) => ({
  source,
  counts: { parsed: records.length, added: records.length, updated: 0, unchanged: 0, delisted: 0, skipped: 0 },
  recordsToWrite: records,
  toDelistIds: [],
  activeCount: 0,
  guardTripped: false,
}));
vi.mock('../../src/importer/diff', () => ({
  runDiffForSource,
  DEFAULT_IMPORT_MODE: 'append',
}));

vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async () => '/tmp/fake.xml'),
  SOURCE_URLS: { EU: 'x', UN: 'y', US: 'z' },
}));
vi.mock('../../src/importer/parsers/eu', () => ({ parseEUList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/un', () => ({ parseUNList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/us', () => ({ parseUSList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/csv', () => ({
  parseCSVList: vi.fn(async () => [{ id: 'PEP-1', primaryName: 'Test', source: 'PEP' }]),
}));

const { runImport } = await import('../../src/importer');

beforeAll(async () => {
  realCsvPath = path.join(os.tmpdir(), `import-refresh-test-${Date.now()}.csv`);
  await fs.writeFile(realCsvPath, 'id;name\n1;Test Person\n', 'utf-8');
});

afterAll(async () => {
  await fs.remove(realCsvPath);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runImport — search index refresh', () => {
  it('invalidates the search index cache after a successful upload', async () => {
    await runImport({ sources: [], csvPath: realCsvPath });
    expect(runDiffForSource).toHaveBeenCalled();
    expect(invalidateSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate the index when nothing was uploaded (no records parsed)', async () => {
    (await import('../../src/importer/parsers/csv')).parseCSVList = vi.fn(async () => []);
    await runImport({ sources: [] }); // no csvPath, no sources parsed -> zero records
    expect(runDiffForSource).not.toHaveBeenCalled();
    expect(invalidateSearchIndex).not.toHaveBeenCalled();
  });

  it('does not invalidate the index on a dry run, even though records were parsed', async () => {
    // The previous test reassigns this module's parseCSVList export directly
    // (not via vi.mock, so vi.clearAllMocks() doesn't undo it) — restore the
    // real fixture-returning mock so this test doesn't depend on order.
    (await import('../../src/importer/parsers/csv')).parseCSVList = vi.fn(async () => [
      { id: 'PEP-1', primaryName: 'Test', source: 'PEP' },
    ]);

    await runImport({ sources: [], csvPath: realCsvPath, dryRun: true });
    expect(runDiffForSource).toHaveBeenCalledWith(
      'PEP',
      expect.any(Array),
      expect.objectContaining({ dryRun: true }),
    );
    expect(invalidateSearchIndex).not.toHaveBeenCalled();
  });
});
