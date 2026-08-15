import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const processUpload = vi.fn();
vi.mock('../../src/importer/uploadPipeline', () => ({ processUpload }));
vi.mock('../../src/shared/firebase', () => ({
  db: { collection: vi.fn() },
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
});
