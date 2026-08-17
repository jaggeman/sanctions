import * as fs from 'fs-extra';
import * as path from 'path';
import { hashFileStreaming } from './hashFile';
import { detectFormat, DetectedFormat } from './formatDetection';
import {
  createPendingImport,
  createFetchImportRecord,
  findAppliedImportBySha256,
  markImportApplied,
  markImportFailed,
  ImportAlreadyInFlightError,
} from './importRecord';
import { runImport, ImportOptions } from './index';
import { generateImportId } from './uploader';
import { ImportMode, StreamedDiffResult } from './diff';
import { getBucket } from '../shared/firebase';
import { SanctionSource } from '../shared/types';
import { logger } from '../shared/logger';

export interface ProcessUploadOptions {
  filePath: string;
  originalFilename: string;
  sourceHint: SanctionSource;
  uploadedBy: string | null;
  /** Diff-engine controls (issue #8), forwarded verbatim to runImport. */
  importOptions?: {
    mode?: ImportMode;
    dryRun?: boolean;
    force?: boolean;
    importId?: string;
    /** CSV field separator (issue #192) — only meaningful when the uploaded file is a CSV; defaults to ';'. */
    csvSeparator?: string;
  };
}

export type ProcessUploadResult =
  | { outcome: 'applied'; importId: string; counts: { parsed: number; uploaded: number } }
  | {
      outcome: 'dry_run';
      importId: string;
      counts: { parsed: number; uploaded: number };
      diffs?: StreamedDiffResult[];
    }
  | { outcome: 'rejected'; importId: string; duplicateOfImportId: string }
  | { outcome: 'in_flight'; importId: string }
  | { outcome: 'unsupported_format'; importId: string; format: DetectedFormat }
  | { outcome: 'failed'; importId: string; error: string };

// No parser exists yet for these two (see the claim/PR: real column names
// like `Naal_wholename` aren't mapped by the generic CSV parser) — reported
// as a clear failure rather than silently mis-parsed into garbage records.
const UNSUPPORTED_FORMATS = new Set<DetectedFormat>(['eu-csv-1.0', 'eu-csv-1.1']);

function formatToSource(format: DetectedFormat, sourceHint: SanctionSource): SanctionSource {
  if (format === 'eu-xml-1.1' || format === 'eu-csv-1.0' || format === 'eu-csv-1.1') return 'EU';
  if (format === 'un-xml') return 'UN';
  if (format === 'us-xml') return 'US';
  if (format === 'uk-xml') return 'UK';
  if (format === 'ch-xml') return 'CH';
  return sourceHint;
}

function formatForRunImport(format: DetectedFormat): 'eu-xml-1.1' | 'un-xml' | 'us-xml' | 'uk-xml' | 'ch-xml' | 'csv' {
  // eu-csv-1.0/1.1 never reach runImport — handled as unsupported below.
  return format === 'eu-xml-1.1' || format === 'un-xml' || format === 'us-xml' || format === 'uk-xml' || format === 'ch-xml' ? format : 'csv';
}

// The client-supplied filename must never reach the Cloud Storage object
// key (issue #94) — it's an untrusted string that can contain path
// separators, "..", or control characters. Only a short, bounded,
// alphanumeric extension is carried over; the base name is always the
// fixed string "upload". The original name is still preserved separately
// in the imports audit doc's `filename` field for display purposes.
function safeStorageExtension(originalFilename: string): string {
  const ext = path.extname(originalFilename);
  return /^\.[a-zA-Z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * Orchestrates issue #7's upload pipeline: hash the file, sniff its format,
 * reject an exact duplicate of an already-applied import, atomically claim
 * the sha256 as a pending import (racing uploads collide here, not later),
 * persist the raw bytes to Storage, then run the existing parse+upload
 * pipeline and record the outcome. Called from the POST /api/upload route.
 */
export async function processUpload(options: ProcessUploadOptions): Promise<ProcessUploadResult> {
  const { filePath, originalFilename, sourceHint, uploadedBy, importOptions } = options;

  const [{ sha256, sizeBytes }, head] = await Promise.all([
    hashFileStreaming(filePath),
    fs.readFile(filePath, 'utf-8').then((s) => s.slice(0, 4096)).catch(() => ''),
  ]);
  const { format, fileGenerationDate } = detectFormat(head);
  const source = formatToSource(format, sourceHint);

  const existingApplied = await findAppliedImportBySha256(sha256);
  if (existingApplied) {
    return { outcome: 'rejected', importId: sha256, duplicateOfImportId: existingApplied.importId };
  }

  // A dry run must leave no trace: no imports doc, no Storage object, no
  // writes. Recording it as an applied import would be actively harmful —
  // the sha256 dedup would then reject the real upload of the same file as a
  // duplicate of a preview that never wrote anything (issue #8 + #7).
  if (importOptions?.dryRun) {
    if (UNSUPPORTED_FORMATS.has(format)) {
      return { outcome: 'unsupported_format', importId: sha256, format };
    }
    const preview = await runImport({
      uploadedFile: { path: filePath, format: formatForRunImport(format), source },
      ...importOptions,
      dryRun: true,
    });
    const parsed = Object.values(preview.importedCounts).reduce((a, b) => a + b, 0);
    return { outcome: 'dry_run', importId: sha256, counts: { parsed, uploaded: 0 }, diffs: preview.diffs };
  }

  const storagePath = `imports/${sha256}/upload${safeStorageExtension(originalFilename)}`;

  try {
    await createPendingImport({
      importId: sha256,
      trigger: 'upload',
      filename: originalFilename,
      sha256,
      sizeBytes,
      storagePath,
      source,
      format,
      fileGenerationDate,
      uploadedBy,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ImportAlreadyInFlightError) {
      return { outcome: 'in_flight', importId: sha256 };
    }
    throw err;
  }

  if (UNSUPPORTED_FORMATS.has(format)) {
    await markImportFailed(sha256, `Parsing for ${format} is not yet implemented (tracked as a follow-up issue).`);
    return { outcome: 'unsupported_format', importId: sha256, format };
  }

  // Save a copy of the raw source file to Cloud Storage for audit/history
  try {
    await getBucket().file(storagePath).save(await fs.readFile(filePath));
  } catch (storageErr: any) {
    logger.warn('uploadPipeline.storage_save_failed', { storagePath, error: storageErr.message });
  }

  let result;
  try {
    result = await runImport({
      uploadedFile: { path: filePath, format: formatForRunImport(format), source },
      // Diff-engine controls (issue #8) forwarded from the upload request.
      ...importOptions,
    });
  } catch (err: any) {
    // runImport itself threw — nothing durable happened, so 'failed' is accurate here.
    await markImportFailed(sha256, err.message);
    return { outcome: 'failed', importId: sha256, error: err.message };
  }

  if (!result.success) {
    const error = result.error || 'Import failed with no further detail.';
    await markImportFailed(sha256, error);
    return { outcome: 'failed', importId: sha256, error };
  }

  const parsed = Object.values(result.importedCounts).reduce((a, b) => a + b, 0);
  try {
    await markImportApplied(sha256, { parsed, uploaded: parsed });
  } catch (err: any) {
    // issue #60: runImport already succeeded — real sanction records are
    // written. A failure in this bookkeeping call must never relabel that
    // success as 'failed' (markImportFailed would be a lie); the import doc
    // may be left at 'pending', but that's now covered by
    // createPendingImport's staleness-based retry instead of blocking
    // forever.
    logger.error('Import succeeded but markImportApplied bookkeeping failed', { sha256, error: err });
  }
  return { outcome: 'applied', importId: sha256, counts: { parsed, uploaded: parsed } };
}

export interface RunFetchImportOptions {
  sources?: ImportOptions['sources'];
  mode?: ImportMode;
  dryRun?: boolean;
  force?: boolean;
  uploadedBy: string | null;
}

/**
 * issue #256 (followup to #192): an official-source fetch has no local file
 * to sha256-dedup on before it runs — the download IS the side effect of
 * running it — so this can't reuse processUpload's dedup mechanism.
 * POST /api/import already solved exactly this (issue #111): a durable
 * `imports` audit doc keyed by a fresh importId, created before the fetch
 * runs and marked applied/failed once it resolves, instead of by sha256.
 * This is that same mechanism, synchronous rather than that route's
 * fire-and-forget Cloud Task — a CLI/MCP caller is already a long-running
 * process that wants the real result back directly, not a 202.
 */
export async function runFetchTriggeredImport(
  options: RunFetchImportOptions,
): Promise<Awaited<ReturnType<typeof runImport>>> {
  const { sources, mode, dryRun, force, uploadedBy } = options;

  // A dry run must leave no trace — same precedent as processUpload's own
  // dry-run handling just above.
  if (dryRun) {
    return runImport({ sources, mode, dryRun, force });
  }

  const importId = generateImportId();
  await createFetchImportRecord({
    importId,
    sources,
    mode,
    force,
    uploadedBy,
    uploadedAt: new Date().toISOString(),
  });

  let result: Awaited<ReturnType<typeof runImport>>;
  try {
    result = await runImport({ sources, mode, force, importId });
  } catch (err: any) {
    await markImportFailed(importId, err.message);
    throw err;
  }

  if (!result.success) {
    await markImportFailed(importId, result.error || 'Import failed with no further detail.');
    return result;
  }

  const parsed = Object.values(result.importedCounts).reduce((a, b) => a + b, 0);
  try {
    await markImportApplied(importId, { parsed, uploaded: parsed });
  } catch (err: any) {
    // Same precedent as processUpload above: the import already succeeded,
    // so a bookkeeping failure here must never relabel it as failed.
    logger.error('Import succeeded but markImportApplied bookkeeping failed', { importId, error: err });
  }
  return result;
}
