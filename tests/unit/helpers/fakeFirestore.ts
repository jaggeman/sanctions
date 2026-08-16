/**
 * Minimal in-memory fake of the firebase-admin Firestore surface actually
 * used by src/auth/otpStore.ts and src/auth/session.ts:
 * `db.collection(name).doc(id).get/set/update/delete`. Shared across their
 * unit tests (and the route tests that create sessions as test fixtures) so
 * each file doesn't hand-roll its own copy.
 */
export function createFakeDb() {
  const collections = new Map<string, Map<string, any>>();

  function getCollectionMap(name: string): Map<string, any> {
    let coll = collections.get(name);
    if (!coll) {
      coll = new Map();
      collections.set(name, coll);
    }
    return coll;
  }

  function makeDocRef(name: string, id: string) {
    return {
      get: async () => {
        const coll = getCollectionMap(name);
        const data = coll.get(id);
        return {
          exists: data !== undefined,
          data: () => data,
        };
      },
      set: async (data: any, options?: { merge?: boolean }) => {
        const coll = getCollectionMap(name);
        if (options?.merge) {
          const existing = coll.get(id) || {};
          coll.set(id, { ...existing, ...data });
        } else {
          coll.set(id, { ...data });
        }
      },
      update: async (data: any) => {
        const coll = getCollectionMap(name);
        const existing = coll.get(id) || {};
        coll.set(id, { ...existing, ...data });
      },
      delete: async () => {
        getCollectionMap(name).delete(id);
      },
    };
  }

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => makeDocRef(name, id),
    }),
    // Minimal, non-isolated shim: just runs the callback against the same
    // doc refs (get/set), so offline unit tests can exercise the
    // read-check-write logic. Does NOT model real transaction isolation or
    // conflict retries — that's exactly what the real Firestore emulator
    // integration test validates instead (CLAUDE.md §1: transactions are
    // what mocks can't see).
    runTransaction: async (
      updateFn: (tx: {
        get: (ref: any) => Promise<any>;
        set: (ref: any, data: any, options?: { merge?: boolean }) => void;
        update: (ref: any, data: any) => void;
        delete: (ref: any) => void;
      }) => Promise<any>,
    ) => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: { merge?: boolean }) => {
          // Fire-and-forget is fine here: the fake's set() resolves
          // synchronously under the hood (in-memory Map), only wrapped in a
          // Promise for interface parity with the real SDK.
          void ref.set(data, options);
        },
        update: (ref: any, data: any) => {
          void ref.update(data);
        },
        delete: (ref: any) => {
          void ref.delete();
        },
      };
      return updateFn(tx);
    },
  };

  return {
    db,
    reset: () => collections.clear(),
    dumpIds: (name: string) => Array.from(getCollectionMap(name).keys()),
  };
}
