import * as path from 'node:path';
import * as fs from 'node:fs';

export function getAllowedCsvDir(): string {
  return process.env.ALLOWED_CSV_DIR
    ? path.resolve(process.env.ALLOWED_CSV_DIR)
    : path.resolve(process.cwd(), 'data');
}

export interface CsvPathValidationResult {
  valid: boolean;
  absolutePath?: string;
  error?: string;
}

/**
 * Validates and resolves a client-supplied or option-supplied csvPath against the
 * permitted base directory (defaulting to `./data`), preventing arbitrary file
 * read vulnerabilities and directory traversal attacks (issue #157 / CLAUDE.md §6).
 */
export function validateCsvPath(
  rawPath: unknown,
  allowedDir: string = getAllowedCsvDir(),
): CsvPathValidationResult {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return {
      valid: false,
      error: '"csvPath" must be a non-empty string.',
    };
  }

  const trimmed = rawPath.trim();

  // Guard against null byte injections
  if (trimmed.includes('\0')) {
    return {
      valid: false,
      error: 'Invalid "csvPath": null bytes are not permitted.',
    };
  }

  // Resolve target path: if relative, resolve relative to allowedDir; if absolute, resolve directly
  const resolvedTarget = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(allowedDir, trimmed);

  const resolvedBase = path.resolve(allowedDir);

  // Check prefix containment via path.relative
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    return {
      valid: false,
      error: `Path traversal detected: "${trimmed}" is outside the permitted data directory.`,
    };
  }

  // If the file exists on disk, check for symlink traversal
  try {
    if (typeof fs?.existsSync === 'function' && fs.existsSync(resolvedTarget)) {
      const realTarget = fs.realpathSync(resolvedTarget);
      const realBase = fs.existsSync(resolvedBase) ? fs.realpathSync(resolvedBase) : resolvedBase;
      const realRel = path.relative(realBase, realTarget);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return {
          valid: false,
          error: `Symlink traversal detected: "${trimmed}" resolves outside the permitted data directory.`,
        };
      }
    }
  } catch (err: any) {
    return {
      valid: false,
      error: `Failed to inspect path "${trimmed}": ${err.message}`,
    };
  }

  return {
    valid: true,
    absolutePath: resolvedTarget,
  };
}
