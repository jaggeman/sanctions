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
});
