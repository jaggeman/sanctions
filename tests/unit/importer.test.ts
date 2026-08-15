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
vi.mock('../../src/importer/uploader', () => ({
  uploadRecords: vi.fn(async () => {}),
  filterAutomatedBatch: vi.fn((records: SanctionRecord[]) => records.filter((r) => r.source !== 'CUSTOM')),
}));

const runDiffForSource = vi.fn(async (source: string, records: SanctionRecord[]) => ({
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
    expect(runDiffForSource).toHaveBeenCalledTimes(3);
    const calledSources = runDiffForSource.mock.calls.map((call) => call[0]).sort();
    expect(calledSources).toEqual(['EU', 'UN', 'US']);
    for (const call of runDiffForSource.mock.calls) {
      const records = call[1] as SanctionRecord[];
      const sources = new Set(records.map((r) => r.source));
      expect(sources.size).toBe(1);
    }
  });

  it('reports failure when nothing at all was parsed, and never calls the diff engine', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async () => 0);
    vi.mocked(parseUNList).mockResolvedValue([]);
    vi.mocked(parseUSListStreaming).mockResolvedValue(0);

    const result = await runImport({ sources: ['EU', 'UN', 'US'] });

    expect(result.success).toBe(false);
    expect(runDiffForSource).not.toHaveBeenCalled();
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
    expect(runDiffForSource).toHaveBeenCalledTimes(1);
    expect(runDiffForSource).toHaveBeenCalledWith('UN', expect.any(Array), expect.anything());
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
    const passedToRunDiff = runDiffForSource.mock.calls[0][1] as SanctionRecord[];
    expect(passedToRunDiff.map((r) => r.id)).toEqual(['EU-1']);
  });
});
