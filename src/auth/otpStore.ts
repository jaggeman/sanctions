import * as crypto from 'crypto';
import { db } from '../shared/firebase';
import { generateOtpCode, hashOtpCode, OTP_TTL_MS, OTP_MAX_ATTEMPTS, OTP_REQUEST_COOLDOWN_MS } from './otp';

const COLLECTION = 'otpCodes';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Firestore doc ids are a hash of the normalized email, never the raw
 * address (CLAUDE.md §6 — a user-supplied value must not flow unvalidated
 * into a storage key/path segment).
 */
function emailKey(email: string): string {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

/**
 * Creates (or replaces) a pending OTP for an email and returns the plaintext
 * code to send, or `null` if one was already issued for this email within
 * the cooldown window (issue #16 rate limiting).
 *
 * Persisted in Firestore (issue #63) rather than an in-process Map: the
 * previous in-memory store didn't survive a Cloud Functions cold start or a
 * second concurrent instance, silently invalidating an in-flight login.
 */
export async function createOtp(email: string): Promise<string | null> {
  const ref = db.collection(COLLECTION).doc(emailKey(email));
  const existingDoc = await ref.get();
  const existing = existingDoc.exists ? existingDoc.data() : undefined;

  if (existing && Date.now() - new Date(existing.issuedAt).getTime() < OTP_REQUEST_COOLDOWN_MS) {
    return null;
  }

  const code = generateOtpCode();
  const now = new Date();
  await ref.set({
    codeHash: hashOtpCode(code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
    attempts: 0,
    issuedAt: now.toISOString(),
  });
  return code;
}

export async function verifyOtp(email: string, code: string): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(emailKey(email));
  const doc = await ref.get();
  if (!doc.exists) return false;
  const entry = doc.data()!;

  if (Date.now() > new Date(entry.expiresAt).getTime()) {
    await ref.delete();
    return false;
  }

  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    return false;
  }

  if (entry.codeHash !== hashOtpCode(code)) {
    await ref.update({ attempts: entry.attempts + 1 });
    return false;
  }

  await ref.delete();
  return true;
}
