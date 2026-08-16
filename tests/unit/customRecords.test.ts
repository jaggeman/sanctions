import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';
import { primaryNameOf } from '../../src/shared/types';

// Same fake-Firestore-doc pattern as tests/unit/api-search.test.ts: an
// in-memory store keyed by id, with collection('sanctions').doc(id) exposing
// get/set/delete/create against it. `create` mimics the real Admin SDK:
// throws a gRPC-style ALREADY_EXISTS (code 6) error instead of silently
// overwriting — this is what lets createCustomRecord drop its own
// get-then-set race window and rely on Firestore's own atomicity instead.
let store: Record<string, SanctionRecord> = {};

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => ({
          exists: id in store,
          data: () => store[id],
        })),
        create: vi.fn(async (data: SanctionRecord) => {
          if (id in store) {
            const err: any = new Error(`ALREADY_EXISTS: ${id}`);
            err.code = 6;
            throw err;
          }
          store[id] = data;
        }),
        set: vi.fn(async (data: SanctionRecord) => {
          store[id] = data;
        }),
        delete: vi.fn(async () => {
          delete store[id];
        }),
      })),
    };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const invalidateSearchIndex = vi.fn(async () => {});
vi.mock('../../src/search', () => ({ invalidateSearchIndex }));

const {
  createCustomRecord,
  updateCustomRecord,
  deleteCustomRecord,
  getCustomRecord,
} = await import('../../src/customRecords');

function officialRecord(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    names: [{ wholeName: 'Official Person', strong: true }],
    searchNames: ['official', 'person'],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  store = {};
  vi.clearAllMocks();
});

describe('createCustomRecord', () => {
  it('creates a record with source forced to CUSTOM', async () => {
    const rec = await createCustomRecord({
      id: 'CUSTOM-1',
      type: 'individual',
      primaryName: 'Local Watchlist Entry',
    });

    expect(rec.source).toBe('CUSTOM');
    expect(store['CUSTOM-1'].source).toBe('CUSTOM');
  });

  it('generates searchNames from the primary name and aliases', async () => {
    const rec = await createCustomRecord({
      id: 'CUSTOM-1',
      type: 'individual',
      primaryName: 'Jane Doe',
      aliases: ['J. Doe'],
    });

    expect(rec.searchNames).toEqual(expect.arrayContaining(['jane', 'doe']));
  });

  it('stamps createdAt and updatedAt', async () => {
    const rec = await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    expect(rec.createdAt).toBeTruthy();
    expect(rec.updatedAt).toBeTruthy();
  });

  it('refuses to create a duplicate id, official or custom', async () => {
    store['EU-1'] = officialRecord();
    await expect(
      createCustomRecord({ id: 'EU-1', type: 'individual', primaryName: 'Attempted Overwrite' }),
    ).rejects.toThrow(/already exists/i);
    // The official record must survive the rejected attempt untouched.
    expect(primaryNameOf(store['EU-1'].names)).toBe('Official Person');
  });

  it('creates via an atomic create() rather than a get-then-set race window (TOCTOU fix, issue #172)', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });

    const docMock = fakeDb.collection.mock.results[0].value.doc.mock.results[0].value;
    expect(docMock.create).toHaveBeenCalledTimes(1);
    // The old bug was a separate get() existence check with a suspension
    // point between the read and the write — this must be gone entirely,
    // not merely unused.
    expect(docMock.get).not.toHaveBeenCalled();
    expect(docMock.set).not.toHaveBeenCalled();
  });

  it('calls invalidateSearchIndex after a successful create', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    expect(invalidateSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not call invalidateSearchIndex when create is rejected as a duplicate', async () => {
    store['EU-1'] = officialRecord();
    await expect(
      createCustomRecord({ id: 'EU-1', type: 'individual', primaryName: 'Attempted Overwrite' }),
    ).rejects.toThrow();
    expect(invalidateSearchIndex).not.toHaveBeenCalled();
  });
});

describe('updateCustomRecord', () => {
  it('throws when the record does not exist', async () => {
    await expect(updateCustomRecord('CUSTOM-404', { primaryName: 'x' })).rejects.toThrow(/no custom record/i);
  });

  it('refuses to edit a non-custom (official) record through this path', async () => {
    store['EU-1'] = officialRecord();
    await expect(updateCustomRecord('EU-1', { primaryName: 'x' })).rejects.toThrow(/not a custom record/i);
    expect(primaryNameOf(store['EU-1'].names)).toBe('Official Person');
  });

  it('updates fields and bumps updatedAt while preserving id/source/createdAt', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    const original = store['CUSTOM-1'];

    const updated = await updateCustomRecord('CUSTOM-1', { sanctionReason: 'Internal risk note' });

    expect(updated.id).toBe('CUSTOM-1');
    expect(updated.source).toBe('CUSTOM');
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.sanctionReason).toBe('Internal risk note');
  });

  it('regenerates searchNames when the name changes', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    const updated = await updateCustomRecord('CUSTOM-1', { primaryName: 'Janet Doe' });
    expect(updated.searchNames).toEqual(expect.arrayContaining(['janet']));
  });

  it('ignores id/source/createdAt smuggled into the patch — CustomRecordInput is not enforced at runtime', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    const original = store['CUSTOM-1'];

    // Simulates an untrusted HTTP body once this is wired into the API.
    const malicious = {
      id: 'CUSTOM-HACKED',
      source: 'EU',
      createdAt: '1999-01-01T00:00:00.000Z',
      primaryName: 'Still Jane Doe',
    } as any;

    const updated = await updateCustomRecord('CUSTOM-1', malicious);

    expect(updated.id).toBe('CUSTOM-1');
    expect(updated.source).toBe('CUSTOM');
    expect(updated.createdAt).toBe(original.createdAt);
    expect(store['CUSTOM-HACKED']).toBeUndefined();
  });

  it('re-pins searchNames even when only smuggled via patch — never trusts a client-supplied value (issue #172)', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });

    // A patch that doesn't touch primaryName/aliases at all, but tries to
    // set searchNames directly — this is exactly what would let an
    // untrusted caller control which queries match this record.
    const malicious = { searchNames: ['totally-unrelated-token'] } as any;
    const updated = await updateCustomRecord('CUSTOM-1', malicious);

    expect(updated.searchNames).not.toContain('totally-unrelated-token');
    expect(updated.searchNames).toEqual(expect.arrayContaining(['jane', 'doe']));
  });

  it('calls invalidateSearchIndex after a successful update', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    vi.clearAllMocks();
    await updateCustomRecord('CUSTOM-1', { sanctionReason: 'note' });
    expect(invalidateSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not call invalidateSearchIndex when the update target does not exist', async () => {
    await expect(updateCustomRecord('CUSTOM-404', { primaryName: 'x' })).rejects.toThrow();
    expect(invalidateSearchIndex).not.toHaveBeenCalled();
  });
});

describe('deleteCustomRecord', () => {
  it('refuses to delete without explicit confirm: true', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    await expect(deleteCustomRecord('CUSTOM-1', { confirm: false })).rejects.toThrow(/confirm/i);
    expect(store['CUSTOM-1']).toBeDefined();
  });

  it('throws when the record does not exist', async () => {
    await expect(deleteCustomRecord('CUSTOM-404', { confirm: true })).rejects.toThrow(/no custom record/i);
  });

  it('refuses to delete a non-custom (official) record through this path', async () => {
    store['EU-1'] = officialRecord();
    await expect(deleteCustomRecord('EU-1', { confirm: true })).rejects.toThrow(/not a custom record/i);
    expect(store['EU-1']).toBeDefined();
  });

  it('deletes the record when it exists, is CUSTOM, and confirm is true', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    await deleteCustomRecord('CUSTOM-1', { confirm: true });
    expect(store['CUSTOM-1']).toBeUndefined();
  });

  it('calls invalidateSearchIndex after a successful delete', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    vi.clearAllMocks();
    await deleteCustomRecord('CUSTOM-1', { confirm: true });
    expect(invalidateSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not call invalidateSearchIndex when delete is refused (missing confirm)', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    vi.clearAllMocks();
    await expect(deleteCustomRecord('CUSTOM-1', { confirm: false })).rejects.toThrow();
    expect(invalidateSearchIndex).not.toHaveBeenCalled();
  });
});

describe('getCustomRecord', () => {
  it('returns null when the record does not exist', async () => {
    expect(await getCustomRecord('CUSTOM-404')).toBeNull();
  });

  it('returns the record when it exists', async () => {
    await createCustomRecord({ id: 'CUSTOM-1', type: 'individual', primaryName: 'Jane Doe' });
    const rec = await getCustomRecord('CUSTOM-1');
    expect(rec && primaryNameOf(rec.names)).toBe('Jane Doe');
  });
});

// Wired to /api/admin/custom-records (issue #172) — an id coming straight
// from an untrusted request body/param must never reach .doc(id) unvalidated
// (CLAUDE.md §6) — a "/" would silently address a different, unintended
// document nested in the collection hierarchy. These module-level checks are
// a defense-in-depth backstop behind the router's own validateEntityIdParam.
describe('id validation', () => {
  const INVALID_ID = 'CUSTOM-1/../../admins/attacker@example.com';

  it('createCustomRecord rejects an invalid id without touching Firestore', async () => {
    await expect(
      createCustomRecord({ id: INVALID_ID, type: 'individual', primaryName: 'Jane Doe' }),
    ).rejects.toThrow(/invalid/i);
    expect(store[INVALID_ID]).toBeUndefined();
  });

  it('updateCustomRecord rejects an invalid id without touching Firestore', async () => {
    await expect(updateCustomRecord(INVALID_ID, { primaryName: 'x' })).rejects.toThrow(/invalid/i);
  });

  it('deleteCustomRecord rejects an invalid id without touching Firestore', async () => {
    await expect(deleteCustomRecord(INVALID_ID, { confirm: true })).rejects.toThrow(/invalid/i);
  });

  it('getCustomRecord rejects an invalid id without touching Firestore', async () => {
    await expect(getCustomRecord(INVALID_ID)).rejects.toThrow(/invalid/i);
  });
});
