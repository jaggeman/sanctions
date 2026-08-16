import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/logger';
import type { RequestWithLog } from './requestLogger';

// Express identifies error middleware by arity — keep all four parameters
// even though `next` is only used on the already-sent branch.
export function errorLogger(err: Error, req: Request, res: Response, next: NextFunction): void {
  const typedReq = req as RequestWithLog;
  const log = typedReq.log || logger;

  // issue #66: an unconditional 500 mislabels a client-caused error (e.g. a
  // body-parser SyntaxError, naturally a 400) as a server fault, both in the
  // response and in the log level — which also pollutes the error-level log
  // stream with what's actually routine bad input, making genuine server
  // failures harder to spot by volume.
  const status = (err as any).status || (err as any).statusCode || 500;
  const isServerError = status >= 500;
  const message = isServerError ? 'Internal server error' : err.message || 'Bad request';

  log[isServerError ? 'error' : 'warn']('request.error', { method: req.method, path: req.path, error: err });

  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(status).json({
    error: message,
    requestId: typedReq.requestId,
  });
}
