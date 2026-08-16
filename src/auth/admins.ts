import { TEST_LOGIN_EMAIL, isTestLoginEnabled, isTestLoginEmail } from './testAccount';

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
  if (isTestLoginEnabled() && isTestLoginEmail(candidate)) {
    return true;
  }
  return allowList().includes(candidate);
}

function allowedDomains(): string[] {
  return (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function maskLocalPart(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '[REDACTED]';
  return `${email[0]}***${email.slice(at)}`;
}

export interface MisconfiguredAdminEmail {
  maskedEmail: string;
  domain: string;
}

/**
 * Deployment footgun (issue #65): `ADMIN_EMAILS` and `ALLOWED_EMAIL_DOMAINS`
 * are two independent env vars with no cross-check. An operator can add a
 * real admin's address to `ADMIN_EMAILS` while forgetting to cover their
 * domain in `ALLOWED_EMAIL_DOMAINS` — `isAllowedEmail` denies that admin
 * before `isAdminEmail` is ever consulted, locking them out with no
 * indication of *why* (it looks like a normal "not allowed" rejection).
 *
 * Checks the raw *configured* `ADMIN_EMAILS` list only — not the dev-test-
 * account fallback `allowList()` uses when `ADMIN_EMAILS` is unset, since
 * there is nothing an operator configured to warn about in that case.
 *
 * The dev test-login account is excluded: it has its own unconditional
 * bypass in `isAllowedEmail` (issue #92) that doesn't depend on domain
 * configuration at all outside production, so flagging it there would be a
 * false positive.
 */
export function findMisconfiguredAdminEmails(): MisconfiguredAdminEmail[] {
  const configured = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map(normalise)
    .filter(Boolean);

  if (configured.length === 0) return [];

  const domains = allowedDomains();

  return configured
    .filter((email) => !(isTestLoginEnabled() && isTestLoginEmail(email)))
    .flatMap((email) => {
      const domain = email.split('@')[1];
      if (domain && domains.includes(domain)) return [];
      return [{ maskedEmail: maskLocalPart(email), domain: domain ?? '(none)' }];
    });
}
