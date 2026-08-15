import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Issue #95, found via a live pen test: the API sent no hardening headers
// beyond Express's own defaults, and X-Powered-By actively disclosed the
// framework. These tests hit the real app end-to-end (not a specific route's
// logic) since the headers are applied globally.
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn(async () => ({ success: true, importedCounts: {} })) }));
vi.mock('../../src/auth/mailer', () => ({ sendOtpEmail: vi.fn(async () => {}) }));

const { api } = await import('../../src/api');

describe('security response headers (issue #95)', () => {
  it('does not disclose the framework via X-Powered-By', async () => {
    const res = await request(api).get('/openapi.json');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request(api).get('/openapi.json');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('blocks framing via X-Frame-Options or a CSP frame-ancestors directive', async () => {
    const res = await request(api).get('/openapi.json');
    const blocksFraming =
      res.headers['x-frame-options'] !== undefined ||
      (res.headers['content-security-policy'] || '').includes('frame-ancestors');
    expect(blocksFraming).toBe(true);
  });

  it('sets a Content-Security-Policy', async () => {
    const res = await request(api).get('/openapi.json');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });

  it('sets Strict-Transport-Security', async () => {
    const res = await request(api).get('/openapi.json');
    expect(res.headers['strict-transport-security']).toBeTruthy();
  });

  it('still serves the Swagger UI docs page without erroring', async () => {
    const res = await request(api).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger');
  });
});
