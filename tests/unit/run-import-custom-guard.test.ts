import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';

/**
 * Issue #10: custom records must never be touched by an automated import run.
 * The diff engine (#8) that would eventually own this enforcement doesn't
 * exist yet — runImport (src/importer/index.ts) is the actual chokepoint
 * today, so that's where the guard lives and where this test targets it.
 */

function euRecord(): SanctionRecord {
  return {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    primaryName: 'Official EU Person',
    aliases: [],
    searchNames: ['official'],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function customRecordFromCsv(): SanctionRecord {
  // Simulates a mislabeled CSV row (row.source explicitly set to "CUSTOM")
  // slipping into what should be a normal PEP CSV import.
  return {
    id: 'CUSTOM-mislabeled',
    source: 'CUSTOM',
    type: 'individual',
    primaryName: 'Should Not Be Auto-Imported',
    aliases: [],
    searchNames: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function pepRecordFromCsv(): SanctionRecord {
  return {
    id: 'PEP-1',
    source: 'PEP',
    type: 'individual',
    primaryName: 'Legitimate PEP Row',
    aliases: [],
    searchNames: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const uploadRecordsMock = vi.fn(async () => {});

// uploader.ts imports ../shared/firebase at module load, which calls
// admin.initializeApp(). Stub it out the same way tests/unit/normalize.test.ts
// does, so importActual below can pull in the real (pure) filterAutomatedBatch
// without touching firebase-admin at all.
vi.mock('../../src/shared/firebase', () => ({
  db: { collection: () => ({}), batch: () => ({ set: () => {}, commit: async () => {} }) },
}));

vi.mock('fs-extra', () => ({
  ensureDir: vi.fn(async () => {}),
  pathExists: vi.fn(async () => true),
}));
vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async (_url: string, name: string) => `/fake/${name}`),
  SOURCE_URLS: { EU: 'http://fake/eu', UN: 'http://fake/un', US: 'http://fake/us' },
}));
vi.mock('../../src/importer/parsers/eu', () => ({
  parseEUListStreaming: vi.fn(async (_path: string, onRecord: (r: SanctionRecord) => unknown) => {
    await onRecord(euRecord());
    return 1;
  }),
}));
vi.mock('../../src/importer/parsers/un', () => ({ parseUNList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/us', () => ({ parseUSList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/csv', () => ({
  parseCSVList: vi.fn(async () => [customRecordFromCsv(), pepRecordFromCsv()]),
}));
vi.mock('../../src/importer/uploader', async () => {
  const actual = await vi.importActual<typeof import('../../src/importer/uploader')>('../../src/importer/uploader');
  return { ...actual, uploadRecords: uploadRecordsMock };
});

const { runImport } = await import('../../src/importer');

beforeEach(() => {
  uploadRecordsMock.mockClear();
});

describe('runImport — CUSTOM-sourced records never reach the automated upload path', () => {
  // EU and CSV are uploaded via separate uploadRecords calls now (issue #5 —
  // each source, and each streamed EU chunk, is flushed as soon as it is
  // parsed rather than combined into one array before a single upload), so
  // these assertions look at everything ever uploaded across every call.
  const allUploaded = (): SanctionRecord[] =>
    uploadRecordsMock.mock.calls.flatMap(([records]) => records as SanctionRecord[]);

  it('drops a CUSTOM-sourced record found in a CSV batch before uploading', async () => {
    await runImport({ sources: ['EU'], csvPath: 'fake.csv', csvSource: 'PEP', csvSeparator: ';' });

    expect(allUploaded().some((r) => r.source === 'CUSTOM')).toBe(false);
  });

  it('still uploads the legitimate EU and PEP records alongside the dropped CUSTOM one', async () => {
    await runImport({ sources: ['EU'], csvPath: 'fake.csv', csvSource: 'PEP', csvSeparator: ';' });

    expect(allUploaded().map((r) => r.id).sort()).toEqual(['EU-1', 'PEP-1']);
  });
});
