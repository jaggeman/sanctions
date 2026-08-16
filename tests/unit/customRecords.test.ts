import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';
import { primaryNameOf } from '../../src/shared/types';

// Same fake-Firestore-doc pattern as tests/unit/api-search.test.ts: an
// in-memory store keyed by id, with collection('sanctions').doc(id) exposing
// get/set/delete against it.
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

// Not wired to any HTTP route yet, but these functions are the eventual
// attack surface: an id built from an untrusted source must never reach
// .doc(id) unvalidated (CLAUDE.md §6) — a "/" would silently address a
// different, unintended document nested in the collection hierarchy.
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
