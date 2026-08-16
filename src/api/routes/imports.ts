import { Router, Request, Response, NextFunction } from 'express';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import multer from 'multer';
import { enqueueImportTask } from '../../importer/taskQueue';
import { runImport } from '../../importer';
import { processUpload } from '../../importer/uploadPipeline';
import { listImports, findImportBySha256, createFetchImportRecord, markImportFailed } from '../../importer/importRecord';
import { validateCsvPath } from '../../importer/csvPath';
import { generateImportId } from '../../importer/uploader';
import { SanctionSource } from '../../shared/types';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';
import { isAdminEmail } from '../../auth/admins';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // real EU FSD export is ~25 MB
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.csv', '.xml']);
const ALLOWED_SOURCES = new Set<SanctionSource>(['EU', 'UN', 'US', 'PEP', 'CUSTOM']);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      return cb(new Error(`Unsupported file type "${ext}". Only .csv and .xml are accepted.`));
    }
    cb(null, true);
  },
});

// Runs multer's single-file parsing, mapping its errors to the right HTTP
// status instead of letting them fall through to the generic Express error
// handler.
function uploadSingleFile(fieldName: string) {
  const middleware = upload.single(fieldName);
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, (err: any) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.` });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    });
  };
}

// Allow-list for Firestore document IDs taken from a URL path param (CLAUDE.md
// §6) — rejects '/' and other structural characters so a client can't smuggle
// a multi-segment path (e.g. "../otherCollection/doc") into .doc(id).
const DOC_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
// importId (issue #8) becomes a Firestore document ID under
// sanctions/{id}/versions/{importId} — validate it before it ever reaches
// there, same as any other client-supplied value used as a storage key
// (CLAUDE.md §6). Matches the shape runImport auto-generates
// (import_<timestamp>_<hex>) plus reasonable room for a caller-chosen id.
const IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `force: true` bypasses the diff engine's delist safety guard (issue #8) —
 * the one thing standing between a bad import and mass-delisting a whole
 * sanctions source. `requireAuthOrScope('write')` alone only proves the
 * caller is logged in (or holds a write-scoped token), not that they're
 * trusted with overriding a safety mechanism — restricting it to real admin
 * sessions specifically (issue #105).
 *
 * The token check below is load-bearing and must not be reduced back to an
 * `isAdminEmail` test alone (issue #153). This guard originally relied on a
 * bearer token carrying no identity, so that `req.userEmail` being set
 * implied a session. Token owner-attribution (#123) broke that assumption:
 * `requireScope` now sets `req.userEmail` from the token's `ownerEmail`,
 * and since only an admin can mint a token, that address always passes
 * `isAdminEmail` — every write-scoped token silently satisfied this guard.
 *
 * Identity is therefore not sufficient; the *authentication method* is what
 * matters. `req.apiTokenId` is set only by `requireScope`, never by
 * `requireAuth`, and `requireAuthOrScope` routes to exactly one of the two,
 * so its presence is a reliable "this caller is a token, not a session".
 */
function assertForceAllowed(req: Request, res: Response, force: boolean): boolean {
  if (!force) return true;

  if (req.apiTokenId) {
    res.status(403).json({
      error: '"force" (delist safety guard override) requires an admin session; an API token cannot be used for it.',
    });
    return false;
  }

  const email = (req as any).userEmail;
  if (!email || !isAdminEmail(email)) {
    res.status(403).json({ error: '"force" (delist safety guard override) requires an admin session.' });
    return false;
  }

  console.warn(`[audit] Delist guard override (force=true) used by ${email}`);
  return true;
}

export const importsRouter = Router();

/**
 * GET /api/imports
 * List import audit records, newest first (issue #12 — import history view).
 */
importsRouter.get('/imports', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  const requestedLimit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  try {
    const imports = await listImports(requestedLimit);
    res.json(imports);
  } catch (error: any) {
    console.error('List imports error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/imports/:id
 * Retrieve a single import's detail (issue #12).
 */
importsRouter.get('/imports/:id', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  const { id } = req.params;
  if (!DOC_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'Invalid import ID.' });
  }

  try {
    const record = await findImportBySha256(id);
    if (!record) {
      return res.status(404).json({ error: `Import with ID ${id} not found.` });
    }
    res.json(record);
  } catch (error: any) {
    console.error('Get import detail error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * POST /api/import
 * Queue a full import (issue #43). Handed off to `runImportTask`, a Cloud
 * Tasks-dispatched function with its own instance/timeout budget, instead of
 * running in-process here: a multi-minute import awaited in this same
 * function would tie up a request-serving instance for the duration, and a
 * bare fire-and-forget call is not guaranteed to run to completion if this
 * instance freezes/recycles right after the response is sent. Cloud Tasks
 * durably persists and retries the job independent of this request's own
 * fate, so the 202 below is now actually true rather than merely optimistic.
 *
 * Accepts either a logged-in session or a `write`-scoped API token (issue #36).
 */
importsRouter.post('/import', requireAuthOrScope('write'), async (req, res): Promise<any> => {
  // mode/dryRun/force/importId drive the diff engine (issue #8).
  const { sources, csvPath, mode, dryRun, force, importId } = req.body;

  // Validate sources if provided
  if (sources && !Array.isArray(sources)) {
    return res.status(400).json({ error: '"sources" must be an array.' });
  }
  if (mode !== undefined && mode !== 'sync' && mode !== 'append') {
    return res.status(400).json({ error: '"mode" must be "sync" or "append".' });
  }
  if (importId !== undefined && !IMPORT_ID_PATTERN.test(importId)) {
    return res.status(400).json({ error: '"importId" must match ^[A-Za-z0-9_-]{1,128}$.' });
  }
  if (csvPath !== undefined) {
    const csvValidation = validateCsvPath(csvPath);
    if (!csvValidation.valid) {
      return res.status(400).json({ error: csvValidation.error });
    }
  }
  if (!assertForceAllowed(req, res, !!force)) return;

  // A dry run must leave no trace (same precedent as uploadPipeline.ts's
  // dry-run path) — no audit doc, since it never actually applies anything.
  // Resolve the real importId here, before dryRun's early return, so the
  // dry-run's own DiffResults (which get stamped with importId internally
  // for record versioning) and a real apply of the same request use a
  // consistent id if the caller re-sends the same importId for both.
  const resolvedImportId = importId || generateImportId();

  const importOptions = {
    sources,
    csvPath,
    csvSource: 'PEP' as const,
    csvSeparator: ';',
    mode,
    dryRun: !!dryRun,
    force: !!force,
    importId: resolvedImportId,
  };

  // Dry-run is a preview (issue #8): the caller needs the counts back to
  // decide whether to apply for real, so this one path responds
  // synchronously instead of the fire-and-forget 202 every other
  // import/upload call uses.
  if (dryRun) {
    try {
      const result = await runImport(importOptions);
      return res.status(200).json(result);
    } catch (error: any) {
      console.error('Dry-run import failed:', error);
      return res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  }

  // issue #111: a fetch-triggered import has no file to hash-dedup on like
  // an upload does, so this is its own durable audit record — created
  // before enqueueing so "who triggered this and what was requested" is
  // captured even if the Cloud Task itself never runs.
  await createFetchImportRecord({
    importId: resolvedImportId,
    sources,
    mode,
    force: !!force,
    uploadedBy: (req as any).userEmail || null,
    uploadedAt: new Date().toISOString(),
  });

  try {
    // importOptions already carries mode/dryRun/force/importId — building a
    // fresh object here (as an earlier version of this route did) silently
    // drops them before they reach the worker, defeating the diff engine's
    // sync-mode guard and the delist-guard force override for anyone using
    // the async path instead of dryRun.
    await enqueueImportTask(importOptions);
  } catch (error: any) {
    console.error('Failed to queue import task:', error);
    await markImportFailed(resolvedImportId, error.message);
    return res.status(500).json({ error: 'Failed to start import', details: error.message });
  }

  res.status(202).json({
    status: 'import_started',
    importId: resolvedImportId,
    message: 'The import has been queued and will run independently of this request.',
  });
});

/**
 * POST /api/upload
 * Upload a sanctions list file. Hashes the content, sniffs its format,
 * rejects an exact duplicate of an already-applied import, records the
 * attempt as a durable `imports` doc, persists the raw bytes to Cloud
 * Storage, then parses and uploads it (issue #7). Runs synchronously (not
 * fire-and-forget like the old handler) so the caller gets a real outcome —
 * files here are small enough, and the diff engine that will eventually make
 * this properly async again is issue #8.
 *
 * Accepts either a logged-in session or a `write`-scoped API token (issue
 * #36) — checked before multer touches the request body, so an
 * unauthenticated caller can't even get a file accepted.
 */
importsRouter.post('/upload', requireAuthOrScope('write'), uploadSingleFile('file'), async (req, res): Promise<any> => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Client-supplied field, used to build the imports doc and (for
  // generic-CSV uploads only) the fallback source tag — required and
  // validated against the known enum rather than letting it flow
  // unvalidated into Firestore, per CLAUDE.md §6.
  const { source, mode, importId } = req.body;
  if (!ALLOWED_SOURCES.has(source)) {
    await fs.remove(req.file.path).catch((e) => console.error('Failed to cleanup temp file', e));
    return res.status(400).json({ error: `"source" must be one of ${[...ALLOWED_SOURCES].join(', ')}.` });
  }

  // Diff-engine controls (issue #8). Multipart fields always arrive as strings,
  // unlike the JSON /api/import body, so the booleans are compared literally.
  // Validated before anything is written, and the temp file is cleaned up on
  // every rejection path rather than only the happy one.
  const dryRun = req.body.dryRun === 'true';
  const force = req.body.force === 'true';

  if (mode !== undefined && mode !== 'sync' && mode !== 'append') {
    await fs.remove(req.file.path).catch((e) => console.error('Failed to cleanup temp file', e));
    return res.status(400).json({ error: '"mode" must be "sync" or "append".' });
  }
  if (importId !== undefined && !IMPORT_ID_PATTERN.test(importId)) {
    await fs.remove(req.file.path).catch((e) => console.error('Failed to cleanup temp file', e));
    return res.status(400).json({ error: '"importId" must match ^[A-Za-z0-9_-]{1,128}$.' });
  }
  if (!assertForceAllowed(req, res, force)) {
    await fs.remove(req.file.path).catch((e) => console.error('Failed to cleanup temp file', e));
    return;
  }

  const uploadedPath = req.file.path;
  const uploadedBy = (req as any).userEmail || null;

  try {
    const result = await processUpload({
      filePath: uploadedPath,
      originalFilename: req.file.originalname,
      sourceHint: source as SanctionSource,
      uploadedBy,
      importOptions: { mode, dryRun, force, importId },
    });

    switch (result.outcome) {
      case 'applied':
        return res.status(200).json({ status: 'applied', importId: result.importId, counts: result.counts });
      case 'dry_run':
        // Preview only — nothing was written and no imports doc was created,
        // so the same file can still be uploaded for real afterwards.
        return res.status(200).json({
          status: 'dry_run',
          importId: result.importId,
          counts: result.counts,
          diffs: result.diffs,
        });
      case 'rejected':
        return res.status(409).json({
          error: `Identical file already imported as import #${result.duplicateOfImportId}.`,
          duplicateOfImportId: result.duplicateOfImportId,
        });
      case 'in_flight':
        return res.status(409).json({ error: 'An identical file is already being processed. Try again shortly.' });
      case 'unsupported_format':
        return res.status(422).json({
          error: `Format "${result.format}" was detected but is not yet supported for parsing.`,
        });
      case 'failed':
        return res.status(500).json({ error: result.error });
    }
  } catch (error: any) {
    console.error('Upload processing error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  } finally {
    fs.remove(uploadedPath).catch((e) => console.error('Failed to cleanup temp file', e));
  }
});
