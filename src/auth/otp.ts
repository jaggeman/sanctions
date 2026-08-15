import * as crypto from 'crypto';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
// Minimum time between two OTP requests for the same email (issue #16) —
// otherwise POST /api/auth/request-otp can be hit repeatedly to spam an
// arbitrary inbox with login codes.
export const OTP_REQUEST_COOLDOWN_MS = 60 * 1000;

export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtpCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}
