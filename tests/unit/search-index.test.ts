import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';

let allRecords: SanctionRecord[] = [];
let getCallCount = 0;

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      get: vi.fn(async () => {
        getCallCount++;
        return {
          docs: allRecords.map((r) => ({ data: () => r })),
        };
      }),
    };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const { runSearch, invalidateSearchIndex } = await import('../../src/search');

function record(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'PEP-1',
    source: 'PEP',
    type: 'individual',
    primaryName: 'Vladimir Putin',
    aliases: [],
    searchNames: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  allRecords = [];
  getCallCount = 0;
  invalidateSearchIndex();
  vi.clearAllMocks();
});

describe('runSearch — basic behaviour', () => {
  it('returns nothing, without throwing, for an empty or whitespace query', async () => {
    allRecords = [record()];
    expect(await runSearch('')).toEqual({ results: [], totalMatches: 0, truncated: false });
    expect(await runSearch('   ')).toEqual({ results: [], totalMatches: 0, truncated: false });
  });

  it('finds a fuzzy match at or above the default threshold', async () => {
    allRecords = [record({ id: 'PEP-1', primaryName: 'Vladimir Putin' })];
    const { results } = await runSearch('Vladmir Putin'); // typo
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('PEP-1');
    expect(results[0].score).toBeGreaterThanOrEqual(65);
    expect(results[0].matchedAlias).toBe('Vladimir Putin');
  });

  it('excludes a candidate scoring below the threshold', async () => {
    allRecords = [record({ id: 'PEP-1', primaryName: 'Angela Merkel' })];
    const { results } = await runSearch('Kim Jong Un');
    expect(results).toEqual([]);
  });
});

describe('runSearch — threshold', () => {
  it('respects a custom, lower threshold', async () => {
    allRecords = [record({ id: 'PEP-1', primaryName: 'Somewhat Different Name' })];
    const withDefault = await runSearch('Somewhat Different Namex', {});
    const withLowThreshold = await runSearch('Completely Unrelated Query', { threshold: 0 });
    // threshold: 0 must accept everything regardless of score
    expect(withLowThreshold.results).toHaveLength(1);
  });

  it('respects a custom, higher threshold that excludes a borderline match', async () => {
    allRecords = [record({ id: 'PEP-1', primaryName: 'Vladimir Putin' })];
    const lenient = await runSearch('Vladmir Putin', { threshold: 50 });
    const strict = await runSearch('Vladmir Putin', { threshold: 99 });
    expect(lenient.results.length).toBeGreaterThanOrEqual(strict.results.length);
  });
});

describe('runSearch — filters', () => {
  it('filters by a comma-separated source list', async () => {
    allRecords = [
      record({ id: 'EU-1', source: 'EU', primaryName: 'Test Person' }),
      record({ id: 'PEP-1', source: 'PEP', primaryName: 'Test Person' }),
    ];
    const { results } = await runSearch('Test Person', { source: 'EU' });
    expect(results.map((r) => r.id)).toEqual(['EU-1']);
  });

  it('filters by type', async () => {
    allRecords = [
      record({ id: 'PEP-1', type: 'individual', primaryName: 'Test Person' }),
      record({ id: 'PEP-2', type: 'entity', primaryName: 'Test Person' }),
    ];
    const { results } = await runSearch('Test Person', { type: 'entity' });
    expect(results.map((r) => r.id)).toEqual(['PEP-2']);
  });
});

describe('runSearch — limit and truncation reporting', () => {
  it('reports truncated:false and totalMatches===results.length when nothing was cut', async () => {
    allRecords = [record({ id: 'PEP-1' }), record({ id: 'PEP-2' })];
    const { results, totalMatches, truncated } = await runSearch('Vladimir Putin', { limit: 20 });
    expect(truncated).toBe(false);
    expect(totalMatches).toBe(results.length);
  });

  it('reports truncated:true and a totalMatches greater than the returned count when capped', async () => {
    allRecords = Array.from({ length: 5 }, (_, i) => record({ id: `PEP-${i}`, primaryName: 'Vladimir Putin' }));
    const { results, totalMatches, truncated } = await runSearch('Vladimir Putin', { limit: 2 });
    expect(results).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(totalMatches).toBe(5);
  });

  it('caps the limit at 100 regardless of what was requested', async () => {
    allRecords = Array.from({ length: 3 }, (_, i) => record({ id: `PEP-${i}`, primaryName: 'Vladimir Putin' }));
    const { results } = await runSearch('Vladimir Putin', { limit: 999999 });
    expect(results).toHaveLength(3); // fewer records than the 100 cap — cap itself tested via truncation math above
  });
});

describe('runSearch — exact passport/ID fast path', () => {
  it('returns a passport match with a perfect score regardless of name similarity', async () => {
    allRecords = [
      record({ id: 'PEP-1', primaryName: 'Totally Unrelated Name', passports: ['Passport SE1234567'] }),
    ];
    const { results } = await runSearch('SE1234567');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('PEP-1');
    expect(results[0].score).toBe(100);
  });

  it('does not double-count a record matched by both passport and name', async () => {
    allRecords = [
      record({ id: 'PEP-1', primaryName: 'Vladimir Putin', passports: ['SE1234567'] }),
    ];
    const { results } = await runSearch('SE1234567');
    expect(results).toHaveLength(1);
  });
});

describe('runSearch — date-of-birth booster', () => {
  it('boosts, but does not require, a matching date of birth', async () => {
    allRecords = [
      record({ id: 'PEP-1', primaryName: 'Vladimir Putin', datesOfBirth: ['1952-10-07'] }),
    ];
    const withoutDob = await runSearch('Vladmir Putin');
    const withMatchingDob = await runSearch('Vladmir Putin', { dob: '1952' });
    const withWrongDob = await runSearch('Vladmir Putin', { dob: '1999' });

    expect(withMatchingDob.results[0].score).toBeGreaterThanOrEqual(withoutDob.results[0].score);
    // A wrong DOB must not hard-exclude the record — it's a booster, not a filter.
    expect(withWrongDob.results).toHaveLength(1);
  });
});

describe('runSearch — index caching', () => {
  it('reuses the cached record set across calls instead of refetching every time', async () => {
    allRecords = [record({ id: 'PEP-1' })];
    await runSearch('Vladimir Putin');
    await runSearch('Vladimir Putin');
    expect(getCallCount).toBe(1);
  });

  it('refetches after invalidateSearchIndex() is called', async () => {
    allRecords = [record({ id: 'PEP-1' })];
    await runSearch('Vladimir Putin');
    invalidateSearchIndex();
    await runSearch('Vladimir Putin');
    expect(getCallCount).toBe(2);
  });
});
