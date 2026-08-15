import * as fs from 'fs-extra';
import { hashFileStreaming } from './hashFile';
import { detectFormat, DetectedFormat } from './formatDetection';
import {
  createPendingImport,
  findAppliedImportBySha256,
  markImportApplied,
  markImportFailed,
  ImportAlreadyInFlightError,
} from './importRecord';
import { runImport } from './index';
import { ImportMode, StreamedDiffResult } from './diff';
import { getBucket } from '../shared/firebase';
import { SanctionSource } from '../shared/types';

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
  return sourceHint;
}

function formatForRunImport(format: DetectedFormat): 'eu-xml-1.1' | 'un-xml' | 'us-xml' | 'csv' {
  // eu-csv-1.0/1.1 never reach runImport — handled as unsupported below.
  return format === 'eu-xml-1.1' || format === 'un-xml' || format === 'us-xml' ? format : 'csv';
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

  const storagePath = `imports/${sha256}/${originalFilename}`;

  try {
    await createPendingImport({
      importId: sha256,
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

  try {
    await getBucket().file(storagePath).save(await fs.readFile(filePath));

    const result = await runImport({
      uploadedFile: { path: filePath, format: formatForRunImport(format), source },
      // Diff-engine controls (issue #8) forwarded from the upload request.
      ...importOptions,
    });

    if (!result.success) {
      const error = result.error || 'Import failed with no further detail.';
      await markImportFailed(sha256, error);
      return { outcome: 'failed', importId: sha256, error };
    }

    const parsed = Object.values(result.importedCounts).reduce((a, b) => a + b, 0);
    await markImportApplied(sha256, { parsed, uploaded: parsed });
    return { outcome: 'applied', importId: sha256, counts: { parsed, uploaded: parsed } };
  } catch (err: any) {
    await markImportFailed(sha256, err.message);
    return { outcome: 'failed', importId: sha256, error: err.message };
  }
}
