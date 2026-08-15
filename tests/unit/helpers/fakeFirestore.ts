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

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const coll = getCollectionMap(name);
          const data = coll.get(id);
          return {
            exists: data !== undefined,
            data: () => data,
          };
        },
        set: async (data: any) => {
          getCollectionMap(name).set(id, { ...data });
        },
        update: async (data: any) => {
          const coll = getCollectionMap(name);
          const existing = coll.get(id) || {};
          coll.set(id, { ...existing, ...data });
        },
        delete: async () => {
          getCollectionMap(name).delete(id);
        },
      }),
    }),
  };

  return {
    db,
    reset: () => collections.clear(),
    dumpIds: (name: string) => Array.from(getCollectionMap(name).keys()),
  };
}
