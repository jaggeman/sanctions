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
vi.mock('../../src/search', () => ({
  invalidateSearchIndex: vi.fn(),
}));

import { runImport, EU_UPLOAD_CHUNK_SIZE, US_UPLOAD_CHUNK_SIZE } from '../../src/importer/index';
import { parseEUListStreaming } from '../../src/importer/parsers/eu';
import { parseUNList } from '../../src/importer/parsers/un';
import { parseUSListStreaming } from '../../src/importer/parsers/us';
import { uploadRecords } from '../../src/importer/uploader';

function makeRecord(id: string): SanctionRecord {
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

describe('runImport — chunked uploads, no full-run accumulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads EU records in chunks as they stream in, never as one giant array', async () => {
    const total = EU_UPLOAD_CHUNK_SIZE + 1;
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      for (let i = 0; i < total; i++) {
        await onRecord(makeRecord(`EU-${i}`));
      }
      return total;
    });
    vi.mocked(parseUNList).mockResolvedValue([]);
    vi.mocked(parseUSListStreaming).mockResolvedValue(0);

    const result = await runImport({ sources: ['EU'] });

    expect(result.success).toBe(true);
    expect(result.importedCounts.EU).toBe(total);

    const uploadCalls = vi.mocked(uploadRecords).mock.calls;
    expect(uploadCalls.length).toBeGreaterThanOrEqual(2);
    for (const [chunk] of uploadCalls) {
      expect(chunk.length).toBeLessThanOrEqual(EU_UPLOAD_CHUNK_SIZE);
    }
    const totalUploaded = uploadCalls.reduce((sum, [chunk]) => sum + chunk.length, 0);
    expect(totalUploaded).toBe(total);
  });

  it('uploads each source as soon as it is parsed, never combining sources into one array', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('EU-1'));
      return 1;
    });
    vi.mocked(parseUNList).mockResolvedValue([{ ...makeRecord('UN-1'), source: 'UN' }]);
    vi.mocked(parseUSListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord({ ...makeRecord('US-1'), source: 'US' });
      return 1;
    });

    const result = await runImport({ sources: ['EU', 'UN', 'US'] });

    expect(result.success).toBe(true);
    expect(result.importedCounts).toEqual({ EU: 1, UN: 1, US: 1 });

    const uploadCalls = vi.mocked(uploadRecords).mock.calls;
    // No single upload call may mix records from more than one source.
    for (const [chunk] of uploadCalls) {
      const sources = new Set(chunk.map((r: SanctionRecord) => r.source));
      expect(sources.size).toBe(1);
    }
  });

  it('reports records actually uploaded so far even if EU streaming fails partway through', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('EU-1'));
      await onRecord(makeRecord('EU-2'));
      throw new Error('network dropped mid-stream');
    });

    const result = await runImport({ sources: ['EU'] });

    expect(result.importedCounts.EU).toBe(2);
    const uploadCalls = vi.mocked(uploadRecords).mock.calls;
    const totalUploaded = uploadCalls.reduce((sum, [chunk]) => sum + chunk.length, 0);
    expect(totalUploaded).toBe(2);
  });

  it('still reports failure when nothing at all was parsed', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async () => 0);
    vi.mocked(parseUNList).mockResolvedValue([]);
    vi.mocked(parseUSListStreaming).mockResolvedValue(0);

    const result = await runImport({ sources: ['EU', 'UN', 'US'] });

    expect(result.success).toBe(false);
    expect(vi.mocked(uploadRecords)).not.toHaveBeenCalled();
  });

  it('uploads US records in chunks as they stream in, never as one giant array', async () => {
    const total = US_UPLOAD_CHUNK_SIZE + 1;
    vi.mocked(parseUSListStreaming).mockImplementation(async (_path, onRecord) => {
      for (let i = 0; i < total; i++) {
        await onRecord({ ...makeRecord(`US-${i}`), source: 'US' });
      }
      return total;
    });
    vi.mocked(parseUNList).mockResolvedValue([]);

    const result = await runImport({ sources: ['US'] });

    expect(result.success).toBe(true);
    expect(result.importedCounts.US).toBe(total);

    const uploadCalls = vi.mocked(uploadRecords).mock.calls;
    expect(uploadCalls.length).toBeGreaterThanOrEqual(2);
    for (const [chunk] of uploadCalls) {
      expect(chunk.length).toBeLessThanOrEqual(US_UPLOAD_CHUNK_SIZE);
    }
    const totalUploaded = uploadCalls.reduce((sum, [chunk]) => sum + chunk.length, 0);
    expect(totalUploaded).toBe(total);
  });

  it('still drops CUSTOM-sourced records per chunk (issue #10 backstop applies per-chunk now)', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord(makeRecord('EU-1'));
      await onRecord({ ...makeRecord('EU-CUSTOM'), source: 'CUSTOM' });
      return 2;
    });

    const result = await runImport({ sources: ['EU'] });

    expect(result.importedCounts.EU).toBe(2); // parsed count, pre-filter
    const uploadCalls = vi.mocked(uploadRecords).mock.calls;
    const uploadedIds = uploadCalls.flatMap(([chunk]) => chunk.map((r: SanctionRecord) => r.id));
    expect(uploadedIds).toEqual(['EU-1']);
  });

  it('reports failure (not success) when everything parsed was CUSTOM-sourced', async () => {
    vi.mocked(parseEUListStreaming).mockImplementation(async (_path, onRecord) => {
      await onRecord({ ...makeRecord('EU-CUSTOM'), source: 'CUSTOM' });
      return 1;
    });

    const result = await runImport({ sources: ['EU'] });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CUSTOM/);
    expect(vi.mocked(uploadRecords)).not.toHaveBeenCalled();
  });
});
