import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../../src/importer/parsers/eu', () => ({
  parseEUList: vi.fn(async () => [
    { id: 'EU-1', source: 'EU', primaryName: 'EU One' },
    { id: 'EU-2', source: 'EU', primaryName: 'EU Two' },
  ]),
}));
vi.mock('../../src/importer/parsers/un', () => ({
  parseUNList: vi.fn(async () => [{ id: 'UN-1', source: 'UN', primaryName: 'UN One' }]),
}));
vi.mock('../../src/importer/parsers/us', () => ({ parseUSList: vi.fn(async () => []) }));
vi.mock('../../src/importer/parsers/csv', () => ({ parseCSVList: vi.fn(async () => []) }));

const { runImport } = await import('../../src/importer');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runImport — per-source diff grouping (issue #8)', () => {
  it('calls runDiffForSource once per distinct source, never mixing sources together', async () => {
    await runImport({ sources: ['EU', 'UN'] });

    expect(runDiffForSource).toHaveBeenCalledTimes(2);
    const calledSources = runDiffForSource.mock.calls.map((call) => call[0]).sort();
    expect(calledSources).toEqual(['EU', 'UN']);

    const euCall = runDiffForSource.mock.calls.find((call) => call[0] === 'EU')!;
    expect(euCall[1]).toHaveLength(2);
    expect(euCall[1].every((r: any) => r.source === 'EU')).toBe(true);

    const unCall = runDiffForSource.mock.calls.find((call) => call[0] === 'UN')!;
    expect(unCall[1]).toHaveLength(1);
  });

  it('defaults to append mode when no mode is specified', async () => {
    await runImport({ sources: ['EU'] });

    expect(runDiffForSource).toHaveBeenCalledWith('EU', expect.any(Array), expect.objectContaining({ mode: 'append' }));
  });

  it('passes an explicit sync mode and force flag through to every source group', async () => {
    await runImport({ sources: ['EU', 'UN'], mode: 'sync', force: true, importId: 'import-xyz' });

    for (const call of runDiffForSource.mock.calls) {
      expect(call[2]).toMatchObject({ mode: 'sync', force: true, importId: 'import-xyz' });
    }
  });

  it('surfaces a DelistGuardError from one source as an overall failed result', async () => {
    class FakeDelistGuardError extends Error {}
    runDiffForSource.mockRejectedValueOnce(new FakeDelistGuardError('refused'));

    const result = await runImport({ sources: ['EU', 'UN'], mode: 'sync' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('refused');
  });
});
