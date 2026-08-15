import { generateOtpCode, hashOtpCode, OTP_TTL_MS, OTP_MAX_ATTEMPTS } from './otp';

interface OtpEntry {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

let store = new Map<string, OtpEntry>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Creates (or replaces) a pending OTP for an email and returns the plaintext code to send. */
export function createOtp(email: string): string {
  const code = generateOtpCode();
  store.set(normalizeEmail(email), {
    codeHash: hashOtpCode(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
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
