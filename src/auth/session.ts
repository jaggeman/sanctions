import * as crypto from 'crypto';
import { db } from '../shared/firebase';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const COLLECTION = 'sessions';

interface SessionEntry {
  email: string;
  expiresAt: string;
}

// In-memory read-through cache in front of the Firestore lookup (issue #229):
// every authenticated request otherwise pays a Firestore read just to
// re-confirm a session that changes on the order of days, not requests.
//
// Deliberately 5s, not the 30-60s originally proposed: this process is one of
// several concurrent Cloud Functions/Cloud Run instances (that's the whole
// reason sessions live in Firestore at all, per issue #63), and
// destroySession() below only evicts the entry on *this* instance. A logout
// handled by a different warm instance leaves this instance's cache still
// answering "valid" until the entry ages out — a real, if narrow, version of
// the stale-cached-permission gap CLAUDE.md §6 warns about. 5s keeps almost
// all of the benefit (repeated requests within the same user action) while
// keeping that cross-instance exposure window short rather than up to a
// minute.
const SESSION_CACHE_TTL_MS = 5_000;
const SESSION_CACHE_MAX_ENTRIES = 10_000;

const sessionCache = new Map<string, { entry: SessionEntry; cachedAt: number }>();

function cacheGet(sessionId: string): SessionEntry | null {
  const cached = sessionCache.get(sessionId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(sessionId);
    return null;
  }
  return cached.entry;
}

function cacheSet(sessionId: string, entry: SessionEntry): void {
  if (sessionCache.size >= SESSION_CACHE_MAX_ENTRIES && !sessionCache.has(sessionId)) {
    const oldestKey = sessionCache.keys().next().value;
    if (oldestKey !== undefined) sessionCache.delete(oldestKey);
  }
  sessionCache.set(sessionId, { entry, cachedAt: Date.now() });
}

/**
 * Persisted in Firestore (issue #63) rather than an in-process Map: the
 * previous in-memory store didn't survive a Cloud Functions cold start or a
 * second concurrent instance, silently logging users out at unpredictable
 * moments unrelated to a deploy. The session id itself is a
 * cryptographically random value generated here, not user-supplied, so it's
 * safe to use directly as the Firestore document id.
 */
export async function createSession(email: string): Promise<string> {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.collection(COLLECTION).doc(sessionId).set({ email, expiresAt });
  return sessionId;
}

export async function getSession(sessionId: string): Promise<SessionEntry | null> {
  const cached = cacheGet(sessionId);
  if (cached) return cached;

  const ref = db.collection(COLLECTION).doc(sessionId);
  const doc = await ref.get();
  if (!doc.exists) return null;

  const entry = doc.data() as SessionEntry;
  if (Date.now() > new Date(entry.expiresAt).getTime()) {
    await ref.delete();
    return null;
  }

  cacheSet(sessionId, entry);
  return entry;
}

export async function destroySession(sessionId: string): Promise<void> {
  sessionCache.delete(sessionId);
  await db.collection(COLLECTION).doc(sessionId).delete();
}
