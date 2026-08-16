import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLogger, bindLogIdentity } from '../../src/api/middleware/requestLogger';
import { errorLogger } from '../../src/api/middleware/errorLogger';

function readJsonLines(spy: ReturnType<typeof vi.spyOn>): any[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

function buildApp() {
  const app = express();
  app.use(requestLogger);
  app.get('/throws', () => {
    throw new Error('handler exploded');
  });
  app.get('/already-sent', (req, res, next) => {
    res.status(200).json({ ok: true });
    next(new Error('too late'));
  });
  app.use(errorLogger);
  return app;
}

describe('errorLogger middleware', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('LOG_LEVEL', 'debug');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns a safe generic 500 JSON body instead of leaking the error', async () => {
    const res = await request(buildApp()).get('/throws');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs the error with name/message/stack and request context', async () => {
    await request(buildApp()).get('/throws');
    const entries = readJsonLines(errorSpy);
    const errorLine = entries.find((e) => e.message === 'request.error');
    expect(errorLine).toBeDefined();
    expect(errorLine.error.message).toBe('handler exploded');
    expect(typeof errorLine.error.stack).toBe('string');
    expect(errorLine.path).toBe('/throws');
    expect(errorLine.method).toBe('GET');
  });

  it('does not attempt a second response when headers were already sent', async () => {
    // Supertest resolves on the first response; this just proves the request
    // completes without an unhandled "ERR_HTTP_HEADERS_SENT" crash.
    const res = await request(buildApp()).get('/already-sent');
    expect(res.status).toBe(200);
  });

  // --- issue #110 ------------------------------------------------------

  it('includes identity bound earlier in the pipeline by an auth middleware', async () => {
    const app = express();
    app.use(requestLogger);
    app.get('/throws', (req, res) => {
      bindLogIdentity(req, { userEmail: 'analyst@example.com' });
      throw new Error('handler exploded');
    });
    app.use(errorLogger);

    await request(app).get('/throws');
    const entries = readJsonLines(errorSpy);
    const errorLine = entries.find((e) => e.message === 'request.error');
    expect(errorLine.userEmail).toBe('a***@example.com');
  });
});
