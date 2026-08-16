import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createFakeDb } from './helpers/fakeFirestore';

const processUpload = vi.fn();
vi.mock('../../src/importer/uploadPipeline', () => ({ processUpload }));

// issue #153: the force-guard tests below drive the bearer-token auth path.
// Only `verifyApiToken` is replaced — everything else in the module stays
// real, so the tokens router it also feeds keeps working.
const { mockVerifyApiToken } = vi.hoisted(() => ({ mockVerifyApiToken: vi.fn() }));
vi.mock('../../src/shared/apiTokens', async () => {
  const actual = await vi.importActual<typeof import('../../src/shared/apiTokens')>(
    '../../src/shared/apiTokens',
  );
  return { ...actual, verifyApiToken: mockVerifyApiToken };
});

// Issue #63: this suite logs in through the real POST /api/auth/verify-otp
// route (below), which now persists the session through `db` — a bare
// `{ collection: vi.fn() }` stub no longer works since it returns undefined
// on any call.
const { db: authFakeDb } = createFakeDb();
vi.mock('../../src/shared/firebase', () => ({
  db: authFakeDb,
  getBucket: () => ({ file: vi.fn(() => ({ save: vi.fn() })) }),
}));
vi.mock('../../src/importer', () => ({ runImport: vi.fn() }));
vi.mock('../../src/search', () => ({ runSearch: vi.fn() }));
vi.stubEnv('NODE_ENV', 'test');

const removeMock = vi.fn(async () => {});
vi.mock('fs-extra', async () => {
  const actual = await vi.importActual<typeof import('fs-extra')>('fs-extra');
  return { ...actual, remove: removeMock, default: { ...(actual as any).default, remove: removeMock } };
});

const { api } = await import('../../src/api');
// Dynamic, not static: session.ts transitively imports src/shared/firebase,
// and a static import here would be hoisted above the `authFakeDb`
// initialization above, throwing "Cannot access 'fakeDb' before initialization".
const { createSession } = await import('../../src/auth/session');
const { SESSION_COOKIE_NAME } = await import('../../src/auth/middleware');
const agent = request.agent(api);

beforeEach(async () => {
  vi.clearAllMocks();
  await agent.post('/api/auth/verify-otp').send({ email: 'admin@sanctions.com', code: '123456' });
});

describe('POST /api/upload', () => {
  it('rejects a request with no file attached', async () => {
    const res = await agent.post('/api/upload').field('source', 'PEP');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
    expect(processUpload).not.toHaveBeenCalled();
  });

  it('rejects a file with a disallowed extension with 400 (multer fileFilter, unrelated to this rewrite)', async () => {
    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', Buffer.from('not a real binary'), 'payload.exe');

    expect(res.status).toBe(400);
    expect(processUpload).not.toHaveBeenCalled();
  });

  it('rejects a file over the size limit with 413 (multer limits, unrelated to this rewrite)', async () => {
    const oversized = Buffer.alloc(65 * 1024 * 1024, 'a'); // over the 64 MB cap
    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', oversized, 'huge.csv');

    expect(res.status).toBe(413);
    expect(processUpload).not.toHaveBeenCalled();
  });

  it('rejects an invalid source value rather than letting it flow through unvalidated', async () => {
    const res = await agent
      .post('/api/upload')
      .field('source', 'DROP TABLE')
      .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

    expect(res.status).toBe(400);
    expect(processUpload).not.toHaveBeenCalled();
  });

  it('applies successfully and reports the import id and counts', async () => {
    processUpload.mockResolvedValue({
      outcome: 'applied',
      importId: 'abc123',
      counts: { parsed: 5, uploaded: 5 },
    });

    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('applied');
    expect(res.body.importId).toBe('abc123');
    expect(res.body.counts).toEqual({ parsed: 5, uploaded: 5 });
    expect(processUpload).toHaveBeenCalledWith(expect.objectContaining({
      originalFilename: 'people.csv',
      sourceHint: 'PEP',
      uploadedBy: 'admin@sanctions.com',
    }));
  });

  it('reports a clear rejection message naming the earlier import (dedup)', async () => {
    processUpload.mockResolvedValue({
      outcome: 'rejected',
      importId: 'abc123',
      duplicateOfImportId: 'earlier-import-id',
    });

    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
    expect(res.body.duplicateOfImportId).toBe('earlier-import-id');
  });

  it('reports 409 when a concurrent upload of the same content is already in flight', async () => {
    processUpload.mockResolvedValue({ outcome: 'in_flight', importId: 'abc123' });

    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

    expect(res.status).toBe(409);
  });

  it('reports 422 for a detected-but-unsupported format', async () => {
    processUpload.mockResolvedValue({ outcome: 'unsupported_format', importId: 'abc123', format: 'eu-csv-1.0' });

    const res = await agent
      .post('/api/upload')
      .field('source', 'EU')
      .attach('file', Buffer.from('Date_file;Entity_logical_id\n05/08/2026;1\n'), 'eu.csv');

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/eu-csv-1.0/);
  });

  it('reports 500 with the recorded error when the import failed', async () => {
    processUpload.mockResolvedValue({ outcome: 'failed', importId: 'abc123', error: 'parse blew up' });

    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('parse blew up');
  });

  it('returns 500 if processUpload itself throws unexpectedly', async () => {
    processUpload.mockRejectedValue(new Error('unexpected boom'));

    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

    expect(res.status).toBe(500);
    expect(res.body.details).toBe('unexpected boom');
  });

  it('cleans up the multer temp file after processing, success or failure', async () => {
    processUpload.mockResolvedValue({ outcome: 'applied', importId: 'abc123', counts: { parsed: 1, uploaded: 1 } });

    await agent.post('/api/upload').field('source', 'PEP').attach('file', Buffer.from('x'), 'x.csv');

    expect(removeMock).toHaveBeenCalled();
  });

  it('dryRun:"true" previews without writing, and leaves no imports doc behind', async () => {
    // Response shape changed with #7's upload rewrite: the route reports
    // processUpload's outcome, not runImport's raw result. 'dry_run' is
    // deliberately distinct from 'applied' — a preview must not create an
    // imports doc, or sha256 dedup would later reject the real upload of the
    // same file as a duplicate of a preview that wrote nothing.
    const { processUpload } = await import('../../src/importer/uploadPipeline');
    (processUpload as any).mockResolvedValueOnce({
      outcome: 'dry_run',
      importId: 'abc123',
      counts: { parsed: 1, uploaded: 0 },
      diffs: [{ source: 'PEP', counts: { parsed: 1, added: 1, updated: 0, unchanged: 0, delisted: 0, skipped: 0 } }],
    });

    const res = await agent
      .post('/api/upload')
      .field('source', 'PEP')
      .field('dryRun', 'true')
      .attach('file', Buffer.from('id;name\n1;Test Person\n'), 'people.csv');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dry_run');
    expect(res.body.diffs[0].counts.added).toBe(1);
    expect(processUpload).toHaveBeenCalledWith(
      expect.objectContaining({ importOptions: expect.objectContaining({ dryRun: true }) }),
    );
  });

  // Issue #105: force:true bypasses the diff engine's delist safety guard —
  // restricted to admin sessions specifically (multipart fields always
  // arrive as strings, so 'true' rather than the boolean true).
  describe('force:true restricted to admins (issue #105)', () => {
    it('allows force:true for an admin session', async () => {
      processUpload.mockResolvedValue({ outcome: 'applied', importId: 'abc123', counts: { parsed: 1, uploaded: 1 } });

      const res = await agent
        .post('/api/upload')
        .field('source', 'PEP')
        .field('force', 'true')
        .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

      expect(res.status).toBe(200);
      expect(processUpload).toHaveBeenCalledWith(
        expect.objectContaining({ importOptions: expect.objectContaining({ force: true }) }),
      );
    });

    it('rejects force:true for a logged-in non-admin session with 403, and cleans up the temp file', async () => {
      vi.stubEnv('ALLOWED_EMAIL_DOMAINS', 'example.com');
      const sid = await createSession('analyst@example.com');

      const res = await request(api)
        .post('/api/upload')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${sid}`)
        .field('source', 'PEP')
        .field('force', 'true')
        .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/admin/i);
      expect(processUpload).not.toHaveBeenCalled();
      expect(removeMock).toHaveBeenCalled();
      vi.unstubAllEnvs();
    });
  });

  // issue #153: the #105 guard above reads `req.userEmail` and assumed a
  // bearer token never sets one. Token owner-attribution (#123) then began
  // setting `req.userEmail` from the token's `ownerEmail` — and since only
  // an admin can mint a token, that address is always an ADMIN_EMAILS one,
  // so every write-scoped token silently satisfied the admin check.
  //
  // These use `admin@sanctions.com` as the owner deliberately: it IS an
  // admin (the dev fallback in src/auth/admins.ts), which is exactly what
  // makes the bypass reachable. A non-admin owner would pass for the wrong
  // reason and wouldn't prove anything.
  describe('force:true is refused on the API-token path, even when the token owner is an admin (issue #153)', () => {
    const adminOwnedWriteToken = {
      valid: true,
      tokenId: 'tok_mcp_integration',
      scopes: ['write'],
      ownerEmail: 'admin@sanctions.com',
    };

    it('rejects force:true from a write-scoped token with 403 and cleans up the temp file', async () => {
      mockVerifyApiToken.mockResolvedValue(adminOwnedWriteToken);

      const res = await request(api)
        .post('/api/upload')
        .set('Authorization', 'Bearer tok_raw_value')
        .field('source', 'PEP')
        .field('force', 'true')
        .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/admin/i);
      expect(processUpload).not.toHaveBeenCalled();
      expect(removeMock).toHaveBeenCalled();
    });

    it('still allows a write-scoped token to upload normally when it is not asking to force', async () => {
      mockVerifyApiToken.mockResolvedValue(adminOwnedWriteToken);
      processUpload.mockResolvedValue({ outcome: 'applied', importId: 'abc123', counts: { parsed: 1, uploaded: 1 } });

      const res = await request(api)
        .post('/api/upload')
        .set('Authorization', 'Bearer tok_raw_value')
        .field('source', 'PEP')
        .attach('file', Buffer.from('id;name\n1;Test\n'), 'people.csv');

      expect(res.status).toBe(200);
      expect(processUpload).toHaveBeenCalledWith(
        expect.objectContaining({ importOptions: expect.objectContaining({ force: false }) }),
      );
    });
  });
});
