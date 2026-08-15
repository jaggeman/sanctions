import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

let realCsvPath: string;

const invalidateSearchIndex = vi.fn();
vi.mock('../../src/search', () => ({ invalidateSearchIndex }));

const uploadRecords = vi.fn(async () => {});
vi.mock('../../src/importer/uploader', () => ({ uploadRecords, normalizeText: (s: string) => s }));

vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async () => '/tmp/fake.xml'),
  SOURCE_URLS: { EU: 'x', UN: 'y', US: 'z' },
}));
vi.mock('../../src/importer/parsers/eu', () => ({ parseEUList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/un', () => ({ parseUNList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/us', () => ({ parseUSList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/csv', () => ({
  parseCSVList: vi.fn(async () => [{ id: 'PEP-1', primaryName: 'Test' }]),
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
    expect(uploadRecords).toHaveBeenCalled();
    expect(invalidateSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate the index when nothing was uploaded (no records parsed)', async () => {
    (await import('../../src/importer/parsers/csv')).parseCSVList = vi.fn(async () => []);
    await runImport({ sources: [] }); // no csvPath, no sources parsed -> zero records
    expect(uploadRecords).not.toHaveBeenCalled();
    expect(invalidateSearchIndex).not.toHaveBeenCalled();
  });
});
