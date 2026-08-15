import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLogger } from '../../src/api/middleware/requestLogger';

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
});
