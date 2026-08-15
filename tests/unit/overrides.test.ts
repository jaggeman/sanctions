import { describe, it, expect } from 'vitest';

// overrides/index.ts must not import ../shared/firebase at all — the merge
// logic is pure and needs no database. If a future change accidentally wires
// in `db`, this test file has no mock for it and will fail loudly at import
// time, which is the point.
import { applyOverride } from '../../src/overrides';
import type { SanctionRecord, Override } from '../../src/shared/types';

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

  it('ignores a status field even though SanctionRecord does not define one yet (forward guard for issue #8)', () => {
    const rec = record();
    const result = applyOverride(rec, override({ status: 'delisted' } as any));
    expect((result.record as any).status).toBeUndefined();
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
