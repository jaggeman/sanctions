import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/logger';

export interface RequestWithLog extends Request {
  requestId: string;
  log: ReturnType<typeof logger.child>;
}

function levelForStatus(statusCode: number): 'info' | 'warn' | 'error' {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

// A client-supplied X-Request-Id is only used for correlation, never trusted
// as an identifier with any privilege — but an unvalidated value still ends
// up in every log line and the response header, so cap its shape before
// reusing it rather than letting a client bloat/pollute logs with arbitrary
// content.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function resolveRequestId(req: Request): string {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req);
  const log = logger.child({ requestId });
  const started = Date.now();

  (req as RequestWithLog).requestId = requestId;
  (req as RequestWithLog).log = log;
  res.setHeader('X-Request-Id', requestId);

  log.info('request.start', { method: req.method, path: req.path });

  res.on('finish', () => {
    const durationMs = Date.now() - started;
    const level = levelForStatus(res.statusCode);
    log[level]('request.finish', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
}
