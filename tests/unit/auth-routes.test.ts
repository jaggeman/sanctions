import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createFakeDb } from './helpers/fakeFirestore';

// A real fake here (not a bare `{ collection: vi.fn() }`) because
// src/auth/otpStore.ts and src/auth/session.ts now persist through `db`
// (issue #63) — this suite's request-otp/verify-otp/session/logout
// assertions depend on that round-tripping for real, not on mocked returns.
const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
// This file tests auth gating, not search behaviour (that's api-search.test.ts) —
// stub runSearch directly rather than giving the bare `db` mock above a real
// Firestore-shaped implementation it doesn't otherwise need.
vi.mock('../../src/search', () => ({
  runSearch: vi.fn(async () => ({ results: [], totalMatches: 0, truncated: false })),
}));

const sendOtpEmail = vi.fn(async () => {});
vi.mock('../../src/auth/mailer', () => ({ sendOtpEmail: (...args: any[]) => sendOtpEmail(...args) }));

const { api } = await import('../../src/api');

beforeEach(() => {
  resetFakeDb();
  sendOtpEmail.mockClear();
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/request-otp', () => {
  it('rejects a missing/invalid email', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({});
    expect(res.status).toBe(400);
  });

  it('sends an email with a generated code for a real address on an allowed domain', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    const res = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    expect(res.status).toBe(200);
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);
    expect(sendOtpEmail.mock.calls[0][0]).toBe('user@example.com');
    expect(sendOtpEmail.mock.calls[0][1]).toMatch(/^\d{6}$/);
  });

  it('issue #70: surfaces a rejected sendOtpEmail as a 500, not a silent success', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    sendOtpEmail.mockRejectedValueOnce(new Error('SMTP server unavailable'));

    const res = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    expect(res.status).toBe(500);
  });

  it('does not send a real email for the hardcoded test account', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({ email: 'admin@sanctions.com' });
    expect(res.status).toBe(200);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('rate limits a repeated request for the same email within the cooldown window (issue #16)', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    const first = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    expect(first.status).toBe(200);

    const second = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    expect(second.status).toBe(429);
    expect(sendOtpEmail).toHaveBeenCalledTimes(1); // no second email sent
  });

  it('issue #62: rejects with 429 once the global send budget is exhausted, across distinct addresses', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    const { OTP_GLOBAL_SEND_LIMIT } = await import('../../src/auth/otp');

    for (let i = 0; i < OTP_GLOBAL_SEND_LIMIT; i++) {
      const res = await request(api).post('/api/auth/request-otp').send({ email: `user${i}@example.com` });
      expect(res.status).toBe(200);
    }
    expect(sendOtpEmail).toHaveBeenCalledTimes(OTP_GLOBAL_SEND_LIMIT);

    const overBudget = await request(api).post('/api/auth/request-otp').send({ email: 'one-too-many@example.com' });
    expect(overBudget.status).toBe(429);
    expect(sendOtpEmail).toHaveBeenCalledTimes(OTP_GLOBAL_SEND_LIMIT); // no (limit+1)th email sent
  });

  it('issue #62: a flood of repeats against ONE already-cooling-down email never touches the global budget', async () => {
    // The per-email cooldown (issue #16) already rejects these — they must
    // not also burn through the global send budget, or a single attacker
    // spamming one address could exhaust it and deny service to everyone
    // else requesting a code for a genuinely different address.
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    const { OTP_GLOBAL_SEND_LIMIT } = await import('../../src/auth/otp');

    const first = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    expect(first.status).toBe(200);

    // Hammer the same, already-cooling-down email far more times than the
    // global budget would allow if each one were (wrongly) charged against it.
    for (let i = 0; i < OTP_GLOBAL_SEND_LIMIT + 5; i++) {
      const res = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
      expect(res.status).toBe(429);
    }

    // The budget is still intact — a fresh, different address can still get a code.
    const stillWorks = await request(api).post('/api/auth/request-otp').send({ email: 'different@example.com' });
    expect(stillWorks.status).toBe(200);
    expect(sendOtpEmail).toHaveBeenCalledTimes(2); // user@ once, different@ once
  });

  it('issue #33: rejects a domain not on the allow-list with the SAME response as an allowed address, sending no email', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');

    const allowed = await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    sendOtpEmail.mockClear();
    const disallowed = await request(api).post('/api/auth/request-otp').send({ email: 'attacker@evil.com' });

    expect(disallowed.status).toBe(allowed.status);
    expect(disallowed.body).toEqual(allowed.body);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('issue #33: production admits nobody when ALLOWED_EMAIL_DOMAINS is unset, not even the test account', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await request(api).post('/api/auth/request-otp').send({ email: 'admin@sanctions.com' });
    expect(res.status).toBe(200); // identical-looking response — no email, no error revealed
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('issue #33: the dev test account still gets a login code path when ALLOWED_EMAIL_DOMAINS is unset outside production', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({ email: 'admin@sanctions.com' });
    expect(res.status).toBe(200);
    // Handled by the pre-existing test-login branch (console-logged code, no
    // real email) — asserting here only that this account is not swept up by
    // the new allow-list rejection.
  });
});

describe('POST /api/auth/verify-otp', () => {
  it('logs in with the hardcoded test account code and sets a session cookie', async () => {
    const res = await request(api)
      .post('/api/auth/verify-otp')
      .send({ email: 'admin@sanctions.com', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^__session=/);
  });

  it('rejects the test account with a wrong code', async () => {
    const res = await request(api)
      .post('/api/auth/verify-otp')
      .send({ email: 'admin@sanctions.com', code: '000000' });
    expect(res.status).toBe(401);
  });

  it('logs in with a real generated code end-to-end', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    const code = sendOtpEmail.mock.calls[0][1];

    const res = await request(api).post('/api/auth/verify-otp').send({ email: 'user@example.com', code });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^__session=/);
  });

  it('rejects an unknown/expired code', async () => {
    const res = await request(api)
      .post('/api/auth/verify-otp')
      .send({ email: 'nobody@example.com', code: '123456' });
    expect(res.status).toBe(401);
  });

  it('issue #33: rejects a disallowed domain even with an objectively correct code (defense in depth)', async () => {
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    // Simulate a code actually existing for the disallowed address (e.g. one
    // issued before a domain was removed from the list) by going straight to
    // the OTP store, bypassing request-otp's own gate entirely — proving
    // verify-otp does its own independent check rather than relying on
    // request-otp having refused to ever create the code.
    const { createOtp } = await import('../../src/auth/otpStore');
    const code = (await createOtp('attacker@evil.com'))!;

    const res = await request(api).post('/api/auth/verify-otp').send({ email: 'attacker@evil.com', code });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired code.' });
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

  it('reports isAdmin: true for the dev test account (admins.ts falls back to it when ADMIN_EMAILS is unset)', async () => {
    const agent = request.agent(api);
    await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
    const res = await agent.get('/api/auth/session');
    expect(res.body.isAdmin).toBe(true);
  });

  it('reports isAdmin: false for a regular logged-in user not on the ADMIN_EMAILS allow-list', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'someone-else@example.com');
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    const code = sendOtpEmail.mock.calls[0][1];

    const agent = request.agent(api);
    await agent.post('/api/auth/verify-otp').send({ email: 'user@example.com', code });
    const res = await agent.get('/api/auth/session');
    expect(res.body.isAdmin).toBe(false);
  });

  it('reports isAdmin: true once ADMIN_EMAILS is set to include the caller, checked fresh (not cached)', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'user@example.com');
    vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
    await request(api).post('/api/auth/request-otp').send({ email: 'user@example.com' });
    const code = sendOtpEmail.mock.calls[0][1];

    const agent = request.agent(api);
    await agent.post('/api/auth/verify-otp').send({ email: 'user@example.com', code });
    const res = await agent.get('/api/auth/session');
    expect(res.body.isAdmin).toBe(true);
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
