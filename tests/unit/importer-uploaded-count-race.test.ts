import { describe, it, expect, vi } from 'vitest';
import { SanctionRecord } from '../../src/shared/types';

/**
 * issue #171: `uploaded += await session.addChunk(chunk)` reads `uploaded`
 * BEFORE evaluating the awaited right-hand side (JS compound-assignment
 * semantics) — if two flushes for the same source ever overlap (enabled by
 * the streaming backpressure race this same issue also fixes), both read the
 * same stale `uploaded` value and whichever write lands second clobbers the
 * first's contribution. This proves the accumulation itself is safe under
 * concurrency, independent of whether the backpressure fix ever lets two
 * flushes overlap in practice.
 */

vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async () => '/tmp/whatever.xml'),
  SOURCE_URLS: { EU: 'x', UN: 'y', US: 'z' },
}));
vi.mock('../../src/importer/parsers/un', () => ({ parseUNList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/us', () => ({ parseUSListStreaming: vi.fn(async () => 0) }));
vi.mock('../../src/importer/parsers/csv', () => ({ parseCSVList: vi.fn(async () => []) }));
vi.mock('../../src/search', () => ({ invalidateSearchIndex: vi.fn() }));

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
mockLog.child.mockReturnValue(mockLog);
vi.mock('../../src/shared/logger', () => ({ logger: mockLog }));

type Deferred = { resolve: (n: number) => void };
const addChunkDeferreds: Deferred[] = [];
const mockAddChunk = vi.fn(() => {
  return new Promise<number>((resolve) => {
    addChunkDeferreds.push({ resolve });
  });
});

vi.mock('../../src/importer/diff', () => ({
  DEFAULT_IMPORT_MODE: 'append',
  startDiffSession: vi.fn(async (source: string) => ({
    addChunk: mockAddChunk,
    finish: vi.fn(async () => ({
      source,
      counts: { parsed: 0, added: 0, updated: 0, unchanged: 0, delisted: 0, skipped: 0 },
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
  })),
}));

function record(id: string): SanctionRecord {
  return {
    id,
    source: 'EU',
    type: 'individual',
    primaryName: id,
    aliases: [],
    searchNames: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

vi.mock('../../src/importer/parsers/eu', () => ({
  // Mirrors the real race trigger: fires 1000 onRecord calls WITHOUT
  // awaiting between them — the same shape as SAX delivering many closetag
  // events synchronously before any async flush has resolved. With
  // EU_UPLOAD_CHUNK_SIZE=500, this crosses the flush threshold twice.
  parseEUListStreaming: vi.fn(async (_path: string, onRecord: (r: SanctionRecord) => Promise<void>) => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(onRecord(record(`EU-${i}`)));
    }
    await Promise.all(promises);
    return 1000;
  }),
}));

const { runImport } = await import('../../src/importer/index');

describe('runImport — uploaded count under overlapping flushes (issue #171)', () => {
  it('does not lose an update when the second flush resolves before the first', async () => {
    const resultPromise = runImport({ sources: ['EU'] });

    await vi.waitFor(() => expect(mockAddChunk).toHaveBeenCalledTimes(2));

    // Resolve out of order: the SECOND (later) flush settles first.
    addChunkDeferreds[1].resolve(500);
    await Promise.resolve();
    await Promise.resolve();
    addChunkDeferreds[0].resolve(500);

    await resultPromise;

    const finishedCall = mockLog.info.mock.calls.find(([msg]) => msg === 'import.finished');
    expect(finishedCall).toBeDefined();
    expect(finishedCall![1].uploaded).toBe(1000); // not 500 — neither flush's contribution is lost
  });
});
