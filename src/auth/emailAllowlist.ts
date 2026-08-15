import { TEST_LOGIN_EMAIL, isTestLoginEnabled, isTestLoginEmail } from './testAccount';

/**
 * Who is allowed to log in at all (issue #33).
 *
 * Before this, `POST /api/auth/request-otp` accepted any syntactically valid
 * email and `verify-otp` handed out a full session for it — since
 * `app.use('/api', requireAuth)` gates the entire API, that was a two-request
 * path to a working session for anyone on the internet.
 *
 * The allow-list comes from the `ALLOWED_EMAIL_DOMAINS` environment variable
 * (comma-separated domains), read on every call rather than cached at import
 * time — same reasoning as `src/auth/admins.ts`'s `ADMIN_EMAILS`: removing a
 * domain has to take effect on the next request, not after a redeploy.
 *
 * Fails closed. An unset or empty list grants nobody access, with one narrow
 * dev-only exception (the hardcoded test account, checked unconditionally —
 * issue #92) — same shape as `admins.ts`.
 */

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

function allowedDomains(): string[] {
  return (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const candidate = normalise(email);
  if (!candidate) return false;

  // issue #92: this bypass must be unconditional (still gated on
  // non-production), not limited to when no domain list is configured.
  // verify-otp already lets the test account log in regardless of
  // ALLOWED_EMAIL_DOMAINS; if this check only fired for an empty list, a
  // real deployment (which must set a real list per issue #33) would let
  // the test account "log in", then 401 on its very next request.
  if (isTestLoginEnabled() && isTestLoginEmail(candidate)) {
    return true;
  }

  const domains = allowedDomains();

  if (domains.length === 0) {
    // Fails closed: no domain list configured and not the test account
    // above means nobody, in or out of production.
    return false;
  }

  const domain = candidate.split('@')[1];
  return domain ? domains.includes(domain) : false;
}
