import { describe, it, expect, vi } from 'vitest';

// Issue #16 pinned maxInstances to 1 because OTP/session storage was an
// in-memory Map, which would fragment across concurrent Cloud Function
// instances. Issue #63 moved that storage to Firestore, and issue #43 later
// added a Firestore-backed `meta/searchIndex.version` counter that
// src/search/index.ts's getRecords() checks before trusting its own
// in-memory cache — so a search served by any instance now picks up an
// invalidation regardless of which instance ran the import. Both reasons
// for the pin are gone (issue #101): `api` is no longer pinned to a single
// instance.
//
// Asserting `.not.toBe(1)` rather than `.toBeUndefined()`: firebase-functions
// represents an explicitly-unset option as a `ResetValue` sentinel object,
// not a bare `undefined`, when no `maxInstances` is passed to onRequest at
// all. Verified here directly on the CloudFunction wrapper's __endpoint,
// which firebase-functions populates from the onRequest options at module
// load, no firebase-functions mock required.
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/search', () => ({
  runSearch: vi.fn(async () => ({ results: [], totalMatches: 0, truncated: false })),
}));

const { api } = await import('../../src/api');

describe('api Cloud Function export (issue #101)', () => {
  it('is no longer pinned to a single instance', () => {
    expect((api as any).__endpoint.maxInstances).not.toBe(1);
  });
});
