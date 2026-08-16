import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLogger, bindLogIdentity } from '../../src/api/middleware/requestLogger';

function readJsonLines(spy: ReturnType<typeof vi.spyOn>): any[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

function buildApp() {
  const app = express();
  app.use(requestLogger);
  app.get('/ok', (req, res) => {
    (req as any).log.info('handler reached');
    res.json({ ok: true });
  });
  app.get('/boom', (req, res) => {
    res.status(500).json({ error: 'boom' });
  });
  return app;
}

describe('requestLogger middleware', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('LOG_LEVEL', 'debug');
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('assigns a request id and returns it as a response header', async () => {
    const res = await request(buildApp()).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses an incoming X-Request-Id for correlation instead of minting a new one', async () => {
    const res = await request(buildApp()).get('/ok').set('X-Request-Id', 'client-supplied-id');
    expect(res.headers['x-request-id']).toBe('client-supplied-id');
  });

  it('mints a fresh id instead of trusting an overly long client-supplied one', async () => {
    const res = await request(buildApp()).get('/ok').set('X-Request-Id', 'x'.repeat(200));
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints a fresh id instead of trusting a client-supplied one with unsafe characters', async () => {
    const res = await request(buildApp()).get('/ok').set('X-Request-Id', 'bad value"}');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('attaches req.log so handlers can log with the request context bound in', async () => {
    await request(buildApp()).get('/ok');
    const entries = readJsonLines(logSpy);
    const handlerLine = entries.find((e) => e.message === 'handler reached');
    expect(handlerLine).toBeDefined();
    expect(handlerLine.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs a start and finish line with method, path, status and duration', async () => {
    await request(buildApp()).get('/ok');
    const entries = readJsonLines(logSpy);
    const start = entries.find((e) => e.message === 'request.start');
    const finish = entries.find((e) => e.message === 'request.finish');

    expect(start).toMatchObject({ method: 'GET', path: '/ok' });
    expect(finish).toMatchObject({ method: 'GET', path: '/ok', statusCode: 200 });
    expect(typeof finish.durationMs).toBe('number');
    expect(finish.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs the finish line at warn/error level for 4xx/5xx responses', async () => {
    await request(buildApp()).get('/boom');
    const warnEntries = readJsonLines(warnSpy);
    const errorEntries = readJsonLines(errorSpy);
    const finishAsError = errorEntries.find((e) => e.message === 'request.finish');
    expect(finishAsError).toMatchObject({ statusCode: 500 });
    expect(warnEntries.find((e) => e.message === 'request.finish')).toBeUndefined();
  });

  // --- issue #110 ------------------------------------------------------

  it('does not include a userEmail/tokenId field for an unauthenticated request — not a crash, not a blank string', async () => {
    await request(buildApp()).get('/ok');
    const entries = readJsonLines(logSpy);
    const finish = entries.find((e) => e.message === 'request.finish');
    expect(finish.userEmail).toBeUndefined();
    expect(finish.tokenId).toBeUndefined();
  });

  it('lets downstream middleware bind the caller identity into req.log, picked up by every later log call in the same request', async () => {
    const app = express();
    app.use(requestLogger);
    app.get(
      '/ok',
      (req, res, next) => {
        bindLogIdentity(req, { userEmail: 'analyst@example.com' });
        next();
      },
      (req, res) => {
        (req as any).log.info('handler reached');
        res.json({ ok: true });
      },
    );

    await request(app).get('/ok');
    const entries = readJsonLines(logSpy);
    const handlerLine = entries.find((e) => e.message === 'handler reached');
    const finish = entries.find((e) => e.message === 'request.finish');

    // src/shared/logger.ts already redacts any embedded email address
    // (issue #67) — the identity is present, just masked, same as any other
    // logged field would be.
    expect(handlerLine.userEmail).toBe('a***@example.com');
    // issue #110: request.finish is logged from a res.on('finish') callback
    // registered before identity is known — it must read the current
    // req.log, not a stale reference captured at request start, or identity
    // bound by auth middleware would never reach this specific log line.
    expect(finish.userEmail).toBe('a***@example.com');
  });

  it('is a no-op when req.log does not exist (e.g. a bare router with no requestLogger mounted)', () => {
    const bareReq: any = {};
    expect(() => bindLogIdentity(bareReq, { userEmail: 'x@example.com' })).not.toThrow();
    expect(bareReq.log).toBeUndefined();
  });
});
