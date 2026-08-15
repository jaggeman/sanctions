import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { hashFileStreaming } from '../../src/importer/hashFile';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hashfile-test-'));
});

afterAll(async () => {
  await fs.remove(tmpDir);
});

describe('hashFileStreaming', () => {
  it('produces the same sha256 crypto.createHash would for the same content', async () => {
    const content = 'a'.repeat(10_000) + 'some real-ish content\n';
    const file = path.join(tmpDir, 'a.txt');
    await fs.writeFile(file, content);

    const expected = crypto.createHash('sha256').update(content).digest('hex');
    const result = await hashFileStreaming(file);

    expect(result.sha256).toBe(expected);
    expect(result.sizeBytes).toBe(Buffer.byteLength(content));
  });

  it('produces identical hashes for byte-identical files with different names', async () => {
    const content = 'duplicate file content, same bytes every time\n'.repeat(100);
    const fileA = path.join(tmpDir, 'copy-a.csv');
    const fileB = path.join(tmpDir, 'copy-b (1).csv');
    await fs.writeFile(fileA, content);
    await fs.writeFile(fileB, content);

    const [a, b] = await Promise.all([hashFileStreaming(fileA), hashFileStreaming(fileB)]);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sizeBytes).toBe(b.sizeBytes);
  });

  it('produces different hashes for files differing by a single byte', async () => {
    const fileA = path.join(tmpDir, 'diff-a.txt');
    const fileB = path.join(tmpDir, 'diff-b.txt');
    await fs.writeFile(fileA, 'content-A');
    await fs.writeFile(fileB, 'content-B');

    const [a, b] = await Promise.all([hashFileStreaming(fileA), hashFileStreaming(fileB)]);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('rejects for a file that does not exist', async () => {
    await expect(hashFileStreaming(path.join(tmpDir, 'does-not-exist.csv'))).rejects.toThrow();
  });
});

describe('hashFileStreaming — real duplicate files (issue #7 acceptance criterion)', () => {
  const LISTS_DIR = 'C:/Sanctions/lists';

  it('confirms the six real copies of 20260805-FULL-1_0.csv are byte-identical', async () => {
    const names = [
      '20260805-FULL-1_0.csv',
      '20260805-FULL-1_0 (1).csv',
      '20260805-FULL-1_0 (2).csv',
      '20260805-FULL-1_0 (3).csv',
      '20260805-FULL-1_0 (4).csv',
      '20260805-FULL-1_0 (5).csv',
    ];
    const hashes = await Promise.all(names.map((n) => hashFileStreaming(path.join(LISTS_DIR, n))));
    const uniqueHashes = new Set(hashes.map((h) => h.sha256));
    expect(uniqueHashes.size).toBe(1);
  }, 30_000);

  it('confirms the four distinct real files hash differently from each other', async () => {
    const names = [
      '20260805-FULL-1_0.csv',
      '20260805-FULL-1_1.csv',
      '20260805-FULL-1_1(xsd).xml',
      'eu_sanktionslista_screening_2026-08-15.csv',
    ];
    const hashes = await Promise.all(names.map((n) => hashFileStreaming(path.join(LISTS_DIR, n))));
    const uniqueHashes = new Set(hashes.map((h) => h.sha256));
    expect(uniqueHashes.size).toBe(4);
  }, 30_000);
});
