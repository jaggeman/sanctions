import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord, Decision } from '../../src/shared/types';
import { runSearch } from '../../src/search';

const { fakeDb, state } = vi.hoisted(() => {
  const state = {
    decisions: new Map<string, Decision>(),
    records: [] as SanctionRecord[],
  };

  const fakeDb = {
    collection: vi.fn((name: string) => {
      if (name === 'decisions') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const d = state.decisions.get(id);
              return { exists: Boolean(d), data: () => d, id };
            }),
          })),
          where: vi.fn((field: string, _op: string, value: string) => ({
            get: vi.fn(async () => {
              const matched = Array.from(state.decisions.values()).filter((d: any) => d[field] === value);
              return {
                forEach: (cb: any) => matched.forEach((item) => cb({ data: () => item })),
                docs: matched.map((item) => ({ data: () => item })),
              };
            }),
          })),
        };
      }
      if (name === 'sanctions') {
        return {
          doc: vi.fn((id: string) => ({
            get: vi.fn(async () => {
              const rec = state.records.find((r) => r.id === id);
              return { exists: Boolean(rec), data: () => rec, id };
            }),
          })),
          where: vi.fn(() => ({
            get: vi.fn(async () => ({
              docs: state.records.map((r) => ({ id: r.id, data: () => r })),
            })),
          })),
          get: vi.fn(async () => ({
            docs: state.records.map((r) => ({ id: r.id, data: () => r })),
          })),
        };
      }
      if (name === 'overrides') {
        return {
          get: vi.fn(async () => ({ docs: [] })),
        };
      }
      if (name === 'meta') {
        return {
          doc: vi.fn(() => ({
            get: vi.fn(async () => ({ exists: true, data: () => ({ value: 1 }) })),
          })),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }),
  };

  return { fakeDb, state };
});

vi.mock('../../src/shared/firebase', () => ({
  db: fakeDb,
}));

vi.mock('../../src/overrides', () => ({
  applyOverride: (r: any) => ({ record: r, overriddenFields: [] }),
  getAllOverrides: async () => new Map(),
}));

describe('Search with Customer Decision Memory (#320)', () => {
  const sampleSanction: SanctionRecord = {
    id: 'OFAC-100',
    source: 'US',
    type: 'individual',
    names: [{ wholeName: 'Vladimir Petrov', isPrimary: true }],
    searchNames: ['vladimir petrov'],
    createdAt: '2026-01-01T00:00:00Z',
    contentHash: 'hash_v100',
  };

  beforeEach(() => {
    state.decisions.clear();
    state.records = [sampleSanction];
    vi.clearAllMocks();
  });

  it('marks match as autoCleared when subjectId has valid false_positive decision', async () => {
    state.decisions.set('OFAC-100__cust-555', {
      entityId: 'OFAC-100',
      subjectId: 'cust-555',
      verdict: 'false_positive',
      decidedBy: 'compliance@bank.test',
      decidedAt: '2026-08-10T10:00:00Z',
      notes: 'Customer DOB is 1995',
      recordHash: 'hash_v100',
    });

    const response = await runSearch('Vladimir Petrov', {
      subjectId: 'cust-555',
    });

    expect(response.results).toHaveLength(1);
    const result = response.results[0];
    expect(result.autoCleared).toBe(true);
    expect(result.decisionValidity?.isValid).toBe(true);
    expect(result.decisionValidity?.status).toBe('valid');
    expect(result.decision?.decidedBy).toBe('compliance@bank.test');
  });

  it('suppresses false positive matches when suppressFalsePositives is true', async () => {
    state.decisions.set('OFAC-100__cust-555', {
      entityId: 'OFAC-100',
      subjectId: 'cust-555',
      verdict: 'false_positive',
      decidedBy: 'compliance@bank.test',
      decidedAt: '2026-08-10T10:00:00Z',
      notes: 'Customer DOB is 1995',
      recordHash: 'hash_v100',
    });

    const response = await runSearch('Vladimir Petrov', {
      subjectId: 'cust-555',
      suppressFalsePositives: true,
    });

    expect(response.results).toHaveLength(0);
  });

  it('invalidates auto-clearance and surfaces alert when entity contentHash has updated', async () => {
    // Decision was made on older version hash_v100_old
    state.decisions.set('OFAC-100__cust-555', {
      entityId: 'OFAC-100',
      subjectId: 'cust-555',
      verdict: 'false_positive',
      decidedBy: 'compliance@bank.test',
      decidedAt: '2026-08-10T10:00:00Z',
      recordHash: 'hash_v100_old',
    });

    const response = await runSearch('Vladimir Petrov', {
      subjectId: 'cust-555',
    });

    expect(response.results).toHaveLength(1);
    const result = response.results[0];
    expect(result.autoCleared).toBe(false);
    expect(result.decisionValidity?.isValid).toBe(false);
    expect(result.decisionValidity?.status).toBe('invalidated_data_changed');
  });
});
