// A hardcoded dev-only login for fast local testing, requested explicitly so real SMTP
// setup isn't needed before Firebase Auth replaces this interim system. Never active
// in production, regardless of env misconfiguration elsewhere.
export const TEST_LOGIN_EMAIL = 'admin@sanctions.com';
export const TEST_LOGIN_CODE = '123456';

export function isTestLoginEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function isTestLoginEmail(email: string): boolean {
  return email.trim().toLowerCase() === TEST_LOGIN_EMAIL;
}
