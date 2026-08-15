import * as crypto from 'crypto';
import { db } from '../shared/firebase';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const COLLECTION = 'sessions';

interface SessionEntry {
  email: string;
  expiresAt: string;
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
  const ref = db.collection(COLLECTION).doc(sessionId);
  const doc = await ref.get();
  if (!doc.exists) return null;

  const entry = doc.data() as SessionEntry;
  if (Date.now() > new Date(entry.expiresAt).getTime()) {
    await ref.delete();
    return null;
  }

  return entry;
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.collection(COLLECTION).doc(sessionId).delete();
}
