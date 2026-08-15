import * as crypto from 'crypto';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionEntry {
  email: string;
  expiresAt: number;
}

let store = new Map<string, SessionEntry>();

export function createSession(email: string): string {
  const sessionId = crypto.randomBytes(32).toString('hex');
  store.set(sessionId, { email, expiresAt: Date.now() + SESSION_TTL_MS });
  return sessionId;
}

export function getSession(sessionId: string): SessionEntry | null {
  const entry = store.get(sessionId);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    store.delete(sessionId);
    return null;
  }

  return entry;
}

export function destroySession(sessionId: string): void {
  store.delete(sessionId);
}

export function _resetSessionStoreForTests(): void {
  store = new Map();
}
