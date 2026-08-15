import { describe, it, expect, vi } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';

// Same rationale as tests/unit/normalize.test.ts: filterAutomatedBatch is a
// pure function, but it lives in uploader.ts alongside uploadRecords, which
// imports ../shared/firebase at module load. Stub it out so this stays offline.
vi.mock('../../src/shared/firebase', () => ({
  db: { collection: () => ({}), batch: () => ({ set: () => {}, commit: async () => {} }) },
}));

import { filterAutomatedBatch } from '../../src/importer/uploader';

function record(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    primaryName: 'Someone',
    aliases: [],
    searchNames: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('filterAutomatedBatch', () => {
  it('passes through non-CUSTOM records unchanged', () => {
    const batch = [record({ id: 'EU-1', source: 'EU' }), record({ id: 'PEP-1', source: 'PEP' })];
    expect(filterAutomatedBatch(batch)).toEqual(batch);
  });

  it('drops every CUSTOM-sourced record', () => {
    const batch = [
      record({ id: 'EU-1', source: 'EU' }),
      record({ id: 'CUSTOM-1', source: 'CUSTOM' }),
      record({ id: 'CUSTOM-2', source: 'CUSTOM' }),
    ];
    const result = filterAutomatedBatch(batch);
    expect(result.map((r) => r.id)).toEqual(['EU-1']);
  });

  it('returns an empty array when every record is CUSTOM', () => {
    expect(filterAutomatedBatch([record({ source: 'CUSTOM' })])).toEqual([]);
  });

  it('returns an empty array unchanged for an empty batch', () => {
    expect(filterAutomatedBatch([])).toEqual([]);
  });
});
