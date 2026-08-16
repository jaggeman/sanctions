import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';

// --- In-memory fake Firestore -------------------------------------------
// Models just enough of the Admin SDK surface uploader.ts needs:
// collection(...).doc(id), db.getAll(...refs), db.batch().set/commit, and a
// one-level `versions` subcollection under each sanctions doc. Batch.set with
// {merge:true} shallow-merges onto the stored object; a real
// admin.firestore.FieldValue.delete() sentinel removes a key, mirroring real
// Firestore semantics closely enough to exercise the soft-delete/version
// logic without the emulator.
function isDeleteSentinel(v: any): boolean {
  return !!v && typeof v === 'object' && v.constructor?.name === 'DeleteTransform';
}

interface StoredDoc {
  data: Record<string, any>;
  versions: Map<string, any>;
}

let store: Map<string, StoredDoc>;

function applyMerge(existing: Record<string, any> | undefined, incoming: Record<string, any>) {
  const base = { ...(existing || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (isDeleteSentinel(v)) {
      delete base[k];
    } else {
      base[k] = v;
    }
  }
  return base;
}

function makeDocRef(id: string) {
  return {
    id,
    get: async () => {
      const stored = store.get(id);
      return {
        exists: !!stored,
        data: () => (stored ? { ...stored.data } : undefined),
        ref: makeDocRef(id),
      };
    },
    collection: (name: string) => {
      if (name !== 'versions') throw new Error(`unexpected subcollection ${name}`);
      return {
        doc: (versionId: string) => ({
          get: async () => {
            const stored = store.get(id);
            const v = stored?.versions.get(versionId);
            return { exists: !!v, data: () => (v ? { ...v } : undefined) };
          },
        }),
      };
    },
  };
}

type PendingOp =
  | { kind: 'doc'; id: string; data: Record<string, any>; merge: boolean }
  | { kind: 'version'; id: string; versionId: string; data: Record<string, any> };

function makeBatch() {
  const ops: PendingOp[] = [];
  return {
    set: vi.fn((ref: any, data: Record<string, any>, opts?: { merge?: boolean }) => {
      if (ref.__versionId) {
        ops.push({ kind: 'version', id: ref.__docId, versionId: ref.__versionId, data });
      } else {
        ops.push({ kind: 'doc', id: ref.id, data, merge: !!opts?.merge });
      }
    }),
    commit: vi.fn(async () => {
      for (const op of ops) {
        if (op.kind === 'doc') {
          const stored = store.get(op.id) || { data: {}, versions: new Map() };
          stored.data = op.merge ? applyMerge(stored.data, op.data) : { ...op.data };
          store.set(op.id, stored);
        } else {
          const stored = store.get(op.id) || { data: {}, versions: new Map() };
          stored.versions.set(op.versionId, { ...op.data });
          store.set(op.id, stored);
        }
      }
    }),
  };
}

// Real docRef.collection('versions').doc(x) returns a ref without an easy
// `id`/`kind` marker for the fake batch to key off of, so this override
// wraps it with hidden markers the fake batch inspects.
function makeVersionRef(docId: string, versionId: string) {
  return { __docId: docId, __versionId: versionId };
}

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'sanctions') throw new Error(`unexpected collection ${name}`);
    return {
      doc: (id: string) => {
        const ref = makeDocRef(id);
        return {
          ...ref,
          collection: (subName: string) => {
            if (subName !== 'versions') throw new Error(`unexpected subcollection ${subName}`);
            return {
              doc: (versionId: string) => makeVersionRef(id, versionId),
              orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') => ({
                get: async () => {
                  const stored = store.get(id);
                  const entries = Array.from(stored?.versions.values() ?? []);
                  entries.sort((a: any, b: any) => {
                    if (a[field] === b[field]) return 0;
                    const cmp = a[field] > b[field] ? 1 : -1;
                    return dir === 'desc' ? -cmp : cmp;
                  });
                  return { docs: entries.map((v) => ({ data: () => ({ ...v }) })) };
                },
              }),
            };
          },
        };
      },
    };
  }),
  batch: vi.fn(() => makeBatch()),
  getAll: vi.fn(async (...refs: any[]) => {
    return Promise.all(refs.map((r) => r.get()));
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const { uploadRecords, delistRecords, computeContentHash, listRecordVersions } = await import('../../src/importer/uploader');

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
  } as SanctionRecord;
}

/** Builds a `names` override for a single primary name, matching this suite's `record()` shape. */
function namesOverride(wholeName: string): SanctionRecord['names'] {
  return [{ wholeName, strong: true }];
}

function getVersion(id: string, importId: string) {
  return store.get(id)?.versions.get(importId);
}

beforeEach(() => {
  store = new Map();
  vi.clearAllMocks();
});

describe('uploadRecords — soft delete fields + version trail', () => {
  it('marks a brand-new record active with listedAt set, and writes a "created" version', async () => {
    await uploadRecords([record()], 'import-1');

    const doc = store.get('PEP-1')!;
    expect(doc.data.status).toBe('active');
    expect(doc.data.listedAt).toBeTruthy();
    expect(doc.data.delistedAt).toBeUndefined();

    const version = await getVersion('PEP-1', 'import-1');
    expect(version).toBeTruthy();
    expect(version.changeType).toBe('created');
    expect(version.importId).toBe('import-1');
  });

  it('writes no version entry when a re-upload is content-identical', async () => {
    await uploadRecords([record()], 'import-1');
    await uploadRecords([record()], 'import-2');

    const doc = store.get('PEP-1')!;
    expect(doc.versions.size).toBe(1); // only the "created" entry from import-1
    expect(await getVersion('PEP-1', 'import-2')).toBeUndefined();
  });

  it('writes an "updated" version when a field actually changes', async () => {
    await uploadRecords([record()], 'import-1');
    await uploadRecords([record({ names: namesOverride('Vladimir V. Putin') })], 'import-2');

    const version = await getVersion('PEP-1', 'import-2');
    expect(version.changeType).toBe('updated');
    expect(version.record.names[0].wholeName).toBe('Vladimir V. Putin');
  });

  it('preserves the original listedAt across updates', async () => {
    await uploadRecords([record()], 'import-1');
    const firstListedAt = store.get('PEP-1')!.data.listedAt;
    expect(firstListedAt).toBeTruthy();

    await uploadRecords([record({ names: namesOverride('Changed Name') })], 'import-2');
    expect(store.get('PEP-1')!.data.listedAt).toBe(firstListedAt);
  });

  // --- issue #39 -----------------------------------------------------------

  it('preserves the original createdAt across a genuine content update, not just no-op re-imports', async () => {
    await uploadRecords([record({ createdAt: '2020-01-01T00:00:00.000Z' })], 'import-1');
    expect(store.get('PEP-1')!.data.createdAt).toBe('2020-01-01T00:00:00.000Z');

    // Simulates a real re-parse: every parser stamps createdAt fresh on
    // every run, so the incoming record's createdAt is "now", not the
    // original value — that must not win.
    await uploadRecords(
      [record({ primaryName: 'Changed Name', createdAt: '2026-06-01T00:00:00.000Z' })],
      'import-2',
    );

    expect(store.get('PEP-1')!.data.createdAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('preserves the original createdAt across a delist + relist cycle', async () => {
    await uploadRecords([record({ createdAt: '2020-01-01T00:00:00.000Z' })], 'import-1');
    await delistRecords(['PEP-1'], 'import-2');

    await uploadRecords(
      [record({ createdAt: '2026-06-01T00:00:00.000Z' })],
      'import-3',
    );

    expect(store.get('PEP-1')!.data.status).toBe('active');
    expect(store.get('PEP-1')!.data.createdAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('does not invent a createdAt for a pre-fix legacy record on an unchanged re-import', async () => {
    const legacy = record();
    delete (legacy as any).createdAt;
    (legacy as any).contentHash = computeContentHash(legacy);
    store.set('PEP-1', { data: { ...legacy }, versions: new Map() });

    await uploadRecords([record({ createdAt: '2026-06-01T00:00:00.000Z' })], 'import-1');

    expect(store.get('PEP-1')!.data.createdAt).toBeUndefined();
  });

  it('clears a field that disappears from a later import (e.g. a corrected/removed address)', async () => {
    await uploadRecords(
      [record({ addresses: [{ fullAddress: 'Old Address' }] } as any)],
      'import-1',
    );
    expect(store.get('PEP-1')!.data.addresses).toEqual([{ fullAddress: 'Old Address' }]);

    // Next import's parse no longer includes an address for this entity at
    // all (the key is simply absent, same shape every real parser produces).
    await uploadRecords([record()], 'import-2');

    expect(store.get('PEP-1')!.data.addresses).toBeUndefined();
    expect(store.get('PEP-1')!.data.names[0].wholeName).toBe('Vladimir Putin');
  });

  it('clears a removed field across a relist too, not just a plain update', async () => {
    await uploadRecords(
      [record({ addresses: [{ fullAddress: 'Old Address' }] } as any)],
      'import-1',
    );
    await delistRecords(['PEP-1'], 'import-2');

    await uploadRecords([record()], 'import-3');

    expect(store.get('PEP-1')!.data.status).toBe('active');
    expect(store.get('PEP-1')!.data.addresses).toBeUndefined();
  });

  it('does not clear a field that is still present and unchanged', async () => {
    await uploadRecords(
      [record({ addresses: [{ fullAddress: 'Same Address' }] } as any)],
      'import-1',
    );

    await uploadRecords(
      [record({ primaryName: 'Changed Name', addresses: [{ fullAddress: 'Same Address' }] } as any)],
      'import-2',
    );

    expect(store.get('PEP-1')!.data.addresses).toEqual([{ fullAddress: 'Same Address' }]);
  });

  it('never clears a field the importer does not itself own, even when a real content field is cleared alongside it', async () => {
    // Simulates manual analyst enrichment done directly in Firestore,
    // outside anything a parser ever sets — same scenario the pre-existing
    // "merges into an existing document instead of overwriting unrelated
    // fields" integration test protects. The field-clearing fix must stay
    // scoped to known SanctionRecord content fields, not "any key present on
    // the existing doc the new record happens not to mention."
    await uploadRecords(
      [record({ addresses: [{ fullAddress: 'Old Address' }] } as any)],
      'import-1',
    );
    const existing = store.get('PEP-1')!.data;
    store.set('PEP-1', { data: { ...existing, analystNote: 'flagged for review' }, versions: new Map() });

    await uploadRecords([record()], 'import-2'); // drops addresses this time

    const doc = store.get('PEP-1')!.data;
    expect(doc.addresses).toBeUndefined();
    expect(doc.analystNote).toBe('flagged for review');
  });

  it('flips a delisted record back to active and writes a "relisted" version on reappearance', async () => {
    await uploadRecords([record()], 'import-1');
    await delistRecords(['PEP-1'], 'import-2');
    expect(store.get('PEP-1')!.data.status).toBe('delisted');

    await uploadRecords([record()], 'import-3');

    const doc = store.get('PEP-1')!;
    expect(doc.data.status).toBe('active');
    expect(doc.data.delistedAt).toBeUndefined();

    const version = await getVersion('PEP-1', 'import-3');
    expect(version.changeType).toBe('relisted');
  });

  it('does not let status participate in contentHash (relisting with identical content is not "updated")', () => {
    const active = record({ status: 'active' } as any);
    const delisted = record({ status: 'delisted', delistedAt: '2025-01-01T00:00:00.000Z' } as any);
    expect(computeContentHash(active)).toBe(computeContentHash(delisted));
  });

  it('reconstructs the record as of the first import from its version snapshot', async () => {
    await uploadRecords([record({ names: namesOverride('Original Name') })], 'import-1');
    await uploadRecords([record({ names: namesOverride('Updated Name') })], 'import-2');

    const firstVersion = await getVersion('PEP-1', 'import-1');
    expect(firstVersion.record.names[0].wholeName).toBe('Original Name');

    const current = store.get('PEP-1')!.data;
    expect(current.names[0].wholeName).toBe('Updated Name');
  });

  // --- issue #68 -----------------------------------------------------------

  it('does not let firstSeenImport/lastSeenImport participate in contentHash', () => {
    const a = record({ firstSeenImport: 'import-1', lastSeenImport: 'import-1' } as any);
    const b = record({ firstSeenImport: 'import-1', lastSeenImport: 'import-99' } as any);
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('does not bump updatedAt when a re-import is content-identical', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await uploadRecords([record()], 'import-1');
      const firstUpdatedAt = store.get('PEP-1')!.data.updatedAt;

      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      await uploadRecords([record()], 'import-2');

      expect(store.get('PEP-1')!.data.updatedAt).toBe(firstUpdatedAt);
      expect(store.get('PEP-1')!.data.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does bump updatedAt when content actually changes', async () => {
    // The two uploadRecords calls can land in the same millisecond, which
    // would make "recomputed to a new now()" indistinguishable from
    // "preserved the old value" by coincidence alone — advance the clock so
    // the two `now` values are guaranteed different.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await uploadRecords([record()], 'import-1');
      const firstUpdatedAt = store.get('PEP-1')!.data.updatedAt;

      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      await uploadRecords([record({ names: namesOverride('Changed Name') })], 'import-2');

      expect(store.get('PEP-1')!.data.updatedAt).not.toBe(firstUpdatedAt);
      expect(store.get('PEP-1')!.data.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('issue #108: writes nothing at all — not even a same-data merge — on a truly unchanged re-import', async () => {
    await uploadRecords([record()], 'import-1');
    const firstBatch = fakeDb.batch.mock.results[0].value;
    expect(firstBatch.set).toHaveBeenCalled(); // sanity: the create path does write

    await uploadRecords([record()], 'import-2');
    const secondBatch = fakeDb.batch.mock.results[1].value;

    expect(secondBatch.set).not.toHaveBeenCalled();
  });

  it('does not invent a listedAt for a pre-#9 legacy record on an unchanged re-import', async () => {
    // Simulates a record written before issue #9 existed: no listedAt, but
    // otherwise identical content to what record() below re-uploads.
    const legacy = record();
    (legacy as any).contentHash = computeContentHash(legacy);
    // deliberately no listedAt field at all — the pre-#9 shape.
    store.set('PEP-1', { data: { ...legacy }, versions: new Map() });

    await uploadRecords([record()], 'import-1');

    expect(store.get('PEP-1')!.data.listedAt).toBeUndefined();
  });

  it('canonicalizes array element order before hashing, so a reordered source does not look like a content change', () => {
    const a = record({
      names: [
        { wholeName: 'Vladimir Putin', strong: true },
        { wholeName: 'Abu Ali', strong: false },
        { wholeName: 'Abou Ali', strong: false },
      ],
      addresses: [{ fullAddress: 'A' }, { fullAddress: 'B' }],
    } as any);
    const b = record({
      names: [
        { wholeName: 'Vladimir Putin', strong: true },
        { wholeName: 'Abou Ali', strong: false },
        { wholeName: 'Abu Ali', strong: false },
      ],
      addresses: [{ fullAddress: 'B' }, { fullAddress: 'A' }],
    } as any);
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('still detects a genuine content change, not just any hash difference', () => {
    const a = record({ names: namesOverride('Abu Ali') } as any);
    const b = record({ names: [...namesOverride('Abu Ali'), { wholeName: 'Someone Else', strong: false }] } as any);
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
});

describe('delistRecords', () => {
  it('marks existing records delisted and writes a "delisted" version', async () => {
    await uploadRecords([record()], 'import-1');
    await delistRecords(['PEP-1'], 'import-2');

    const doc = store.get('PEP-1')!;
    expect(doc.data.status).toBe('delisted');
    expect(doc.data.delistedAt).toBeTruthy();

    const version = await getVersion('PEP-1', 'import-2');
    expect(version.changeType).toBe('delisted');
  });

  it('is a no-op for an id that does not exist', async () => {
    await expect(delistRecords(['NOPE'], 'import-1')).resolves.toBeUndefined();
    expect(store.has('NOPE')).toBe(false);
  });

  it('writes no version entry for a record that is already delisted', async () => {
    await uploadRecords([record()], 'import-1');
    await delistRecords(['PEP-1'], 'import-2');
    await delistRecords(['PEP-1'], 'import-3');

    expect(await getVersion('PEP-1', 'import-3')).toBeUndefined();
  });

  it('does nothing (no throw) when given an empty array', async () => {
    await expect(delistRecords([], 'import-1')).resolves.toBeUndefined();
  });
});

describe('listRecordVersions (issue #12)', () => {
  it('returns an empty array for a record with no version history', async () => {
    expect(await listRecordVersions('NOPE')).toEqual([]);
  });

  it('returns the version trail newest first', async () => {
    // Fake timers so each write gets a distinguishable changedAt — three
    // synchronous writes can otherwise land on the identical millisecond.
    vi.useFakeTimers();
    await uploadRecords([record({ names: namesOverride('Original Name') })], 'import-1');
    vi.advanceTimersByTime(1000);
    await uploadRecords([record({ names: namesOverride('Updated Name') })], 'import-2');
    vi.advanceTimersByTime(1000);
    await delistRecords(['PEP-1'], 'import-3');
    vi.useRealTimers();

    const versions = await listRecordVersions('PEP-1');
    expect(versions.map((v) => v.importId)).toEqual(['import-3', 'import-2', 'import-1']);
    expect(versions.map((v) => v.changeType)).toEqual(['delisted', 'updated', 'created']);
  });
});
