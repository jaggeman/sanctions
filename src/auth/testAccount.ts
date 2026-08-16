// A hardcoded dev-only login for fast local testing, requested explicitly so real SMTP
// setup isn't needed before Firebase Auth replaces this interim system.
export const TEST_LOGIN_EMAIL = 'admin@sanctions.com';
export const TEST_LOGIN_CODE = '123456';

// SECURITY (incident, 2026-08-16): this used to be `NODE_ENV !== 'production'`
// alone — fail-OPEN. A deployed Cloud Function inherited NODE_ENV=development
// (a stray root .env, meant for local use only, that Firebase's own env-file
// deploy mechanism shipped to a live project) and silently activated an
// unauthenticated admin login on the public production URL.
//
// Requiring an explicit ENABLE_TEST_LOGIN=true opt-in makes a missing or
// misconfigured environment fail CLOSED instead: `NODE_ENV !== 'production'`
// is still checked first as defense-in-depth (this can never activate in a
// correctly-configured production environment even if the opt-in flag were
// ever set there by mistake), but it is no longer sufficient on its own.
export function isTestLoginEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_LOGIN === 'true';
}

export function isTestLoginEmail(email: string): boolean {
  return email.trim().toLowerCase() === TEST_LOGIN_EMAIL;
}
