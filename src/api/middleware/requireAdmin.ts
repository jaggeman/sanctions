import { Request, Response, NextFunction } from 'express';

/**
 * Placeholder only — there is no admin authentication system yet, by
 * explicit product decision. Every request currently passes through.
 * Replace this with real admin auth before deploying these endpoints
 * anywhere reachable outside local dev. Tracked in issue #17.
 */
export function requireAdmin(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
