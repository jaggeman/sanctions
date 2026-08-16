import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { validateCsvPath } from '../../src/importer/csvPath';

describe('validateCsvPath (issue #157 / CLAUDE.md §6)', () => {
  let testBaseDir: string;
  let testOutsideDir: string;

  beforeAll(async () => {
    testBaseDir = path.join(os.tmpdir(), `csvpath-test-base-${Date.now()}`);
    testOutsideDir = path.join(os.tmpdir(), `csvpath-test-outside-${Date.now()}`);

    await fs.ensureDir(testBaseDir);
    await fs.ensureDir(testOutsideDir);

    // Create a real file inside base dir
    await fs.writeFile(path.join(testBaseDir, 'valid.csv'), 'id;name\n1;Valid\n', 'utf-8');
    await fs.ensureDir(path.join(testBaseDir, 'sub'));
    await fs.writeFile(path.join(testBaseDir, 'sub', 'nested.csv'), 'id;name\n2;Nested\n', 'utf-8');

    // Create a real file outside base dir
    await fs.writeFile(path.join(testOutsideDir, 'secret.csv'), 'secret data', 'utf-8');

    // Create symlinks if OS permits
    try {
      await fs.symlink(
        path.join(testOutsideDir, 'secret.csv'),
        path.join(testBaseDir, 'symlink-outside.csv'),
      );
      await fs.symlink(
        path.join(testBaseDir, 'valid.csv'),
        path.join(testBaseDir, 'symlink-inside.csv'),
      );
    } catch {
      // Symlink creation may require admin privileges on some Windows setups; test will conditionally check
    }
  });

  afterAll(async () => {
    await fs.remove(testBaseDir);
    await fs.remove(testOutsideDir);
  });

  it('accepts a valid relative path within the permitted base directory', () => {
    const res = validateCsvPath('valid.csv', testBaseDir);
    expect(res.valid).toBe(true);
    expect(res.absolutePath).toBe(path.resolve(testBaseDir, 'valid.csv'));
  });

  it('accepts a valid nested relative path within the permitted base directory', () => {
    const res = validateCsvPath('sub/nested.csv', testBaseDir);
    expect(res.valid).toBe(true);
    expect(res.absolutePath).toBe(path.resolve(testBaseDir, 'sub', 'nested.csv'));
  });

  it('accepts a valid absolute path that is inside the permitted base directory', () => {
    const abs = path.resolve(testBaseDir, 'valid.csv');
    const res = validateCsvPath(abs, testBaseDir);
    expect(res.valid).toBe(true);
    expect(res.absolutePath).toBe(abs);
  });

  it('rejects path traversal using ../', () => {
    const res = validateCsvPath('../secret.csv', testBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);
  });

  it('rejects path traversal attempting to escape via subdirectories', () => {
    const res = validateCsvPath('sub/../../outside.csv', testBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);
  });

  it('rejects absolute paths outside the permitted base directory', () => {
    const outsidePath = path.resolve(testOutsideDir, 'secret.csv');
    const res = validateCsvPath(outsidePath, testBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);
  });

  it('rejects the base directory itself (must point to a file inside)', () => {
    const res = validateCsvPath('.', testBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);
  });

  it('rejects empty or non-string paths', () => {
    expect(validateCsvPath('', testBaseDir).valid).toBe(false);
    expect(validateCsvPath('   ', testBaseDir).valid).toBe(false);
    expect(validateCsvPath(null, testBaseDir).valid).toBe(false);
    expect(validateCsvPath(undefined, testBaseDir).valid).toBe(false);
    expect(validateCsvPath(123 as any, testBaseDir).valid).toBe(false);
  });

  it('rejects paths containing null bytes', () => {
    const res = validateCsvPath('valid.csv\0.txt', testBaseDir);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/null byte/i);
  });

  it('rejects symlinks that resolve outside the permitted directory', async () => {
    const symlinkOutside = path.join(testBaseDir, 'symlink-outside.csv');
    if (await fs.pathExists(symlinkOutside)) {
      const res = validateCsvPath('symlink-outside.csv', testBaseDir);
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/Symlink traversal detected/);
    }
  });

  it('accepts symlinks that resolve inside the permitted directory', async () => {
    const symlinkInside = path.join(testBaseDir, 'symlink-inside.csv');
    if (await fs.pathExists(symlinkInside)) {
      const res = validateCsvPath('symlink-inside.csv', testBaseDir);
      expect(res.valid).toBe(true);
    }
  });
});
