import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #35: overrides/index.ts now also persists (getOverride/saveOverride/
// deleteOverride), so it needs `db`. Same in-memory-doc fake as
// tests/unit/customRecords.test.ts — applyOverride itself stays pure and
// untouched by this mock. Issue #112: each doc also gets a `history`
// subcollection (auto-id docs, queried via `.orderBy('changedAt', 'desc')`),
// tracked here as an insertion-ordered array per doc id.
let store: Record<string, unknown> = {};
let historyStore: Record<string, unknown[]> = {};

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'overrides') throw new Error(`unexpected collection ${name}`);
    return {
      doc: vi.fn((id: string) => ({
        get: vi.fn(async () => ({
          exists: id in store,
          data: () => store[id],
        })),
        set: vi.fn(async (data: unknown) => {
          store[id] = data;
        }),
        delete: vi.fn(async () => {
          delete store[id];
        }),
        collection: vi.fn((subName: string) => {
          if (subName !== 'history') throw new Error(`unexpected subcollection ${subName}`);
          if (!historyStore[id]) historyStore[id] = [];
          return {
            doc: vi.fn(() => ({
              set: vi.fn(async (data: unknown) => {
                historyStore[id].push(data);
              }),
            })),
            orderBy: vi.fn((field: string) => {
              if (field !== 'changedAt') throw new Error(`unexpected orderBy(${field})`);
              return {
                get: vi.fn(async () => ({
                  docs: (historyStore[id] || []).slice().reverse().map((h) => ({ data: () => h })),
                })),
              };
            }),
          };
        }),
      })),
    };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const {
  applyOverride,
  getOverride,
  saveOverride,
  deleteOverride,
  getOverrideHistory,
  IMMUTABLE_KEYS,
} = await import('../../src/overrides');
import type { SanctionRecord, Override } from '../../src/shared/types';

beforeEach(() => {
  store = {};
  historyStore = {};
  vi.clearAllMocks();
});

function record(overrides: Partial<SanctionRecord> = {}): SanctionRecord {
  return {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    primaryName: 'Vladimir Putin',
    aliases: ['Vladimir Vladimirovich Putin'],
    searchNames: ['vladimir', 'putin', 'vladimirovich'],
    sanctionReason: 'Original official reason',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function override(fields: Override['fields'], rest: Partial<Override> = {}): Override {
  return {
    entityId: 'EU-1',
    fields,
    overriddenBy: 'analyst@example.com',
    overriddenAt: '2026-08-15T00:00:00.000Z',
    reason: 'Corrected transliteration',
    ...rest,
  };
}

describe('applyOverride', () => {
  it('returns the record unchanged when there is no override', () => {
    const rec = record();
    const result = applyOverride(rec, null);
    expect(result.record).toEqual(rec);
    expect(result.overriddenFields).toEqual([]);
  });

  it('returns the record unchanged when the override has no fields', () => {
    const rec = record();
    const result = applyOverride(rec, undefined);
    expect(result.record).toEqual(rec);
    expect(result.overriddenFields).toEqual([]);
  });

  it('overlays a single overridden field on top of the source record', () => {
    const rec = record();
    const result = applyOverride(rec, override({ sanctionReason: 'Corrected reason from analyst' }));

    expect(result.record.sanctionReason).toBe('Corrected reason from analyst');
    expect(result.overriddenFields).toEqual(['sanctionReason']);
    // Every other field stays exactly as the source record had it.
    expect(result.record.primaryName).toBe(rec.primaryName);
  });

  it('never mutates the input record — reversibility depends on the source staying pristine', () => {
    const rec = record();
    const snapshot = JSON.parse(JSON.stringify(rec));
    applyOverride(rec, override({ primaryName: 'Changed Name' }));
    expect(rec).toEqual(snapshot);
  });

  it('regenerates searchNames when primaryName is overridden, so the new name is searchable', () => {
    const rec = record();
    const result = applyOverride(rec, override({ primaryName: 'Wladimir Putin' }));
    expect(result.record.searchNames).toContain('wladimir');
  });

  it('regenerates searchNames when aliases are overridden', () => {
    const rec = record();
    const result = applyOverride(rec, override({ aliases: ['New Alias Name'] }));
    expect(result.record.searchNames).toContain('alias');
  });

  it('does not report searchNames itself as an overridden field — it is a derived side effect', () => {
    const rec = record();
    const result = applyOverride(rec, override({ primaryName: 'Wladimir Putin' }));
    expect(result.overriddenFields).toEqual(['primaryName']);
  });

  it('ignores an attempt to override immutable identity fields (id, source, type, createdAt)', () => {
    const rec = record();
    const result = applyOverride(rec, override({
      id: 'HACKED-ID',
      source: 'CUSTOM',
      type: 'entity',
      createdAt: '1999-01-01T00:00:00.000Z',
    } as any));

    expect(result.record.id).toBe(rec.id);
    expect(result.record.source).toBe(rec.source);
    expect(result.record.type).toBe(rec.type);
    expect(result.record.createdAt).toBe(rec.createdAt);
    expect(result.overriddenFields).toEqual([]);
  });

  it('cannot resurrect a delisted record — status stays in IMMUTABLE_KEYS now that RecordStatus is real (issue #35)', () => {
    const rec = record({ status: 'delisted', delistedAt: '2026-01-01T00:00:00.000Z' });
    const result = applyOverride(rec, override({ status: 'active' } as any));
    expect(result.record.status).toBe('delisted');
    expect(result.overriddenFields).toEqual([]);
  });

  it('skips explicitly-undefined override values rather than blanking the field', () => {
    const rec = record();
    const result = applyOverride(rec, override({ sanctionReason: undefined }));
    expect(result.record.sanctionReason).toBe(rec.sanctionReason);
    expect(result.overriddenFields).toEqual([]);
  });

  it('applies multiple overridden fields at once and reports all of them', () => {
    const rec = record();
    const result = applyOverride(rec, override({
      sanctionReason: 'New reason',
      legalBasis: 'New legal basis',
    }));

    expect(result.record.sanctionReason).toBe('New reason');
    expect(result.record.legalBasis).toBe('New legal basis');
    expect(result.overriddenFields.sort()).toEqual(['legalBasis', 'sanctionReason']);
  });
});

describe('IMMUTABLE_KEYS', () => {
  it('is exported for reuse by the write-time validation in the CRUD route', () => {
    expect(IMMUTABLE_KEYS.has('id')).toBe(true);
    expect(IMMUTABLE_KEYS.has('source')).toBe(true);
    expect(IMMUTABLE_KEYS.has('type')).toBe(true);
    expect(IMMUTABLE_KEYS.has('createdAt')).toBe(true);
    expect(IMMUTABLE_KEYS.has('searchNames')).toBe(true);
    expect(IMMUTABLE_KEYS.has('status')).toBe(true);
  });
});

describe('getOverride', () => {
  it('returns null when no override exists for the entity', async () => {
    expect(await getOverride('EU-1')).toBeNull();
  });

  it('returns the stored override when one exists', async () => {
    store['EU-1'] = { entityId: 'EU-1', fields: { sanctionReason: 'x' }, overriddenBy: 'a@example.com', overriddenAt: '2026-01-01T00:00:00.000Z', reason: 'r' };
    const result = await getOverride('EU-1');
    expect(result?.entityId).toBe('EU-1');
    expect(result?.fields.sanctionReason).toBe('x');
  });
});

describe('saveOverride', () => {
  it('creates a new override document keyed by entityId', async () => {
    const result = await saveOverride('EU-1', { sanctionReason: 'Corrected' }, {
      overriddenBy: 'analyst@example.com',
      reason: 'Transliteration fix',
    });

    expect(result.entityId).toBe('EU-1');
    expect(result.fields).toEqual({ sanctionReason: 'Corrected' });
    expect(result.overriddenBy).toBe('analyst@example.com');
    expect(result.reason).toBe('Transliteration fix');
    expect(result.overriddenAt).toBeTruthy();
    expect(store['EU-1']).toEqual(result);
  });

  it('replaces an existing override (upsert) rather than merging field-by-field', async () => {
    await saveOverride('EU-1', { sanctionReason: 'First' }, { overriddenBy: 'a@example.com', reason: 'r1' });
    await saveOverride('EU-1', { legalBasis: 'New basis' }, { overriddenBy: 'b@example.com', reason: 'r2' });

    const result = await getOverride('EU-1');
    // The first override's field is gone — saveOverride replaces, it doesn't merge.
    expect(result?.fields).toEqual({ legalBasis: 'New basis' });
    expect(result?.overriddenBy).toBe('b@example.com');
  });
});

describe('deleteOverride', () => {
  it('removes an existing override', async () => {
    await saveOverride('EU-1', { sanctionReason: 'x' }, { overriddenBy: 'a@example.com', reason: 'r' });
    await deleteOverride('EU-1', 'reviewer@example.com');
    expect(await getOverride('EU-1')).toBeNull();
  });

  it('does not throw when there is nothing to delete (idempotent)', async () => {
    await expect(deleteOverride('DOES-NOT-EXIST', 'reviewer@example.com')).resolves.toBeUndefined();
  });
});

describe('append-only history (issue #112)', () => {
  it('saveOverride writes a "created" history entry the first time', async () => {
    const result = await saveOverride('EU-1', { sanctionReason: 'Corrected' }, {
      overriddenBy: 'analyst@example.com',
      reason: 'Fix',
    });

    const history = await getOverrideHistory('EU-1');
    expect(history).toHaveLength(1);
    expect(history[0].changeType).toBe('created');
    expect(history[0].changedBy).toBe('analyst@example.com');
    expect(history[0].override).toEqual(result);
  });

  it('saveOverride writes a "replaced" entry on a second edit, keeping the first fields/author/reason recoverable', async () => {
    await saveOverride('EU-1', { sanctionReason: 'First correction' }, { overriddenBy: 'a@example.com', reason: 'r1' });
    await saveOverride('EU-1', { legalBasis: 'New basis' }, { overriddenBy: 'b@example.com', reason: 'r2' });

    const history = await getOverrideHistory('EU-1');
    expect(history).toHaveLength(2);
    // Most recent first.
    expect(history[0].changeType).toBe('replaced');
    expect(history[0].override.fields).toEqual({ legalBasis: 'New basis' });
    expect(history[1].changeType).toBe('created');
    // The first override's own field/author/reason are recoverable here,
    // even though the current-state doc (getOverride) no longer has them —
    // that upsert-replaces behavior is unchanged (see the saveOverride
    // describe block above).
    expect(history[1].override.fields).toEqual({ sanctionReason: 'First correction' });
    expect(history[1].override.overriddenBy).toBe('a@example.com');
    expect(history[1].override.reason).toBe('r1');
  });

  it('deleteOverride writes a "deleted" entry recording who deleted it and when, with the removed override preserved', async () => {
    await saveOverride('EU-1', { sanctionReason: 'Corrected' }, { overriddenBy: 'analyst@example.com', reason: 'Fix' });
    await deleteOverride('EU-1', 'reviewer@example.com');

    const history = await getOverrideHistory('EU-1');
    expect(history).toHaveLength(2);
    expect(history[0].changeType).toBe('deleted');
    expect(history[0].changedBy).toBe('reviewer@example.com');
    expect(history[0].changedAt).toBeTruthy();
    // The override as it stood just before removal — not the current state,
    // since there is none anymore.
    expect(history[0].override.fields).toEqual({ sanctionReason: 'Corrected' });
    expect(history[0].override.overriddenBy).toBe('analyst@example.com');
  });

  it('deleting a nonexistent override writes no history entry (idempotent, nothing to record)', async () => {
    await deleteOverride('DOES-NOT-EXIST', 'reviewer@example.com');
    expect(await getOverrideHistory('DOES-NOT-EXIST')).toEqual([]);
  });
});

describe('getOverrideHistory', () => {
  it('returns an empty array when no override was ever created for the entity', async () => {
    expect(await getOverrideHistory('EU-404')).toEqual([]);
  });
});
