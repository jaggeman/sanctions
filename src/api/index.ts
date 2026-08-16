import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as functions from 'firebase-functions';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import multer from 'multer';
import * as swaggerUi from 'swagger-ui-express';
import { db } from '../shared/firebase';
import { enqueueImportTask } from '../importer/taskQueue';
import { runImport } from '../importer';
import { processUpload } from '../importer/uploadPipeline';
import { listImports, findImportBySha256, createFetchImportRecord, markImportFailed } from '../importer/importRecord';
import { listRecordVersions, generateImportId } from '../importer/uploader';
import { tokensRouter } from './routes/tokens';
import { decisionsRouter } from './routes/decisions';
import { runSearch } from '../search';
import { SanctionSource, SanctionRecord } from '../shared/types';
import { applyOverride, getOverride } from '../overrides';
import { overridesRouter } from './routes/overrides';
import { validateEntityIdParam } from './middleware/validateEntityIdParam';
import { createOtp, verifyOtp } from '../auth/otpStore';
import { sendOtpEmail } from '../auth/mailer';
import { createSession, destroySession } from '../auth/session';
import { requireAuth, SESSION_COOKIE_NAME } from '../auth/middleware';
import { isAdminEmail } from '../auth/admins';
import { isAllowedEmail } from '../auth/emailAllowlist';
import { TEST_LOGIN_EMAIL, TEST_LOGIN_CODE, isTestLoginEnabled, isTestLoginEmail } from '../auth/testAccount';
import { requestLogger } from './middleware/requestLogger';
import { errorLogger } from './middleware/errorLogger';
import { scheduledSourceFetch } from '../scheduled';
import { requireAuthOrScope } from './middleware/requireAuthOrScope';

const app = express();
const PORT = process.env.PORT || 3000;

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
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    middleware(req, res, (err: any) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.` });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    });
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
 * sessions specifically (issue #105). A write-scoped API token has no
 * associated identity to check admin status against at all, so it's
 * rejected outright rather than silently treated as non-admin.
 */
function assertForceAllowed(req: express.Request, res: express.Response, force: boolean): boolean {
  if (!force) return true;

  const email = (req as any).userEmail;
  if (!email || !isAdminEmail(email)) {
    res.status(403).json({ error: '"force" (delist safety guard override) requires an admin session.' });
    return false;
  }

  console.warn(`[audit] Delist guard override (force=true) used by ${email}`);
  return true;
}
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// Security response headers (issue #95, found via a live pen test): nosniff,
// frame-ancestors/X-Frame-Options, HSTS, and hiding X-Powered-By. CSP is
// skipped specifically on /api-docs — swagger-ui-express's bundled page
// relies on inline <script>/<style>, which helmet's default policy blocks;
// every other route keeps the full default policy.
app.use((req, res, next) => {
  const applyHeaders = req.path.startsWith('/api-docs')
    ? helmet({ contentSecurityPolicy: false })
    : helmet();
  applyHeaders(req, res, next);
});

// Enable CORS and JSON parsing.
// Cookie-based sessions mean credentialed CORS must not reflect an arbitrary origin —
// only an explicitly configured frontend origin is allowed to send/receive the session cookie.
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || false, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(requestLogger);

// Rejects any :id route param before it can reach a Firestore .doc(id) call
// (CLAUDE.md §6) — param callbacks are local to the router they're
// registered on, so this only covers routes defined directly on `app`
// (GET /api/sanctions/:id); overridesRouter and tokensRouter register their
// own copy.
app.param('id', validateEntityIdParam);

/**
 * POST /api/auth/request-otp
 * Generates and emails a one-time login code.
 */
app.post('/api/auth/request-otp', async (req, res): Promise<any> => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'A valid "email" is required.' });
  }

  if (isTestLoginEnabled() && isTestLoginEmail(email)) {
    console.log(`[auth] Test login code for ${TEST_LOGIN_EMAIL} is ${TEST_LOGIN_CODE}`);
    return res.json({ ok: true });
  }

  // issue #33: reject an address whose domain isn't allow-listed with the
  // SAME response as a real send — no email, no OTP created, but nothing in
  // the response reveals that. Checked here (not just in verify-otp) so this
  // endpoint can't be used to email codes to arbitrary strangers, which is a
  // spam vector independent of the access question.
  if (!isAllowedEmail(email)) {
    return res.json({ ok: true });
  }

  const code = await createOtp(email);
  if (!code) {
    return res.status(429).json({ error: 'A code was already sent recently. Please wait before requesting another.' });
  }

  try {
    await sendOtpEmail(email, code);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Failed to send OTP email:', error);
    res.status(500).json({ error: 'Failed to send login code. Please try again.' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verifies a one-time code and starts a session.
 */
app.post('/api/auth/verify-otp', async (req, res): Promise<any> => {
  const { email, code } = req.body;

  if (!email || typeof email !== 'string' || !code || typeof code !== 'string') {
    return res.status(400).json({ error: '"email" and "code" are required.' });
  }

  const isTestLogin = isTestLoginEnabled() && isTestLoginEmail(email) && code === TEST_LOGIN_CODE;

  // issue #33: same allow-list check as request-otp, defense in depth — even
  // if a valid code somehow exists for a disallowed address, it can't be
  // exchanged for a session. Same 401 shape as an invalid/expired code.
  if (!isTestLogin && (!isAllowedEmail(email) || !(await verifyOtp(email, code)))) {
    return res.status(401).json({ error: 'Invalid or expired code.' });
  }

  const sessionId = await createSession(email.trim().toLowerCase());
  res.cookie(SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTIONS);
  res.json({ ok: true });
});

/**
 * GET /api/auth/session
 * Returns the currently logged-in email plus admin status (isAdminEmail(),
 * checked fresh from ADMIN_EMAILS on every call — see src/auth/admins.ts,
 * issue #17), or 401 if not authenticated.
 */
app.get('/api/auth/session', requireAuth, (req, res) => {
  const email = (req as any).userEmail;
  res.json({ email, isAdmin: isAdminEmail(email) });
});

/**
 * POST /api/auth/logout
 * Deliberately not gated by requireAuth (issue #108, explicit decision):
 * it only ever destroys the session matching whatever `sid` cookie the
 * caller presents, so at most a caller logs out their own (possibly
 * already-invalid) session — there is no cross-account effect to guard
 * against, and requiring a still-valid session just to end that session
 * would reject the exact "my session already looks broken" case logout
 * exists to recover from.
 */
app.post('/api/auth/logout', async (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) await destroySession(sessionId);
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

// Every other /api route requires either an authenticated session or a
// scoped API token — applied per-route below (issue #36) rather than as a
// blanket gate here, since a blanket session-only check would reject a
// bearer-token request before any route-level scope check could ever run.

// Load OpenAPI Specification
const openApiSpecPath = path.resolve(__dirname, 'openapi.json');
let openApiSpec = {};
try {
  openApiSpec = fs.readJsonSync(openApiSpecPath);
} catch (error) {
  console.error('Failed to load openapi.json. Run npm run build or verify path.');
}

// Swagger UI Route.
// Deliberately public, no auth (issue #108, explicit decision): this is API
// documentation, not API data — the route/schema shapes it exposes have no
// data-confidentiality value on their own, and self-registering integrators
// need to be able to read the docs before they have a session or token to
// authenticate a real call with.
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// Raw OpenAPI JSON endpoint — same reasoning as /api-docs above.
app.get('/openapi.json', (req, res) => {
  res.json(openApiSpec);
});

// Admin: API token management (create / list / revoke)
// Session-only: authenticating to the endpoint that mints API tokens with an
// API token would be circular, so this route does not accept a bearer token
// (issue #36 is about the *data* routes below, not this one).
app.use('/api/admin/tokens', requireAuth, tokensRouter);

/**
 * PUT/DELETE /api/overrides/:id
 * Field-level corrections layered on top of an imported record (issue #35).
 * Auth is enforced inside overridesRouter itself (requireAuthOrScope) — no
 * middleware needed at this mount site. See src/api/routes/overrides.ts.
 */
app.use('/api/overrides', overridesRouter);

// Screening adjudications (false-positive/true-positive decisions, issue #22).
// Auth is enforced inside decisionsRouter itself (requireAuthOrScope) — no
// middleware needed at this mount site. See src/api/routes/decisions.ts.
app.use('/api/decisions', decisionsRouter);

/**
 * GET /api/search
 * Fuzzy name search (phonetic + edit-distance + token-set matching), plus an
 * exact passport/ID fast path. See src/search/matcher.ts — the same matcher
 * backs this endpoint, the MCP server, and the CLI (issue #11).
 *
 * Accepts either a logged-in session or a `read`-scoped API token (issue #36)
 * — this is the exact route external, session-less integrations need.
 */
app.get('/api/search', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  const { q, source, type, limit, threshold, includeDelisted, dob } = req.query;

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  // issue #37: `|| 20` treats an explicit limit=0 the same as "not provided".
  // Check for NaN explicitly so a real 0 survives.
  const parsedLimit = parseInt(limit as string, 10);
  const requestedLimit = Math.min(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 100);

  try {
    const { results, totalMatches, truncated } = await runSearch(q, {
      source: typeof source === 'string' ? source : undefined,
      type: typeof type === 'string' ? type : undefined,
      limit: requestedLimit,
      threshold: threshold !== undefined ? parseInt(threshold as string) : undefined,
      // Delisted records are excluded by default (issue #9); ?includeDelisted=true
      // opts in. Filtered inside runSearch rather than here, so a delisted record
      // never enters the matcher and cannot surface as a scored hit.
      includeDelisted: includeDelisted === 'true',
      // Booster, not a hard filter (src/search/index.ts) — was already built
      // into runSearch/matcher but never reachable from this route.
      dob: typeof dob === 'string' ? dob : undefined,
    });

    res.json({ results, totalMatches, truncated });

  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/sanctions/:id
 * Retrieve detail record by ID. No status filtering here, unlike /api/search:
 * an imported record is never hard-deleted (issue #9), so a delisted record
 * is a valid, meaningful answer and is returned with its status/delistedAt,
 * not a 404.
 *
 * Accepts either a logged-in session or a `read`-scoped API token (issue #36).
 *
 * Merges any override on top of the stored record before responding (issue
 * #35) — the stored doc itself is never touched, which is what keeps an
 * override reversible. `overriddenFields` in the response tells the caller
 * which fields are local corrections rather than official source data.
 */
app.get('/api/sanctions/:id', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  const { id } = req.params;

  try {
    const doc = await db.collection('sanctions').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: `Sanction record with ID ${id} not found.` });
    }

    const override = await getOverride(id);
    const { record, overriddenFields } = applyOverride(doc.data() as SanctionRecord, override);
    res.json({ ...record, overriddenFields });
  } catch (error: any) {
    console.error('Get details error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/sanctions/:id/versions
 * Version trail for a record, newest first (issue #12), backed by the
 * sanctions/{id}/versions subcollection issue #9 writes to.
 */
app.get('/api/sanctions/:id/versions', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  const { id } = req.params;
  if (!DOC_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'Invalid record ID.' });
  }

  try {
    const doc = await db.collection('sanctions').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: `Sanction record with ID ${id} not found.` });
    }
    const versions = await listRecordVersions(id);
    res.json(versions);
  } catch (error: any) {
    console.error('List record versions error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/imports
 * List import audit records, newest first (issue #12 — import history view).
 */
app.get('/api/imports', requireAuthOrScope('read'), async (req, res): Promise<any> => {
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
app.get('/api/imports/:id', requireAuthOrScope('read'), async (req, res): Promise<any> => {
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
 * running in-process here: `api` is pinned to maxInstances: 1 (issue #16),
 * so a multi-minute import awaited in this same function would freeze
 * login/search for everyone, and a bare fire-and-forget call is not
 * guaranteed to run to completion if this instance freezes/recycles right
 * after the response is sent. Cloud Tasks durably persists and retries the
 * job independent of this request's own fate, so the 202 below is now
 * actually true rather than merely optimistic.
 *
 * Accepts either a logged-in session or a `write`-scoped API token (issue #36).
 */
app.post('/api/import', requireAuthOrScope('write'), async (req, res): Promise<any> => {
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
app.post('/api/upload', requireAuthOrScope('write'), uploadSingleFile('file'), async (req, res): Promise<any> => {
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

// Catch-all error logger — must be registered after every route/middleware
// above so Express routes uncaught errors to it.
app.use(errorLogger);

// When run directly (local dev via ts-node/node), also listen on PORT.
// Under `firebase deploy`/emulators, this file is only ever required as a
// module (never main), so this is skipped and `api` below is used instead.
if (require.main === module) {
  app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
}

// Export Express App as a Firebase Cloud Function.
// issue #16 originally pinned this to maxInstances: 1 because OTP codes and
// sessions lived in an in-memory Map, which fragmented across concurrent
// instances. Issue #63 moved that storage to Firestore
// (src/auth/otpStore.ts, src/auth/session.ts), shared across every instance
// and durable across a cold start — that half of the reason is gone.
//
// The pin stays for now regardless: src/search/index.ts's `cachedRecords` is
// its own separate in-memory, per-instance cache, invalidated only within
// the process that ran the import. With a single instance that's trivially
// consistent; with maxInstances > 1, a search served by a different
// instance than the one that just imported would silently return stale
// results. Issue #43 is adding a Firestore-backed invalidation marker for
// exactly that — this pin should come out once #43 lands, in a follow-up
// PR that removes it explicitly rather than as a side effect of this one.
export const api = functions.https.onRequest({ maxInstances: 1 }, app);

// Both re-exported so their deployable Cloud Functions are discovered:
// `dist/api/index.js` (package.json's `main`) is the sole file Firebase
// Functions discovery walks at deploy time.
export { runImportTask } from '../importer/importTask'; // issue #43
export { scheduledSourceFetch }; // issue #97
