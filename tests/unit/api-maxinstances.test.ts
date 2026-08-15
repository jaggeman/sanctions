import { describe, it, expect, vi } from 'vitest';

// Issue #16: OTP/session storage is in-memory, so a multi-instance Cloud
// Function deployment would fragment login state across instances. The
// interim mitigation is pinning maxInstances to 1 (documented, not silent) —
// verified here directly on the CloudFunction wrapper's __endpoint, which
// firebase-functions populates from the onRequest options at module load,
// no firebase-functions mock required.
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/search', () => ({
  runSearch: vi.fn(async () => ({ results: [], totalMatches: 0, truncated: false })),
}));

const { api } = await import('../../src/api');

describe('api Cloud Function export (issue #16)', () => {
  it('is pinned to a single instance while OTP/session storage is in-memory', () => {
    expect((api as any).__endpoint.maxInstances).toBe(1);
  });
});
