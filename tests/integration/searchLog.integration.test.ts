import { describe, it, expect, beforeEach, afterAll } from 'vitest';

/**
 * Integration layer (CLAUDE.md §1) — proves logSearchEvent actually produces
 * a queryable Firestore document, per issue #109's own explicit acceptance
 * criterion ("a test can query this collection after calling the endpoint
 * and find the expected entry... this is exactly the kind of real-write-path
 * behavior an offline mock can't verify").
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sanctions-integration-test';

const { db } = await import('../../src/shared/firebase');
const { logSearchEvent } = await import('../../src/search/searchLog');

async function clearCollection() {
  const snap = await db.collection('searchLog').get();
  await Promise.all(snap.docs.map((doc: any) => doc.ref.delete()));
}

beforeEach(async () => {
  await clearCollection();
});

afterAll(async () => {
  await clearCollection();
});

describe('logSearchEvent — real Firestore write path', () => {
  it('writes a durable, queryable entry for a search event', async () => {
    await logSearchEvent({
      action: 'search',
      requestedBy: 'analyst@example.com',
      query: 'Vladimir Putin',
      filters: { source: 'EU,UN', threshold: 70 },
      resultCount: 2,
      timestamp: '2026-08-16T00:00:00.000Z',
    });

    const snap = await db
      .collection('searchLog')
      .where('requestedBy', '==', 'analyst@example.com')
      .get();

    expect(snap.docs).toHaveLength(1);
    const data = snap.docs[0].data();
    expect(data.action).toBe('search');
    expect(data.query).toBe('Vladimir Putin');
    expect(data.resultCount).toBe(2);
    expect(data.filters).toEqual({ source: 'EU,UN', threshold: 70 });
  });

  it('writes a durable, queryable entry for a lookup event', async () => {
    await logSearchEvent({
      action: 'lookup',
      requestedBy: 'token:tok-1',
      entityId: 'EU-13',
      resultCount: 1,
      timestamp: '2026-08-16T00:00:00.000Z',
    });

    const snap = await db.collection('searchLog').where('entityId', '==', 'EU-13').get();

    expect(snap.docs).toHaveLength(1);
    expect(snap.docs[0].data().action).toBe('lookup');
    expect(snap.docs[0].data().requestedBy).toBe('token:tok-1');
  });
});
