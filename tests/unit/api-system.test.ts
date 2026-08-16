import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createFakeDb } from './helpers/fakeFirestore';

const { db: fakeDb, reset: resetFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const { systemRouter } = await import('../../src/api/routes/system');
const { createSession } = await import('../../src/auth/session');
const { SESSION_COOKIE_NAME } = await import('../../src/auth/middleware');

const ADMIN_EMAIL = 'admin@corp.test';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/system', systemRouter);
  return app;
}

const adminCookie = async () => `${SESSION_COOKIE_NAME}=${await createSession(ADMIN_EMAIL)}`;

describe('systemRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFakeDb();
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    process.env.ALLOWED_EMAIL_DOMAINS = 'corp.test';
  });

  describe('GET /api/system/status', () => {
    it('returns system health with database counts, functions status, and environment', async () => {
      const app = buildApp();
      const cookie = await adminCookie();

      const res = await request(app)
        .get('/api/system/status')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'healthy');
      expect(res.body).toHaveProperty('database');
      expect(res.body.database).toHaveProperty('connected', true);
      expect(res.body.database).toHaveProperty('counts');
      expect(res.body).toHaveProperty('functions');
      expect(Array.isArray(res.body.functions)).toBe(true);
      expect(res.body).toHaveProperty('releases');
      expect(res.body.releases.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const app = buildApp();

      const res = await request(app).get('/api/system/status');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/system/logs', () => {
    it('returns recent error/warn log events', async () => {
      const app = buildApp();
      const cookie = await adminCookie();

      const res = await request(app)
        .get('/api/system/logs')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('logs');
      expect(Array.isArray(res.body.logs)).toBe(true);
    });
  });

  describe('GET /api/system/releases', () => {
    it('returns the latest 3 releases with metadata', async () => {
      const app = buildApp();
      const cookie = await adminCookie();

      const res = await request(app)
        .get('/api/system/releases')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('releases');
      expect(res.body.releases.length).toBeLessThanOrEqual(3);
      expect(res.body.releases[0]).toHaveProperty('version');
      expect(res.body.releases[0]).toHaveProperty('deployedBy');
      expect(res.body.releases[0]).toHaveProperty('timestamp');
    });
  });
});
