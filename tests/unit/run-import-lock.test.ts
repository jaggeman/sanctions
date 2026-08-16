import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb } = createFakeDb();

vi.mock('../../src/shared/firebase', () => {
  const originalCollection = fakeDb.collection;
  const augmentedDb = {
    ...fakeDb,
    collection: (name: string) => {
      if (name === 'sanctions') {
        return {
          where: (_field: string, _op: string, _val: any) => ({
            select: (..._fields: string[]) => ({
              get: async () => ({
                forEach: (_cb: any) => {},
              }),
            }),
          }),
        };
      }
      return originalCollection(name);
    },
  };
  return {
    db: augmentedDb,
    default: augmentedDb,
  };
});

vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async (_url: string, filename: string) => `/tmp/${filename}`),
  SOURCE_URLS: { EU: 'https://example.test/eu', UN: 'https://example.test/un', US: 'https://example.test/us', UK: 'https://example.test/uk' },
}));

vi.mock('../../src/importer/parsers/eu', () => ({
  parseEUListStreaming: vi.fn(async () => 0),
}));
vi.mock('../../src/importer/parsers/un', () => ({
  parseUNList: vi.fn(async () => []),
}));
vi.mock('../../src/importer/parsers/us', () => ({
  parseUSListStreaming: vi.fn(async () => 0),
}));
vi.mock('../../src/importer/parsers/uk', () => ({
  parseUKListStreaming: vi.fn(async () => 0),
}));
vi.mock('../../src/importer/parsers/csv', () => ({
  parseCSVList: vi.fn(async () => []),
}));
vi.mock('../../src/importer/uploader', () => ({
  uploadRecords: vi.fn(async () => {}),
  delistRecords: vi.fn(async () => {}),
  computeContentHash: vi.fn(() => 'hash'),
  filterAutomatedBatch: vi.fn((r) => r),
}));

const { runImport } = await import('../../src/importer/index');
const { acquireSourceLock, isSourceLocked } = await import('../../src/importer/importLock');

describe('runImport concurrency protection (issue #184)', () => {
  beforeEach(() => {
    resetFakeDb();
    vi.clearAllMocks();
  });

  it('fails cleanly when a source is already locked by another import run', async () => {
    // Acquire lock on EU beforehand (simulating another in-flight import)
    const releaseLock = await acquireSourceLock('EU', 'active_import_1');
    expect(await isSourceLocked('EU')).toBe(true);

    const result = await runImport({ sources: ['EU'] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('is currently in progress');

    await releaseLock();
    expect(await isSourceLocked('EU')).toBe(false);
  });
});
