import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/logger';
import type { RequestWithLog } from './requestLogger';

// Express identifies error middleware by arity — keep all four parameters
// even though `next` is only used on the already-sent branch.
export function errorLogger(err: Error, req: Request, res: Response, next: NextFunction): void {
  const typedReq = req as RequestWithLog;
  const log = typedReq.log || logger;

  log.error('request.error', { method: req.method, path: req.path, error: err });

  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(500).json({
    error: 'Internal server error',
    requestId: typedReq.requestId,
  });
}
