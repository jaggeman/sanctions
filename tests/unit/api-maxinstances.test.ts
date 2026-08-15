import { describe, it, expect, vi } from 'vitest';

// Issue #16 pinned maxInstances to 1 because OTP/session storage was an
// in-memory Map, which would fragment across concurrent Cloud Function
// instances. Issue #63 moved that storage to Firestore, so that half of the
// original reason is gone — but the pin STAYS regardless (see the comment
// on `export const api` in src/api/index.ts): src/search/index.ts's
// `cachedRecords` is a separate, still in-memory, per-instance cache that
// issue #43 hasn't yet made multi-instance-safe. Removing the pin before
// #43 lands would silently reintroduce stale search results on any instance
// that didn't run the most recent import. Verified here directly on the
// CloudFunction wrapper's __endpoint, which firebase-functions populates
// from the onRequest options at module load, no firebase-functions mock
// required.
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/search', () => ({
  runSearch: vi.fn(async () => ({ results: [], totalMatches: 0, truncated: false })),
}));

const { api } = await import('../../src/api');

describe('api Cloud Function export (issue #16, still pinned pending issue #43)', () => {
  it('is pinned to a single instance until the search index cache is also multi-instance-safe', () => {
    expect((api as any).__endpoint.maxInstances).toBe(1);
  });
});
