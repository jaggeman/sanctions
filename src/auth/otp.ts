import * as crypto from 'crypto';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
// Minimum time between two OTP requests for the same email (issue #16) —
// otherwise POST /api/auth/request-otp can be hit repeatedly to spam an
// arbitrary inbox with login codes.
export const OTP_REQUEST_COOLDOWN_MS = 60 * 1000;
// issue #62: the per-email cooldown above doesn't stop many DISTINCT real
// addresses each being sent one code at once ("email-bombing"). This caps
// total OTP sends org-wide per fixed window, independent of which email(s)
// they're for. Hardcoded like the cooldown above, not env-configurable —
// tune by editing these constants for a deploy that needs a different volume.
export const OTP_GLOBAL_SEND_LIMIT = 30;
export const OTP_GLOBAL_SEND_WINDOW_MS = 60 * 1000;

// issue #144: per-IP send limit to prevent a single attacker from exhausting
// global budget or sending spam from a single address.
export const OTP_IP_SEND_LIMIT = 5;
export const OTP_IP_SEND_WINDOW_MS = 60 * 1000;

export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtpCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}
