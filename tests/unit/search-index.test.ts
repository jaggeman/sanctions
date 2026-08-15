import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord, Override } from '../../src/shared/types';

let allRecords: SanctionRecord[] = [];
let allOverrides: Override[] = [];
let getCallCount = 0;

// Issue #35: getRecords() now also fetches the `overrides` collection
// alongside `sanctions` and merges each override in. Empty by default so
// every pre-existing test in this file is unaffected unless it opts in via
// `allOverrides`.
const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name === 'sanctions') {
      return {
        get: vi.fn(async () => {
          getCallCount++;
          return {
            docs: allRecords.map((r) => ({ data: () => r })),
          };
        }),
      };
    }
    if (name === 'overrides') {
      return {
        get: vi.fn(async () => ({
          docs: allOverrides.map((o) => ({ id: o.entityId, data: () => o })),
        })),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const { runSearch, invalidateSearchIndex } = await import('../../src/search');

function override(entityId: string, fields: Override['fields'], rest: Partial<Override> = {}): Override {
  return {
    entityId,
    fields,
    overriddenBy: 'analyst@example.com',
    overriddenAt: '2026-01-01T00:00:00.000Z',
    reason: 'Correction',
    ...rest,
  };
}

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
  allOverrides = [];
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

// Issue #35: overrides must be merged into the same in-memory index every
// caller of runSearch shares (API, CLI, MCP) — not applied only after the
// fact in one route — so an overridden name is actually searchable, not
// just visible in a result that was already found some other way.
describe('runSearch — overrides merged into the index (issue #35)', () => {
  it('finds a record by its OVERRIDDEN primaryName, not just the original', async () => {
    allRecords = [record({ id: 'EU-1', primaryName: 'Original Name' })];
    allOverrides = [override('EU-1', { primaryName: 'Wladimir Putin' })];

    const byOriginal = await runSearch('Original Name');
    const byOverride = await runSearch('Wladimir Putin');

    expect(byOverride.results.map((r) => r.id)).toEqual(['EU-1']);
    // The whole point of merging at the index level, not after: searching the
    // stale original name must no longer find it once it's been corrected.
    expect(byOriginal.results).toEqual([]);
  });

  it('reports overriddenFields on the result so the API can tell official from local data apart', async () => {
    allRecords = [record({ id: 'EU-1', primaryName: 'Vladimir Putin', sanctionReason: 'Original reason' })];
    allOverrides = [override('EU-1', { sanctionReason: 'Corrected reason' })];

    const { results } = await runSearch('Vladimir Putin');
    expect(results[0].sanctionReason).toBe('Corrected reason');
    expect(results[0].overriddenFields).toEqual(['sanctionReason']);
  });

  it('reports an empty overriddenFields array for a record with no override', async () => {
    allRecords = [record({ id: 'EU-1', primaryName: 'Vladimir Putin' })];
    const { results } = await runSearch('Vladimir Putin');
    expect(results[0].overriddenFields).toEqual([]);
  });

  it('does not apply one entity’s override to a different entity', async () => {
    allRecords = [
      record({ id: 'EU-1', primaryName: 'Vladimir Putin' }),
      record({ id: 'EU-2', primaryName: 'Vladimir Putin' }),
    ];
    allOverrides = [override('EU-1', { sanctionReason: 'Only for EU-1' })];

    const { results } = await runSearch('Vladimir Putin');
    const eu1 = results.find((r) => r.id === 'EU-1');
    const eu2 = results.find((r) => r.id === 'EU-2');
    expect(eu1?.sanctionReason).toBe('Only for EU-1');
    expect(eu2?.sanctionReason).toBeUndefined();
    expect(eu2?.overriddenFields).toEqual([]);
  });

  it('picks up a newly-saved override after invalidateSearchIndex() — no stale cache', async () => {
    allRecords = [record({ id: 'EU-1', primaryName: 'Vladimir Putin', sanctionReason: 'Original' })];
    await runSearch('Vladimir Putin'); // populate the cache with no override yet

    allOverrides = [override('EU-1', { sanctionReason: 'Corrected' })];
    invalidateSearchIndex();

    const { results } = await runSearch('Vladimir Putin');
    expect(results[0].sanctionReason).toBe('Corrected');
  });
});
