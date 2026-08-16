import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createFakeDb } from '../helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../../src/shared/firebase', () => ({ db: fakeDb }));

const { createSession, getSession, destroySession } = await import('../../../src/auth/session');

describe('session store (issue #63: Firestore-backed, survives multi-instance/cold-start)', () => {
  beforeEach(() => {
    resetFakeDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips email through a created session', async () => {
    const sid = await createSession('user@example.com');
    expect((await getSession(sid))?.email).toBe('user@example.com');
  });

  it('returns null for an unknown session id', async () => {
    expect(await getSession('does-not-exist')).toBeNull();
  });

  it('generates unguessable, unique session ids', async () => {
    const ids = new Set(await Promise.all(Array.from({ length: 20 }, () => createSession('user@example.com'))));
    expect(ids.size).toBe(20);
    for (const id of ids) {
      expect(id.length).toBeGreaterThanOrEqual(32);
    }
  });

  it('expires sessions after the TTL', async () => {
    vi.useFakeTimers();
    const sid = await createSession('user@example.com');
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000); // TTL is 7 days
    expect(await getSession(sid)).toBeNull();
  });

  it('removes a session on destroy', async () => {
    const sid = await createSession('user@example.com');
    await destroySession(sid);
    expect(await getSession(sid)).toBeNull();
  });

  describe('durability across cold starts (issue #63)', () => {
    it('persists through the db module rather than any local in-process variable', async () => {
      const sid = await createSession('user@example.com');
      // Simulates a separate Cloud Function instance/cold start picking up
      // the same request: a fresh module import must still see the session,
      // since nothing is cached in a module-level Map anymore.
      vi.resetModules();
      const { getSession: getSessionFromFreshImport } = await import('../../../src/auth/session');
      expect((await getSessionFromFreshImport(sid))?.email).toBe('user@example.com');
    });
  });

  describe('in-memory TTL cache in front of the Firestore read (issue #229)', () => {
    it('serves a repeated lookup for the same session from cache, without hitting Firestore', async () => {
      const sid = await createSession('user@example.com');
      await getSession(sid); // warms the cache

      const collectionSpy = vi.spyOn(fakeDb, 'collection');
      collectionSpy.mockClear();

      const cached = await getSession(sid);

      expect(cached?.email).toBe('user@example.com');
      expect(collectionSpy).not.toHaveBeenCalled();
    });

    it('falls back to Firestore once the cache entry has expired', async () => {
      vi.useFakeTimers();
      const sid = await createSession('user@example.com');
      await getSession(sid); // warms the cache

      vi.advanceTimersByTime(6_000); // cache TTL is 5s

      const collectionSpy = vi.spyOn(fakeDb, 'collection');
      collectionSpy.mockClear();

      const result = await getSession(sid);

      expect(result?.email).toBe('user@example.com');
      expect(collectionSpy).toHaveBeenCalled();
    });

    it('evicts the cache entry immediately on destroySession, even while the TTL has not elapsed', async () => {
      const sid = await createSession('user@example.com');
      await getSession(sid); // warms the cache

      await destroySession(sid);

      // Must not be served stale from cache — this is the whole safety
      // property destroySession exists for (logout must take effect on the
      // very next request).
      expect(await getSession(sid)).toBeNull();
    });

    it('never lets a cached entry outlive its own expiresAt (cache TTL is much shorter than session TTL)', async () => {
      vi.useFakeTimers();
      const sid = await createSession('user@example.com');
      await getSession(sid); // warms the cache

      vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000); // session TTL is 7 days, far past the 5s cache TTL

      expect(await getSession(sid)).toBeNull();
    });
  });
});
