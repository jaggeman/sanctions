import { generateOtpCode, hashOtpCode, OTP_TTL_MS, OTP_MAX_ATTEMPTS, OTP_REQUEST_COOLDOWN_MS } from './otp';

interface OtpEntry {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  issuedAt: number;
}

let store = new Map<string, OtpEntry>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Creates (or replaces) a pending OTP for an email and returns the plaintext
 * code to send, or `null` if one was already issued for this email within
 * the cooldown window (issue #16 rate limiting).
 */
export function createOtp(email: string): string | null {
  const key = normalizeEmail(email);
  const existing = store.get(key);
  if (existing && Date.now() - existing.issuedAt < OTP_REQUEST_COOLDOWN_MS) {
    return null;
  }

  const code = generateOtpCode();
  store.set(key, {
    codeHash: hashOtpCode(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    issuedAt: Date.now(),
  });
  return code;
}

export function verifyOtp(email: string, code: string): boolean {
  const key = normalizeEmail(email);
  const entry = store.get(key);
  if (!entry) return false;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return false;
  }

  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    return false;
  }

  if (entry.codeHash !== hashOtpCode(code)) {
    entry.attempts += 1;
    return false;
  }

  store.delete(key);
  return true;
}

export function _resetOtpStoreForTests(): void {
  store = new Map();
}
