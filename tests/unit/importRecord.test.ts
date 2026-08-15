import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportRecord } from '../../src/shared/types';

// --- Fake Firestore, modelling real create()/get()/update() semantics ------
// doc.create() must throw (with a Firestore-shaped ALREADY_EXISTS error) if
// the ID already exists — that's the actual mechanism under test.
const store = new Map<string, any>();

function makeDoc(id: string) {
  return {
    get: vi.fn(async () => ({
      exists: store.has(id),
      data: () => store.get(id),
    })),
    create: vi.fn(async (data: any) => {
      if (store.has(id)) {
        const err: any = new Error(`6 ALREADY_EXISTS: Document already exists: ${id}`);
        err.code = 6;
        throw err;
      }
      store.set(id, { ...data });
    }),
    update: vi.fn(async (data: any) => {
      if (!store.has(id)) throw new Error('NOT_FOUND');
      store.set(id, { ...store.get(id), ...data });
    }),
  };
}

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'imports') throw new Error(`unexpected collection ${name}`);
    return {
      doc: vi.fn((id: string) => makeDoc(id)),
      orderBy: vi.fn((field: string, dir: 'asc' | 'desc' = 'asc') => ({
        limit: vi.fn((n: number) => ({
          get: vi.fn(async () => {
            const entries = Array.from(store.values());
            entries.sort((a: any, b: any) => {
              if (a[field] === b[field]) return 0;
              const cmp = a[field] > b[field] ? 1 : -1;
              return dir === 'desc' ? -cmp : cmp;
            });
            return { docs: entries.slice(0, n).map((v) => ({ data: () => ({ ...v }) })) };
          }),
        })),
      })),
    };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const {
  createPendingImport,
  markImportApplied,
  markImportFailed,
  markImportRejected,
  findImportBySha256,
  findAppliedImportBySha256,
  listImports,
  ImportAlreadyInFlightError,
} = await import('../../src/importer/importRecord');

function baseRecord(overrides: Partial<Omit<ImportRecord, 'status'>> = {}): Omit<ImportRecord, 'status'> {
  return {
    importId: 'abc123',
    filename: 'test.csv',
    sha256: 'abc123',
    sizeBytes: 1024,
    storagePath: 'imports/abc123/test.csv',
    source: 'PEP',
    format: 'csv',
    fileGenerationDate: null,
    uploadedBy: 'user@example.com',
    uploadedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('createPendingImport', () => {
  it('creates a pending doc keyed by sha256', async () => {
    await createPendingImport(baseRecord());
    const doc = await findImportBySha256('abc123');
    expect(doc?.status).toBe('pending');
    expect(doc?.filename).toBe('test.csv');
  });

  it('throws ImportAlreadyInFlightError on a concurrent duplicate create (the race-safety mechanism)', async () => {
    await createPendingImport(baseRecord());
    await expect(createPendingImport(baseRecord())).rejects.toBeInstanceOf(ImportAlreadyInFlightError);
  });

  it('re-throws an unrelated Firestore error rather than misclassifying it', async () => {
    fakeDb.collection.mockImplementationOnce(() => ({
      doc: vi.fn(() => ({
        create: vi.fn(async () => { throw new Error('UNAVAILABLE: network blip'); }),
      })),
    }));
    let caught: any;
    try {
      await createPendingImport(baseRecord());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('UNAVAILABLE');
    expect(caught).not.toBeInstanceOf(ImportAlreadyInFlightError);
  });
});

describe('markImportApplied / markImportFailed / markImportRejected', () => {
  it('marks an import applied with counts', async () => {
    await createPendingImport(baseRecord());
    await markImportApplied('abc123', { parsed: 10, uploaded: 8 });
    const doc = await findImportBySha256('abc123');
    expect(doc?.status).toBe('applied');
    expect(doc?.counts).toEqual({ parsed: 10, uploaded: 8 });
  });

  it('marks an import failed with the error message, not left dangling pending', async () => {
    await createPendingImport(baseRecord());
    await markImportFailed('abc123', 'parse blew up');
    const doc = await findImportBySha256('abc123');
    expect(doc?.status).toBe('failed');
    expect(doc?.error).toBe('parse blew up');
  });

  it('marks an import rejected with a reference to the duplicate', async () => {
    await createPendingImport(baseRecord({ sha256: 'dup1', importId: 'dup1' }));
    await markImportRejected('dup1', 'abc123');
    const doc = await findImportBySha256('dup1');
    expect(doc?.status).toBe('rejected');
    expect(doc?.duplicateOfImportId).toBe('abc123');
  });
});

describe('findAppliedImportBySha256', () => {
  it('returns null when no import exists for that hash', async () => {
    expect(await findAppliedImportBySha256('nonexistent')).toBeNull();
  });

  it('returns null when the import exists but is not applied (e.g. still pending)', async () => {
    await createPendingImport(baseRecord());
    expect(await findAppliedImportBySha256('abc123')).toBeNull();
  });

  it('returns the record once it has been marked applied', async () => {
    await createPendingImport(baseRecord());
    await markImportApplied('abc123', { parsed: 1, uploaded: 1 });
    const found = await findAppliedImportBySha256('abc123');
    expect(found?.sha256).toBe('abc123');
    expect(found?.status).toBe('applied');
  });
});

describe('listImports (issue #12)', () => {
  it('returns an empty array when there are no imports', async () => {
    expect(await listImports(20)).toEqual([]);
  });

  it('lists imports newest first by uploadedAt', async () => {
    await createPendingImport(baseRecord({ sha256: 'older', importId: 'older', uploadedAt: '2026-01-01T00:00:00.000Z' }));
    await createPendingImport(baseRecord({ sha256: 'newer', importId: 'newer', uploadedAt: '2026-06-01T00:00:00.000Z' }));

    const imports = await listImports(20);
    expect(imports.map((i) => i.importId)).toEqual(['newer', 'older']);
  });

  it('caps results at the requested limit', async () => {
    await createPendingImport(baseRecord({ sha256: 'a', importId: 'a', uploadedAt: '2026-01-01T00:00:00.000Z' }));
    await createPendingImport(baseRecord({ sha256: 'b', importId: 'b', uploadedAt: '2026-01-02T00:00:00.000Z' }));
    await createPendingImport(baseRecord({ sha256: 'c', importId: 'c', uploadedAt: '2026-01-03T00:00:00.000Z' }));

    expect(await listImports(2)).toHaveLength(2);
  });
});
