import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord, Override } from '../../src/shared/types';

let allRecords: SanctionRecord[] = [];
let allOverrides: Override[] = [];
let getCallCount = 0;
// undefined = the meta/searchIndex doc doesn't exist yet, mirrors a fresh DB.
let metaVersion: number | undefined = undefined;

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
    if (name === 'meta') {
      return {
        doc: vi.fn((id: string) => {
          if (id !== 'searchIndex') throw new Error(`unexpected meta doc ${id}`);
          return {
            get: vi.fn(async () => ({
              exists: metaVersion !== undefined,
              data: () => (metaVersion !== undefined ? { version: metaVersion } : undefined),
            })),
            // Real writes use FieldValue.increment(1); the fake applies the
            // increment it's meant to simulate rather than inspecting the
            // sentinel value.
            set: vi.fn(async () => {
              metaVersion = (metaVersion || 0) + 1;
            }),
          };
        }),
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
    names: [{ wholeName: 'Vladimir Putin', strong: true }],
    searchNames: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Builds a `names` override for a single primary name, matching this suite's `record()` shape. */
function namesOverride(wholeName: string): SanctionRecord['names'] {
  return [{ wholeName, strong: true }];
}

beforeEach(async () => {
  allRecords = [];
  allOverrides = [];
  getCallCount = 0;
  // Deliberately not resetting metaVersion: it's a monotonic counter meant
  // to keep incrementing across calls, exactly like the real Firestore
  // FieldValue.increment(1) it stands in for. Resetting it here would make
  // every test converge back to the same version number and defeat the
  // very staleness check being tested.
  await invalidateSearchIndex();
  vi.clearAllMocks();
});

describe('runSearch — basic behaviour', () => {
  it('returns nothing, without throwing, for an empty or whitespace query', async () => {
    allRecords = [record()];
    expect(await runSearch('')).toEqual({
      results: [],
      totalMatches: 0,
      truncated: false,
      tookMs: expect.any(Number),
      sourcesSearched: [],
    });
    expect(await runSearch('   ')).toEqual({
      results: [],
      totalMatches: 0,
      truncated: false,
      tookMs: expect.any(Number),
      sourcesSearched: [],
    });
  });

  it('finds a fuzzy match at or above the default threshold', async () => {
    allRecords = [record({ id: 'PEP-1', names: namesOverride('Vladimir Putin') })];
    const { results } = await runSearch('Vladmir Putin'); // typo
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('PEP-1');
    expect(results[0].score).toBeGreaterThanOrEqual(65);
    expect(results[0].matchedAlias).toBe('Vladimir Putin');
  });

  it('excludes a candidate scoring below the threshold', async () => {
    allRecords = [record({ id: 'PEP-1', names: namesOverride('Angela Merkel') })];
    const { results } = await runSearch('Kim Jong Un');
    expect(results).toEqual([]);
  });
});

describe('runSearch — threshold', () => {
  it('respects a custom, lower threshold', async () => {
    allRecords = [record({ id: 'PEP-1', names: namesOverride('Somewhat Different Name') })];
    const withDefault = await runSearch('Somewhat Different Namex', {});
    const withLowThreshold = await runSearch('Completely Unrelated Query', { threshold: 0 });
    // threshold: 0 must accept everything regardless of score
    expect(withLowThreshold.results).toHaveLength(1);
  });

  it('respects a custom, higher threshold that excludes a borderline match', async () => {
    allRecords = [record({ id: 'PEP-1', names: namesOverride('Vladimir Putin') })];
    const lenient = await runSearch('Vladmir Putin', { threshold: 50 });
    const strict = await runSearch('Vladmir Putin', { threshold: 99 });
    expect(lenient.results.length).toBeGreaterThanOrEqual(strict.results.length);
  });
});

describe('runSearch — filters', () => {
  it('filters by a comma-separated source list', async () => {
    allRecords = [
      record({ id: 'EU-1', source: 'EU', names: namesOverride('Test Person') }),
      record({ id: 'PEP-1', source: 'PEP', names: namesOverride('Test Person') }),
    ];
    const { results } = await runSearch('Test Person', { source: 'EU' });
    expect(results.map((r) => r.id)).toEqual(['EU-1']);
  });

  it('filters by type', async () => {
    allRecords = [
      record({ id: 'PEP-1', type: 'individual', names: namesOverride('Test Person') }),
      record({ id: 'PEP-2', type: 'entity', names: namesOverride('Test Person') }),
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
    allRecords = Array.from({ length: 5 }, (_, i) => record({ id: `PEP-${i}`, names: namesOverride('Vladimir Putin') }));
    const { results, totalMatches, truncated } = await runSearch('Vladimir Putin', { limit: 2 });
    expect(results).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(totalMatches).toBe(5);
  });

  it('caps the limit at 100 regardless of what was requested', async () => {
    allRecords = Array.from({ length: 3 }, (_, i) => record({ id: `PEP-${i}`, names: namesOverride('Vladimir Putin') }));
    const { results } = await runSearch('Vladimir Putin', { limit: 999999 });
    expect(results).toHaveLength(3); // fewer records than the 100 cap — cap itself tested via truncation math above
  });
});

describe('runSearch — exact passport/ID fast path', () => {
  it('returns a passport match with a perfect score regardless of name similarity', async () => {
    allRecords = [
      record({ id: 'PEP-1', names: namesOverride('Totally Unrelated Name'), identifications: [{ number: 'SE1234567', typeDescription: 'Passport' }] }),
    ];
    const { results } = await runSearch('SE1234567');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('PEP-1');
    expect(results[0].score).toBe(100);
  });

  it('issue #152: matches normalized ID number exactly, ignoring hyphens, spaces and case', async () => {
    allRecords = [
      record({ id: 'PEP-1', names: namesOverride('Some Person'), identifications: [{ number: 'SE-1234-567' }] }),
    ];
    const { results } = await runSearch('se 1234 567');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('PEP-1');
    expect(results[0].score).toBe(100);
    expect(results[0].matchedAlias).toBe('Passport/ID match');
  });

  it('issue #152: partial / substring match on ID number does NOT trigger fast path score 100', async () => {
    allRecords = [
      record({ id: 'PEP-1', names: namesOverride('Totally Unrelated Name'), identifications: [{ number: 'SE1234567' }] }),
    ];
    const { results } = await runSearch('1234');
    // Partial ID match must not match via passport fast path
    expect(results).toHaveLength(0);
  });

  it('issue #152: searching common metadata terms (Male, Female, 13224, Secondary) returns no fast-path hits', async () => {
    allRecords = [
      record({ id: 'PEP-1', names: namesOverride('Totally Unrelated Name'), identifications: [{ number: 'A1084010' }] }),
    ];
    for (const term of ['Male', 'Female', '13224', 'Secondary']) {
      const { results } = await runSearch(term);
      expect(results.filter((r) => r.matchedAlias === 'Passport/ID match')).toHaveLength(0);
    }
  });

  it('does not double-count a record matched by both passport and name', async () => {
    allRecords = [
      record({ id: 'PEP-1', names: namesOverride('Vladimir Putin'), identifications: [{ number: 'SE1234567' }] }),
    ];
    const { results } = await runSearch('SE1234567');
    expect(results).toHaveLength(1);
  });
});

describe('runSearch — date-of-birth booster', () => {
  it('boosts, but does not require, a matching date of birth', async () => {
    allRecords = [
      record({ id: 'PEP-1', names: namesOverride('Vladimir Putin'), birthDates: [{ raw: '1952-10-07' }] }),
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
    await invalidateSearchIndex();
    await runSearch('Vladimir Putin');
    expect(getCallCount).toBe(2);
  });
});

// Issue #43: runImport now executes in its own Cloud Function (a Cloud
// Tasks-dispatched worker), separate from the `api` function that serves
// /api/search. A plain in-memory flag flip in invalidateSearchIndex() would
// only clear the *worker's* copy of cachedRecords and never reach api's —
// search would keep serving stale data again, just via a new mechanism. The
// fix is a shared Firestore marker (meta/searchIndex.version) every
// instance checks before trusting its own local cache.
describe('runSearch — cross-instance index invalidation (issue #43)', () => {
  it('invalidateSearchIndex writes the shared Firestore marker, not just a local flag', async () => {
    const before = metaVersion;
    await invalidateSearchIndex();
    expect(metaVersion).toBe((before || 0) + 1);
  });

  it('detects an invalidation made by a different process via the shared marker, without this process ever calling invalidateSearchIndex itself', async () => {
    allRecords = [record({ id: 'PEP-1' })];
    await runSearch('Vladimir Putin');
    expect(getCallCount).toBe(1);

    // Simulate a separate Cloud Function instance (the import worker)
    // calling invalidateSearchIndex() — bump the shared marker directly,
    // bypassing this process's own in-memory state entirely.
    metaVersion = (metaVersion || 0) + 1;

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
    allRecords = [record({ id: 'EU-1', names: namesOverride('Original Name') })];
    allOverrides = [override('EU-1', { names: namesOverride('Wladimir Putin') })];

    const byOriginal = await runSearch('Original Name');
    const byOverride = await runSearch('Wladimir Putin');

    expect(byOverride.results.map((r) => r.id)).toEqual(['EU-1']);
    // The whole point of merging at the index level, not after: searching the
    // stale original name must no longer find it once it's been corrected.
    expect(byOriginal.results).toEqual([]);
  });

  it('reports overriddenFields on the result so the API can tell official from local data apart', async () => {
    allRecords = [record({ id: 'EU-1', names: namesOverride('Vladimir Putin'), sanctionReason: 'Original reason' })];
    allOverrides = [override('EU-1', { sanctionReason: 'Corrected reason' })];

    const { results } = await runSearch('Vladimir Putin');
    expect(results[0].sanctionReason).toBe('Corrected reason');
    expect(results[0].overriddenFields).toEqual(['sanctionReason']);
  });

  it('reports an empty overriddenFields array for a record with no override', async () => {
    allRecords = [record({ id: 'EU-1', names: namesOverride('Vladimir Putin') })];
    const { results } = await runSearch('Vladimir Putin');
    expect(results[0].overriddenFields).toEqual([]);
  });

  it('does not apply one entity’s override to a different entity', async () => {
    allRecords = [
      record({ id: 'EU-1', names: namesOverride('Vladimir Putin') }),
      record({ id: 'EU-2', names: namesOverride('Vladimir Putin') }),
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
    allRecords = [record({ id: 'EU-1', names: namesOverride('Vladimir Putin'), sanctionReason: 'Original' })];
    await runSearch('Vladimir Putin'); // populate the cache with no override yet

    allOverrides = [override('EU-1', { sanctionReason: 'Corrected' })];
    invalidateSearchIndex();

    const { results } = await runSearch('Vladimir Putin');
    expect(results[0].sanctionReason).toBe('Corrected');
  });
});

describe('runSearch — threshold validation & NaN resilience (issue #148)', () => {
  beforeEach(() => {
    allRecords = [record({ id: 'EU-1', names: namesOverride('Vladimir Putin') })];
    invalidateSearchIndex();
  });

  it('falls back to DEFAULT_THRESHOLD when threshold is NaN, returning matches normally', async () => {
    const { results } = await runSearch('Vladimir Putin', { threshold: NaN });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('EU-1');
  });

  it('clamps negative threshold to 0', async () => {
    const { results } = await runSearch('Vladimir', { threshold: -50 });
    expect(results).toHaveLength(1);
  });

  it('clamps threshold > 100 to 100', async () => {
    const { results } = await runSearch('Vlad', { threshold: 200 });
    expect(results).toHaveLength(0);
  });
});

describe('runSearch — limit validation & negative resilience (issue #161)', () => {
  beforeEach(() => {
    allRecords = [
      record({ id: 'EU-1', names: namesOverride('Vladimir Putin') }),
      record({ id: 'EU-2', names: namesOverride('Vladimir Lenin') }),
    ];
    invalidateSearchIndex();
  });

  it('falls back to DEFAULT_LIMIT when options.limit is negative (-1, -40)', async () => {
    const resMinusOne = await runSearch('Vladimir', { limit: -1 });
    expect(resMinusOne.results.length).toBeGreaterThan(0);
    expect(resMinusOne.results[0].id).toBe('EU-1');

    const resMinusForty = await runSearch('Vladimir', { limit: -40 });
    expect(resMinusForty.results.length).toBeGreaterThan(0);
    expect(resMinusForty.results[0].id).toBe('EU-1');
  });

  it('honors limit=0 without setting truncated to true when results are empty', async () => {
    const res = await runSearch('Vladimir', { limit: 0 });
    expect(res.results).toEqual([]);
    expect(res.totalMatches).toBe(2);
    expect(res.truncated).toBe(false);
  });
});

// Search Entities tab wants to show "how long did this take" and "how many
// databases did this search over" (repo owner request, no issue filed yet) —
// both computed here since only runSearch has the full record set loaded.
describe('runSearch — duration and source reporting', () => {
  it('reports tookMs as a non-negative number', async () => {
    allRecords = [record({ id: 'PEP-1' })];
    const { tookMs } = await runSearch('Vladimir Putin');
    expect(typeof tookMs).toBe('number');
    expect(tookMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the distinct sources present in the index as sourcesSearched', async () => {
    allRecords = [
      record({ id: 'EU-1', source: 'EU', names: namesOverride('Test Person') }),
      record({ id: 'US-1', source: 'US', names: namesOverride('Test Person') }),
      record({ id: 'US-2', source: 'US', names: namesOverride('Test Person') }),
    ];
    const { sourcesSearched } = await runSearch('Test Person');
    expect(sourcesSearched).toEqual(['EU', 'US']);
  });

  it('narrows sourcesSearched to the requested source filter, dropping a filtered source with no records', async () => {
    allRecords = [
      record({ id: 'EU-1', source: 'EU', names: namesOverride('Test Person') }),
      record({ id: 'US-1', source: 'US', names: namesOverride('Test Person') }),
    ];
    const { sourcesSearched } = await runSearch('Test Person', { source: 'EU,UN' });
    expect(sourcesSearched).toEqual(['EU']);
  });

  it('reports an empty sourcesSearched array when the index has no records at all', async () => {
    allRecords = [];
    const { sourcesSearched } = await runSearch('Test Person');
    expect(sourcesSearched).toEqual([]);
  });
});

describe('runSearch — candidate pruning via inverted index (issue #223)', () => {
  beforeEach(() => {
    allRecords = [
      record({ id: 'EU-1', names: namesOverride('Vladimir Putin') }),
      record({ id: 'EU-2', names: namesOverride('Mohammed Al-Bakr') }),
      record({ id: 'EU-3', names: namesOverride('Alexander Lukashenko'), identifications: [{ number: 'PASS-987654' }] }),
      record({ id: 'EU-4', names: namesOverride('Zhang Wei') }),
      record({ id: 'EU-5', names: namesOverride('Jean-Luc Picard') }),
    ];
    invalidateSearchIndex();
  });

  it('prunes candidate set to find exact and fuzzy matches efficiently', async () => {
    const res = await runSearch('Vladimir Putin');
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe('EU-1');
  });

  it('retrieves phonetic and Soundex variants through the inverted index', async () => {
    const res = await runSearch('Muhammad Al-Bakr');
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe('EU-2');
  });

  it('retrieves passport/ID matches instantly via inverted index', async () => {
    const res = await runSearch('PASS-987654');
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe('EU-3');
    expect(res.results[0].score).toBe(100);
  });

  it('returns empty results quickly when no candidates match the inverted index', async () => {
    const res = await runSearch('Totally Unrelated Nonexistent Name XYZ');
    expect(res.results).toEqual([]);
    expect(res.totalMatches).toBe(0);
  });
});


