import { describe, it, expect, vi, beforeEach } from 'vitest';

const downloadFile = vi.fn();
vi.mock('../../src/importer/fetcher', () => ({
  downloadFile: (...args: any[]) => downloadFile(...args),
  SOURCE_URLS: {
    EU: 'https://example.test/eu.xml',
    UN: 'https://example.test/un.xml',
    US: 'https://example.test/us.xml',
    UK: 'https://example.test/uk.xml',
    CH: 'https://example.test/ch.xml',
  },
}));

const processUpload = vi.fn();
vi.mock('../../src/importer/uploadPipeline', () => ({
  processUpload: (...args: any[]) => processUpload(...args),
}));

vi.mock('../../src/importer/parsers/ua', () => ({
  parseUaListStreaming: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/importer/diff', () => ({
  startDiffSession: vi.fn().mockResolvedValue({
    abort: vi.fn(),
    addChunk: vi.fn(),
    finish: vi.fn(),
  }),
}));

const { runScheduledFetch } = await import('../../src/importer/scheduledFetch');

beforeEach(() => {
  vi.clearAllMocks();
  downloadFile.mockImplementation(async (_url: string, filename: string) => `/tmp/${filename}`);
  processUpload.mockResolvedValue({
    outcome: 'applied',
    importId: 'abc123',
    counts: { parsed: 10, uploaded: 10 },
  });
});

describe('runScheduledFetch — happy path', () => {
  it('downloads and processes all five sources (EU, UN, US, UK, CH) with mode "sync" and no uploader', async () => {
    const outcomes = await runScheduledFetch();

    expect(downloadFile).toHaveBeenCalledTimes(5);
    expect(processUpload).toHaveBeenCalledTimes(5);

    for (const call of processUpload.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          uploadedBy: null,
          importOptions: expect.objectContaining({ mode: 'sync' }),
        }),
      );
    }

    expect(outcomes).toHaveLength(5);
    expect(outcomes.map((o: any) => o.source).sort()).toEqual(['CH', 'EU', 'UK', 'UN', 'US']);
    expect(outcomes.every((o: any) => o.status === 'ok')).toBe(true);
  });

  it('passes each source\'s own sourceHint and downloaded file path through to processUpload', async () => {
    await runScheduledFetch();

    const euCall = processUpload.mock.calls.find((c: any) => c[0].sourceHint === 'EU');
    expect(euCall[0]).toEqual(expect.objectContaining({ filePath: '/tmp/eu_sanctions.xml' }));

    const unCall = processUpload.mock.calls.find((c: any) => c[0].sourceHint === 'UN');
    expect(unCall[0]).toEqual(expect.objectContaining({ filePath: '/tmp/un_sanctions.xml' }));

    const usCall = processUpload.mock.calls.find((c: any) => c[0].sourceHint === 'US');
    expect(usCall[0]).toEqual(expect.objectContaining({ filePath: '/tmp/us_sdn.xml' }));

    const ukCall = processUpload.mock.calls.find((c: any) => c[0].sourceHint === 'UK');
    expect(ukCall[0]).toEqual(expect.objectContaining({ filePath: '/tmp/uk_sanctions.xml' }));

    const chCall = processUpload.mock.calls.find((c: any) => c[0].sourceHint === 'CH');
    expect(chCall[0]).toEqual(expect.objectContaining({ filePath: '/tmp/ch_sanctions.xml' }));
  });
});

describe('runScheduledFetch — unchanged source (dedup)', () => {
  it('treats a "rejected" (duplicate-of-last-run) outcome as a no-op success, not an error', async () => {
    processUpload.mockResolvedValue({
      outcome: 'rejected',
      importId: 'abc123',
      duplicateOfImportId: 'earlier-import',
    });

    const outcomes = await runScheduledFetch();

    expect(outcomes.every((o: any) => o.status === 'ok')).toBe(true);
  });
});

describe('runScheduledFetch — per-source failure isolation', () => {
  it('reports one source as failed (e.g. a tripped delist guard) without stopping the others', async () => {
    processUpload.mockImplementation(async (opts: any) => {
      if (opts.sourceHint === 'UN') {
        return { outcome: 'failed', importId: 'x', error: 'Refusing to delist 80% of active UN records' };
      }
      return { outcome: 'applied', importId: 'x', counts: { parsed: 1, uploaded: 1 } };
    });

    const outcomes = await runScheduledFetch();

    expect(outcomes).toHaveLength(5);
    const un = outcomes.find((o: any) => o.source === 'UN');
    expect(un.status).toBe('error');
    expect(un.error).toMatch(/delist/i);

    const others = outcomes.filter((o: any) => o.source !== 'UN');
    expect(others.every((o: any) => o.status === 'ok')).toBe(true);
    expect(processUpload).toHaveBeenCalledTimes(5);
  });

  it('reports a download failure as an error for that source only, and still processes the rest', async () => {
    downloadFile.mockImplementation(async (url: string, filename: string) => {
      if (filename === 'us_sdn.xml') throw new Error('ECONNRESET');
      return `/tmp/${filename}`;
    });

    const outcomes = await runScheduledFetch();

    expect(outcomes).toHaveLength(5);
    const us = outcomes.find((o: any) => o.source === 'US');
    expect(us.status).toBe('error');
    expect(us.error).toMatch(/ECONNRESET/);

    // US never reached processUpload since its download failed (5 - 1 = 4 reached).
    expect(processUpload).toHaveBeenCalledTimes(4);

    const others = outcomes.filter((o: any) => o.source !== 'US');
    expect(others.every((o: any) => o.status === 'ok')).toBe(true);
  });
});

describe('SOURCE_URLS drift prevention (issue #183)', () => {
  it('covers every source defined in fetcher.ts SOURCE_URLS', async () => {
    const { SOURCE_URLS: realSourceUrls } = await vi.importActual<typeof import('../../src/importer/fetcher')>('../../src/importer/fetcher');
    const { SCHEDULED_SOURCES } = await import('../../src/importer/scheduledFetch');

    const scheduledSourceNames = SCHEDULED_SOURCES.map((s) => s.source).sort();
    const definedSourceNames = Object.keys(realSourceUrls).sort();

    expect(scheduledSourceNames).toEqual(definedSourceNames);
  });
});
