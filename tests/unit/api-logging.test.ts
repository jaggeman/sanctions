import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/auth/mailer', () => ({ sendOtpEmail: vi.fn(async () => {}) }));

const { api } = await import('../../src/api');

describe('request logging wired into the real API app', () => {
  it('stamps every response with an X-Request-Id header', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({});
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes back a client-supplied X-Request-Id for correlation', async () => {
    const res = await request(api)
      .post('/api/auth/request-otp')
      .set('X-Request-Id', 'trace-abc')
      .send({});
    expect(res.headers['x-request-id']).toBe('trace-abc');
  });

  // issue #66: requestLogger used to run after express.json()/cookieParser(),
  // so a body-parser error skipped straight to errorLogger without ever
  // assigning a request ID — the exact case these two tests cover.
  it('still stamps X-Request-Id even when the JSON body is malformed', async () => {
    const res = await request(api)
      .post('/api/auth/request-otp')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('includes requestId in the error response body for a malformed JSON request', async () => {
    const res = await request(api)
      .post('/api/auth/request-otp')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 400, not 500, for a malformed JSON body', async () => {
    const res = await request(api)
      .post('/api/auth/request-otp')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
  });
});
