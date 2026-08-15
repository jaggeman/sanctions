import { Request, Response, NextFunction } from 'express';
import { getSession } from './session';

export const SESSION_COOKIE_NAME = 'sid';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  const session = sessionId ? getSession(sessionId) : null;

  if (!session) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  (req as any).userEmail = session.email;
  next();
}
