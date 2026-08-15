import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createSession, getSession, destroySession, _resetSessionStoreForTests } from '../../../src/auth/session';

describe('session store', () => {
  beforeEach(() => {
    _resetSessionStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips email through a created session', () => {
    const sid = createSession('user@example.com');
    expect(getSession(sid)?.email).toBe('user@example.com');
  });

  it('returns null for an unknown session id', () => {
    expect(getSession('does-not-exist')).toBeNull();
  });

  it('generates unguessable, unique session ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createSession('user@example.com')));
    expect(ids.size).toBe(20);
    for (const id of ids) {
      expect(id.length).toBeGreaterThanOrEqual(32);
    }
  });

  it('expires sessions after the TTL', () => {
    vi.useFakeTimers();
    const sid = createSession('user@example.com');
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000); // TTL is 7 days
    expect(getSession(sid)).toBeNull();
  });

  it('removes a session on destroy', () => {
    const sid = createSession('user@example.com');
    destroySession(sid);
    expect(getSession(sid)).toBeNull();
  });
});
