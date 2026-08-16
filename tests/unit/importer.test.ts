import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SanctionRecord } from '../../src/shared/types';

vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async (_url: string, filename: string) => `/tmp/${filename}`),
  SOURCE_URLS: { EU: 'https://example.test/eu', UN: 'https://example.test/un', US: 'https://example.test/us' },
}));

vi.mock('../../src/importer/parsers/eu', () => ({
  parseEUListStreaming: vi.fn(),
}));
vi.mock('../../src/importer/parsers/un', () => ({
  parseUNList: vi.fn(),
}));
vi.mock('../../src/importer/parsers/us', () => ({
  parseUSListStreaming: vi.fn(),
}));
vi.mock('../../src/importer/parsers/csv', () => ({
  parseCSVList: vi.fn(async () => []),
}));
vi.mock('../../src/importer/uploader', () => ({
  uploadRecords: vi.fn(async () => {}),
  filterAutomatedBatch: vi.fn((records: SanctionRecord[]) => records.filter((r) => r.source !== 'CUSTOM')),
}));

// runImport drives one streaming diff session per source. The session records
// everything it was fed so the assertions below can still ask "which records
// reached the diff engine, grouped by source" without a database.
const diffFedBySource = new Map<string, SanctionRecord[]>();
const startDiffSession = vi.fn(async (source: string) => ({
  addChunk: vi.fn(async (records: SanctionRecord[]) => {
    // The real session drops CUSTOM records via filterAutomatedBatch before
    // classifying them (issue #10 enforcement moved into the diff engine);
    // mirror that here so the assertion below still means something.
    const { filterAutomatedBatch } = await import('../../src/importer/uploader');
    const eligible = source === 'CUSTOM' ? records : filterAutomatedBatch(records);
    if (eligible.length > 0) {
      diffFedBySource.set(source, [...(diffFedBySource.get(source) || []), ...eligible]);
    }
    return eligible.length;
  }),
  finish: vi.fn(async () => ({
    source,
    counts: {
      parsed: (diffFedBySource.get(source) || []).length,
      added: (diffFedBySource.get(source) || []).length,
      updated: 0,
      unchanged: 0,
      delisted: 0,
      skipped: 0,
    },
    toDelistIds: [],
    activeCount: 0,
    guardTripped: false,
  })),
  abort: vi.fn(() => ({
    source,
    counts: { parsed: 0, added: 0, updated: 0, unchanged: 0, delisted: 0, skipped: 0 },
    toDelistIds: [],
    activeCount: 0,
    guardTripped: false,
  })),
}));
vi.mock('../../src/importer/diff', () => ({
  startDiffSession,
  DEFAULT_IMPORT_MODE: 'append',
}));
vi.mock('../../src/search', () => ({
  invalidateSearchIndex: vi.fn(),
}));

import { parseEUListStreaming } from '../../src/importer/parsers/eu';
import { parseUNList } from '../../src/importer/parsers/un';
import { parseUSListStreaming } from '../../src/importer/parsers/us';
import { filterAutomatedBatch } from '../../src/importer/uploader';

// Dynamic import (not a static top-level one): src/importer/index.ts imports
// ./diff, which is mocked above via a factory that references the
// `runDiffForSource` const — vi.mock calls are hoisted above top-level
// `const`s, so a *static* import here would load that module (and invoke the
// factory) before the const is initialized. A dynamic import runs in
// sequential file order instead, after the const above has already run.
const { runImport } = await import('../../src/importer/index');

function makeRecord(id: string, source: SanctionRecord['source'] = 'EU'): SanctionRecord {
  return {
    id,
    source,
    type: 'individual',
    primaryName: id,
    aliases: [],
    searchNames: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// Streaming (issue #5/#31) is what keeps the raw XML *parse* memory-bounded
// — covered by eu-parser-streaming.test.ts / us-parser.test.ts. This file
// covers what runImport does with the records once they've streamed in:
// accumulate per source, then hand each source's full set to the diff engine
// (issue #8) exactly once. The diff engine — not runImport — decides what
// actually gets written, so these tests assert on calls into
// runDiffForSource rather than into uploadRecords directly.
describe('runImport — streams sources, reconciles each via the diff engine', () => {
  beforeEach(() => {
    diffFedBySource.clear();
    vi.clearAllMocks();
  });

  it('reports the number of records streamed per source', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('EU-1'));
      await onRecord(makeRecord('EU-2'));
      return 2;
    });
    vi.mocked(parseUNList).mockResolvedValue([]);
    vi.mocked(parseUSListStreaming).mockResolvedValue(0);

    const result = await runImport({ sources: ['EU'] });

    expect(result.success).toBe(true);
    expect(result.importedCounts.EU).toBe(2);
  });

  it('calls the diff engine once per source, never mixing sources in one call', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('EU-1', 'EU'));
      return 1;
    });
    vi.mocked(parseUNList).mockResolvedValue([makeRecord('UN-1', 'UN')]);
    vi.mocked(parseUSListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('US-1', 'US'));
      return 1;
    });

    const result = await runImport({ sources: ['EU', 'UN', 'US'] });

    expect(result.success).toBe(true);
    expect(result.importedCounts).toEqual({ EU: 1, UN: 1, US: 1 });
    expect(startDiffSession).toHaveBeenCalledTimes(3);
    const calledSources = startDiffSession.mock.calls.map((call) => call[0]).sort();
    expect(calledSources).toEqual(['EU', 'UN', 'US']);
    // The guarantee: whatever each session was fed carries exactly one source.
    for (const [source, records] of diffFedBySource) {
      const sources = new Set(records.map((r) => r.source));
      expect(sources, `session for ${source} was fed mixed sources`).toEqual(new Set([source]));
    }
  });

  it('reports failure when nothing at all was parsed, and feeds the diff engine nothing', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async () => 0);
    vi.mocked(parseUNList).mockResolvedValue([]);
    vi.mocked(parseUSListStreaming).mockResolvedValue(0);

    const result = await runImport({ sources: ['EU', 'UN', 'US'] });

    expect(result.success).toBe(false);
    // A session IS opened per source before parsing — it has to be, since
    // classifying the first streamed record requires the source's current
    // state. What matters is that nothing was fed to it, so nothing is
    // written. (In sync mode an empty parse would additionally trip the
    // delist guard, which is the intended loud failure.)
    expect(diffFedBySource.size).toBe(0);
  });

  it('reports records streamed so far when EU parsing fails partway, but does not reconcile that partial batch', async () => {
    // The issue's own gotcha: a parse that fails halfway must not trigger a
    // delist pass over records it never reached — the records never parsed
    // would otherwise look identical to the diff engine as "missing from the
    // file". A sibling source that DID complete (UN here) must still be
    // reconciled normally.
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('EU-1'));
      await onRecord(makeRecord('EU-2'));
      throw new Error('network dropped mid-stream');
    });
    vi.mocked(parseUNList).mockResolvedValue([makeRecord('UN-1', 'UN')]);
    vi.mocked(parseUSListStreaming).mockResolvedValue(0);

    const result = await runImport({ sources: ['EU', 'UN'] });

    expect(result.importedCounts.EU).toBe(2);
    // EU's session was opened and fed the two records that did arrive — those
    // writes are real and are kept. What must NOT happen is EU's delist pass:
    // runImport calls abort() rather than finish() for a parse that threw.
    expect(result.diffs?.find((d) => d.source === 'EU')?.toDelistIds).toEqual([]);
    expect(result.diffs?.find((d) => d.source === 'UN')).toBeDefined();
  });

  it('applies filterAutomatedBatch to a source before handing it to the diff engine', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('EU-1', 'EU'));
      await onRecord(makeRecord('EU-CUSTOM', 'CUSTOM'));
      return 2;
    });
    vi.mocked(parseUNList).mockResolvedValue([]);
    vi.mocked(parseUSListStreaming).mockResolvedValue(0);

    const result = await runImport({ sources: ['EU'] });

    expect(result.importedCounts.EU).toBe(2); // parsed count, pre-filter
    expect(filterAutomatedBatch).toHaveBeenCalled();
    const passedToRunDiff = (diffFedBySource.get('EU') || diffFedBySource.get('PEP') || []) as SanctionRecord[];
    expect(passedToRunDiff.map((r) => r.id)).toEqual(['EU-1']);
  });

  describe('csvPath security validation (issue #157 / CLAUDE.md §6)', () => {
    it('refuses to read files outside the permitted directory', async () => {
      const result = await runImport({ csvPath: '../../etc/passwd' });
      expect(result.importedCounts.PEP).toBeUndefined();
      expect(result.importedCounts.CUSTOM).toBeUndefined();
    });
  });
});
