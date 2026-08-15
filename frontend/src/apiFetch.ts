// Shared fetch wrapper (issue #38): a 401 anywhere in the app means the
// session cookie has expired or been invalidated server-side. Without this,
// every call site had to check for it separately — most didn't, so a dead
// session showed up as a generic or silent error instead of routing back to
// Login. Call setOnSessionExpired once (from App's top-level effect) to wire
// the app-wide "kick back to Login" side effect; every apiFetch call then
// triggers it consistently, with no per-call-site logic needed.

type SessionExpiredListener = () => void;

let onSessionExpired: SessionExpiredListener | null = null;

export function setOnSessionExpired(listener: SessionExpiredListener | null): void {
  onSessionExpired = listener;
}

/**
 * Thin wrapper around fetch() for authenticated API calls. Behaves exactly
 * like fetch() — same arguments, same Response returned, callers can still
 * check res.ok/res.status themselves — except a 401 also fires the globally
 * registered onSessionExpired callback before the Response is returned.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401 && onSessionExpired) {
    onSessionExpired();
  }
  return res;
}
