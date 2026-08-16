import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Real incident: Firebase Hosting's CDN (Fastly) treats a response with no
// Cache-Control as publicly cacheable, and its default policy for cacheable
// paths strips the inbound Cookie request header before it reaches the
// origin function. Every /api/* response is dynamic and cookie-gated —
// caching it (or letting the CDN infer it's cacheable from a missing header)
// silently breaks cookie-based auth for every GET route. Confirmed live: the
// session cookie was set correctly by POST verify-otp, but GET
// /api/auth/session immediately 401'd through the Hosting rewrite while the
// identical request against the underlying Cloud Run URL worked fine.
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/auth/mailer', () => ({ sendOtpEmail: vi.fn(async () => {}) }));

const { api, app } = await import('../../src/api');

describe('/api/* responses are never cacheable', () => {
  it('sets Cache-Control: no-store on an unauthenticated /api route', async () => {
    const res = await request(api).post('/api/auth/request-otp').send({});
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets Cache-Control: no-store on an authenticated GET /api route, even when it 401s', async () => {
    const res = await request(api).get('/api/auth/session');
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not apply to non-/api routes like /openapi.json', async () => {
    const res = await request(api).get('/openapi.json');
    expect(res.headers['cache-control']).not.toBe('no-store');
  });

  it('registers Cache-Control: no-store on /api exactly once (issue #190)', () => {
    const routerStack = app._router?.stack || [];
    const cacheControlLayers = routerStack.filter((layer: any) => {
      if (typeof layer.handle !== 'function') return false;
      const fnStr = layer.handle.toString();
      return fnStr.includes('no-store') || fnStr.includes('Cache-Control');
    });
    expect(cacheControlLayers).toHaveLength(1);
  });
});
