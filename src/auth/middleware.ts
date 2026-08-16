import { Request, Response, NextFunction } from 'express';
import { getSession } from './session';
import { isAllowedEmail } from './emailAllowlist';
import { bindLogIdentity } from '../api/middleware/requestLogger';

export const SESSION_COOKIE_NAME = 'sid';

/**
 * Verifies the session cookie and attaches `req.userEmail`. Used directly on
 * individual routes/routers (there is no blanket `app.use('/api', requireAuth)`
 * gate — issue #36 replaced that with per-route `requireAuthOrScope(...)`, so
 * every route/router that needs a session must apply this, or
 * `requireAuthOrScope`, itself). Re-checks the email domain allow-list on
 * every call, not just at login (issue #33) — same reasoning CLAUDE.md §6 and
 * `requireAdmin` (#32) already establish: a session must not keep access it no
 * longer qualifies for. A domain removed from `ALLOWED_EMAIL_DOMAINS`
 * invalidates every session using it on that session's very next request,
 * with no separate revocation step needed.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
    const session = sessionId ? await getSession(sessionId) : null;

    if (!session || !isAllowedEmail(session.email)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    (req as any).userEmail = session.email;
    bindLogIdentity(req, { userEmail: session.email });
    next();
  } catch (error: any) {
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
