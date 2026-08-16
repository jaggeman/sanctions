import { Request, Response, NextFunction, RequestHandler } from 'express';
import { requireAdmin } from './requireAdmin';
import { requireScope } from './requireScope';
import { ApiTokenScope } from '../../shared/apiTokens';

/**
 * Composes requireAdmin for session cookies and requireScope for bearer tokens.
 *
 * An API token presented via `Authorization: Bearer <token>` must have the required scope(s)
 * and is attributed to the admin who minted it.
 * A session-based caller presents no bearer token and must be an administrator.
 */
export function requireAdminOrScope(scope: ApiTokenScope | ApiTokenScope[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.header('authorization') !== undefined) {
      requireScope(scope, { requireAdmin: true })(req, res, next);
      return;
    }
    requireAdmin(req, res, next);
  };
}
