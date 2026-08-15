import { Request, Response, NextFunction } from 'express';
import { getSession } from './session';
import { isAllowedEmail } from './emailAllowlist';

export const SESSION_COOKIE_NAME = 'sid';

/**
 * Gates the entire API (`app.use('/api', requireAuth)`). Re-checks the email
 * domain allow-list on every call, not just at login (issue #33) — same
 * reasoning CLAUDE.md §6 and `requireAdmin` (#32) already establish: a
 * session must not keep access it no longer qualifies for. A domain removed
 * from `ALLOWED_EMAIL_DOMAINS` invalidates every session using it on that
 * session's very next request, with no separate revocation step needed.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  const session = sessionId ? getSession(sessionId) : null;

  if (!session || !isAllowedEmail(session.email)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  (req as any).userEmail = session.email;
  next();
}
