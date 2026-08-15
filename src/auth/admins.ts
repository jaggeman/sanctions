import { TEST_LOGIN_EMAIL, isTestLoginEnabled } from './testAccount';

/**
 * Who counts as an administrator.
 *
 * The allow-list comes from the `ADMIN_EMAILS` environment variable, read on
 * every call rather than cached at import time. That is deliberate: removing
 * someone from the list has to take effect on their *next* request, not after
 * a redeploy, and a long-lived session must never keep rights it no longer has
 * (CLAUDE.md §6).
 *
 * Fails closed. An unset or empty list grants nobody admin, with one narrow
 * exception below.
 */

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

function allowList(): string[] {
  const configured = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map(normalise)
    .filter(Boolean);

  if (configured.length > 0) return configured;

  // Dev-only fallback so local work isn't blocked before ADMIN_EMAILS is set.
  // Gated on the same non-production check as the test login account, and
  // superseded the moment a real list is configured.
  return isTestLoginEnabled() ? [normalise(TEST_LOGIN_EMAIL)] : [];
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const candidate = normalise(email);
  if (!candidate) return false;
  return allowList().includes(candidate);
}
