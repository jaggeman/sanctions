import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));

const sendOtpEmail = vi.fn(async () => {});
vi.mock('../../src/auth/mailer', () => ({ sendOtpEmail: (...args: any[]) => sendOtpEmail(...args) }));

const { api } = await import('../../src/api');
const { _resetOtpStoreForTests } = await import('../../src/auth/otpStore');
const { _resetSessionStoreForTests } = await import('../../src/auth/session');

beforeEach(() => {
  _resetOtpStoreForTests();
  _resetSessionStoreForTests();
  sendOtpEmail.mockClear();
  vi.stubEnv('NODE_ENV', 'test');
});

describe('POST /api/auth/request-otp', () => {
  it('rejects a missing/invalid email', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({});
    expect(res.status).toBe(400);
  });

  it('sends an email with a generated code for a real address', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    expect(res.status).toBe(200);
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);
    expect(sendOtpEmail.mock.calls[0][0]).toBe('user@example.com');
    expect(sendOtpEmail.mock.calls[0][1]).toMatch(/^\d{6}$/);
  });

  it('does not send a real email for the hardcoded test account', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({ email: 'admin@sanctions.com' });
    expect(res.status).toBe(200);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/verify-otp', () => {
  it('logs in with the hardcoded test account code and sets a session cookie', async () => {
    const res = await request(api)
      .post('/api/auth/verify-otp')
      .send({ email: 'admin@sanctions.com', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^sid=/);
  });

  it('rejects the test account with a wrong code', async () => {
    const res = await request(api)
      .post('/api/auth/verify-otp')
      .send({ email: 'admin@sanctions.com', code: '000000' });
    expect(res.status).toBe(401);
  });

  it('logs in with a real generated code end-to-end', async () => {
    await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    const code = sendOtpEmail.mock.calls[0][1];

    const res = await request(api).post('/api/auth/verify-otp').send({ email: 'user@example.com', code });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^sid=/);
  });

  it('rejects an unknown/expired code', async () => {
    const res = await request(api)
      .post('/api/auth/verify-otp')
      .send({ email: 'nobody@example.com', code: '123456' });
    expect(res.status).toBe(401);
  });
});

describe('protected routes', () => {
  it('returns 401 for /api/search without a session cookie', async () => {
    const res = await request(api).get('/api/search').query({ q: 'test' });
    expect(res.status).toBe(401);
  });

  it('allows /api/search once authenticated', async () => {
    const agent = request.agent(api);
    await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
    const res = await agent.get('/api/search').query({ q: 'a b' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/auth/session', () => {
  it('returns 401 when logged out', async () => {
    const res = await request(api).get('/api/auth/session');
    expect(res.status).toBe(401);
  });

  it('returns the logged-in email when authenticated', async () => {
    const agent = request.agent(api);
    await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
    const res = await agent.get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('admin@sanctions.com');
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session so subsequent protected calls 401', async () => {
    const agent = request.agent(api);
    await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
    await agent.post('/api/auth/logout');
    const res = await agent.get('/api/auth/session');
    expect(res.status).toBe(401);
  });
});
