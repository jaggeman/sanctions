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
import { runImport } from '../importer';
import { processUpload } from '../importer/uploadPipeline';
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
// importId (issue #8) becomes a Firestore document ID under
// sanctions/{id}/versions/{importId} — validate it before it ever reaches
// there, same as any other client-supplied value used as a storage key
// (CLAUDE.md §6). Matches the shape runImport auto-generates
// (import_<timestamp>_<hex>) plus reasonable room for a caller-chosen id.
const IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
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

  const code = createOtp(email);
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
app.post('/api/auth/verify-otp', (req, res): any => {
  const { email, code } = req.body;

  if (!email || typeof email !== 'string' || !code || typeof code !== 'string') {
    return res.status(400).json({ error: '"email" and "code" are required.' });
  }

  const isTestLogin = isTestLoginEnabled() && isTestLoginEmail(email) && code === TEST_LOGIN_CODE;

  // issue #33: same allow-list check as request-otp, defense in depth — even
  // if a valid code somehow exists for a disallowed address, it can't be
  // exchanged for a session. Same 401 shape as an invalid/expired code.
  if (!isTestLogin && (!isAllowedEmail(email) || !verifyOtp(email, code))) {
    return res.status(401).json({ error: 'Invalid or expired code.' });
  }

  const sessionId = createSession(email.trim().toLowerCase());
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
 */
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) destroySession(sessionId);
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

// Swagger UI Route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// Raw OpenAPI JSON endpoint
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
  const { q, source, type, limit, threshold, includeDelisted } = req.query;

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
 * POST /api/import
 * Trigger background import process.
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

  const importOptions = {
    sources,
    csvPath,
    csvSource: 'PEP' as const,
    csvSeparator: ';',
    mode,
    dryRun: !!dryRun,
    force: !!force,
    importId,
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

  // Trigger import in the background
  console.log('Import triggered via REST API. Starting background run...');

  runImport(importOptions)
    .then((result) => {
      console.log('API Background Import finished:', result);
    })
    .catch((err) => {
      // A refused delist guard (issue #8's DelistGuardError) surfaces only
      // here today, same as any other background-import failure — the 202
      // already went out by the time this rejects. Known gap, not solved by
      // this change: making the sync-mode apply path synchronous (or adding
      // a status-polling endpoint) is bigger than this diff engine's own
      // scope and touches the same fire-and-forget pattern every endpoint
      // in this file uses.
      console.error('API Background Import failed:', err);
    });

  // Accept request and return immediately (202 Accepted)
  res.status(202).json({
    status: 'import_started',
    message: 'The import process has been started in the background. Check server logs for progress.',
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
// maxInstances is pinned to 1 (issue #16): OTP codes and sessions are kept
// in an in-memory Map (src/auth/otpStore.ts, src/auth/session.ts), which
// does not survive across multiple concurrent Cloud Functions instances —
// a request-otp handled by instance A followed by verify-otp landing on
// instance B would fail. This is the documented interim mitigation until
// that storage moves to Firestore or another shared store.
export const api = functions.https.onRequest({ maxInstances: 1 }, app);
