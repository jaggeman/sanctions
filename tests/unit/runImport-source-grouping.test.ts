import { describe, it, expect, vi, beforeEach } from 'vitest';

const invalidateSearchIndex = vi.fn();
vi.mock('../../src/search', () => ({ invalidateSearchIndex }));

/**
 * runImport drives one streaming diff session per source (issue #8). The
 * grouping guarantee this file exists to protect is unchanged and is the whole
 * point: a session is scoped to a single source, so "active records missing
 * from this batch" can never span sources. Getting that wrong would delist
 * every UN and US record the moment an EU-only file came through.
 *
 * What the streaming rewrite changed is the shape, not the guarantee: records
 * arrive via addChunk instead of being handed over as one array, so these
 * assertions collect what each session was actually fed.
 */
const chunksBySource = new Map<string, any[]>();
const sessionOptions = new Map<string, any>();
const finishBehaviour = new Map<string, () => Promise<any>>();

const emptyResult = (source: string) => ({
  source,
  counts: { parsed: 0, added: 0, updated: 0, unchanged: 0, delisted: 0, skipped: 0 },
  toDelistIds: [],
  activeCount: 0,
  guardTripped: false,
});

const startDiffSession = vi.fn(async (source: string, options: any) => {
  sessionOptions.set(source, options);
  return {
    addChunk: vi.fn(async (records: any[]) => {
      chunksBySource.set(source, [...(chunksBySource.get(source) || []), ...records]);
      return records.length;
    }),
    finish: vi.fn(async () => {
      const override = finishBehaviour.get(source);
      if (override) return override();
      return emptyResult(source);
    }),
    abort: vi.fn(() => emptyResult(source)),
  };
});

vi.mock('../../src/importer/diff', () => ({
  startDiffSession,
  DEFAULT_IMPORT_MODE: 'append',
}));

vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: vi.fn(async () => '/tmp/fake.xml'),
  SOURCE_URLS: { EU: 'x', UN: 'y', US: 'z' },
}));
vi.mock('../../src/importer/parsers/eu', () => ({
  parseEUListStreaming: vi.fn(async (_path: string, onRecord: (r: any) => Promise<void>) => {
    await onRecord({ id: 'EU-1', source: 'EU', primaryName: 'EU One' });
    await onRecord({ id: 'EU-2', source: 'EU', primaryName: 'EU Two' });
    return 2;
  }),
}));
vi.mock('../../src/importer/parsers/un', () => ({
  parseUNList: vi.fn(async () => [{ id: 'UN-1', source: 'UN', primaryName: 'UN One' }]),
}));
vi.mock('../../src/importer/parsers/us', () => ({ parseUSListStreaming: vi.fn(async () => 0) }));
vi.mock('../../src/importer/parsers/csv', () => ({ parseCSVList: vi.fn(async () => []) }));

const { runImport } = await import('../../src/importer');

beforeEach(() => {
  vi.clearAllMocks();
  chunksBySource.clear();
  sessionOptions.clear();
  finishBehaviour.clear();
});

describe('runImport — per-source diff sessions (issue #8)', () => {
  it('opens one session per distinct source, never mixing sources together', async () => {
    await runImport({ sources: ['EU', 'UN'] });

    expect(startDiffSession).toHaveBeenCalledTimes(2);
    const calledSources = startDiffSession.mock.calls.map((call) => call[0]).sort();
    expect(calledSources).toEqual(['EU', 'UN']);

    expect(chunksBySource.get('EU')).toHaveLength(2);
    expect(chunksBySource.get('EU')!.every((r: any) => r.source === 'EU')).toBe(true);
    expect(chunksBySource.get('UN')).toHaveLength(1);
    expect(chunksBySource.get('UN')!.every((r: any) => r.source === 'UN')).toBe(true);
  });

  it('defaults to append mode when no mode is specified', async () => {
    await runImport({ sources: ['EU'] });

    expect(startDiffSession).toHaveBeenCalledWith('EU', expect.objectContaining({ mode: 'append' }));
  });

  it('passes an explicit sync mode and force flag through to every source session', async () => {
    await runImport({ sources: ['EU', 'UN'], mode: 'sync', force: true, importId: 'import-xyz' });

    for (const [, options] of sessionOptions) {
      expect(options).toMatchObject({ mode: 'sync', force: true, importId: 'import-xyz' });
    }
  });

  it('surfaces a DelistGuardError from one source as an overall failed result', async () => {
    // The guard fires in finish(), after the producer completed cleanly —
    // that ordering is what lets a truncated file add and update records but
    // never mass-delist.
    finishBehaviour.set('EU', async () => {
      throw new Error('refused');
    });

    const result = await runImport({ sources: ['EU', 'UN'], mode: 'sync' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('refused');
  });
});
