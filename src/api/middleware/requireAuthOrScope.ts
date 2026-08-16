import { Request, Response, NextFunction, RequestHandler } from 'express';
import { requireAuth } from '../../auth/middleware';
import { requireScope } from './requireScope';
import { ApiTokenScope } from '../../shared/apiTokens';

/**
 * Issue #36: `requireScope` and `requireAuth` were both fully built, tested,
 * and never actually composed — the blanket `app.use('/api', requireAuth)`
 * gate rejects a bearer-token-only request before any route-level scope
 * check ever runs, so a freshly minted API token was accepted by no route.
 *
 * `requireScope` independently extracts and verifies its own bearer token
 * (see its own tests) and cannot simply run *alongside* the session-cookie
 * gate — a session user presents no `Authorization` header and would be
 * rejected. Composes the two here instead of modifying either: a bearer
 * token means "authenticate via API token, enforce `scope`"; its absence
 * means "authenticate via session cookie," same as before. Neither
 * `requireAuth` nor `requireScope` changes contract.
 */
export function requireAuthOrScope(scope: ApiTokenScope | ApiTokenScope[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.header('authorization') !== undefined) {
      requireScope(scope)(req, res, next);
      return;
    }
    requireAuth(req, res, next);
  };
}
