import { Request, Response, NextFunction } from 'express';
import { isValidEntityId } from '../../shared/entityId';

/**
 * Express param callback (`.param('id', ...)`) — rejects an id before it
 * ever reaches a `.doc(id)` call. Register on every router that has a
 * route param named `id`: param callbacks are local to the router they're
 * defined on, they don't cascade from `app` into a mounted sub-router
 * (Express behavior, not a bug here) — see the routes wired in
 * src/api/index.ts, src/api/routes/overrides.ts, src/api/routes/tokens.ts.
 */
export function validateEntityIdParam(_req: Request, res: Response, next: NextFunction, value: string): void {
  if (!isValidEntityId(value)) {
    res.status(400).json({ error: `Invalid id "${value}" — must contain only letters, numbers, hyphens, and underscores.` });
    return;
  }
  next();
}
