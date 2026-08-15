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
            return { doc: (versionId: string) => makeVersionRef(id, versionId) };
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

const { uploadRecords, delistRecords, computeContentHash } = await import('../../src/importer/uploader');

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
  } as SanctionRecord;
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
    await uploadRecords([record({ primaryName: 'Vladimir V. Putin' })], 'import-2');

    const version = await getVersion('PEP-1', 'import-2');
    expect(version.changeType).toBe('updated');
    expect(version.record.primaryName).toBe('Vladimir V. Putin');
  });

  it('preserves the original listedAt across updates', async () => {
    await uploadRecords([record()], 'import-1');
    const firstListedAt = store.get('PEP-1')!.data.listedAt;
    expect(firstListedAt).toBeTruthy();

    await uploadRecords([record({ primaryName: 'Changed Name' })], 'import-2');
    expect(store.get('PEP-1')!.data.listedAt).toBe(firstListedAt);
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
    await uploadRecords([record({ primaryName: 'Original Name' })], 'import-1');
    await uploadRecords([record({ primaryName: 'Updated Name' })], 'import-2');

    const firstVersion = await getVersion('PEP-1', 'import-1');
    expect(firstVersion.record.primaryName).toBe('Original Name');

    const current = store.get('PEP-1')!.data;
    expect(current.primaryName).toBe('Updated Name');
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
