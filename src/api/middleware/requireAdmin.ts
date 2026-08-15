import { Request, Response, NextFunction } from 'express';
import { getSession } from '../../auth/session';
import { SESSION_COOKIE_NAME } from '../../auth/middleware';
import { isAdminEmail } from '../../auth/admins';

/**
 * Gate for administrative endpoints.
 *
 * Resolves identity from the session store itself rather than from anything an
 * earlier middleware may have attached to the request, so the guard holds even
 * if the router is ever mounted without `requireAuth` in front of it. Nothing
 * the client can set — a header, a body field — is consulted.
 *
 * Membership is re-checked against the allow-list on every call, so revoking
 * someone's admin rights takes effect on their next request rather than when
 * their session eventually expires.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
    const session = sessionId ? await getSession(sessionId) : null;

    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!isAdminEmail(session.email)) {
      // 403 rather than 401: the caller is authenticated, they simply are not an
      // administrator. Answering 401 would tell a logged-in user to log in again.
      res.status(403).json({ error: 'Administrator access required' });
      return;
    }

    (req as any).userEmail = session.email;
    next();
  } catch (error: any) {
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
