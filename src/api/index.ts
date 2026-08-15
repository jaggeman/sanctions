import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import * as functions from 'firebase-functions';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import multer from 'multer';
import * as swaggerUi from 'swagger-ui-express';
import { db } from '../shared/firebase';
import { runImport } from '../importer';
import { tokensRouter } from './routes/tokens';
import { runSearch } from '../search';
import { createOtp, verifyOtp } from '../auth/otpStore';
import { sendOtpEmail } from '../auth/mailer';
import { createSession, destroySession } from '../auth/session';
import { requireAuth, SESSION_COOKIE_NAME } from '../auth/middleware';
import { TEST_LOGIN_EMAIL, TEST_LOGIN_CODE, isTestLoginEnabled, isTestLoginEmail } from '../auth/testAccount';
import { requestLogger } from './middleware/requestLogger';
import { errorLogger } from './middleware/errorLogger';

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ dest: os.tmpdir() });
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// Enable CORS and JSON parsing.
// Cookie-based sessions mean credentialed CORS must not reflect an arbitrary origin —
// only an explicitly configured frontend origin is allowed to send/receive the session cookie.
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || false, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(requestLogger);

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

  try {
    const code = createOtp(email);
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

  if (!isTestLogin && !verifyOtp(email, code)) {
    return res.status(401).json({ error: 'Invalid or expired code.' });
  }

  const sessionId = createSession(email.trim().toLowerCase());
  res.cookie(SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTIONS);
  res.json({ ok: true });
});

/**
 * GET /api/auth/session
 * Returns the currently logged-in email, or 401 if not authenticated.
 */
app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({ email: (req as any).userEmail });
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

// Every other /api route requires an authenticated session.
app.use('/api', requireAuth);

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
// Inherits the blanket requireAuth session gate above, so any logged-in user
// can reach this today. It is NOT yet admin-role-specific — requireAdmin is
// still a no-op placeholder. Tracked in issue #17.
app.use('/api/admin/tokens', tokensRouter);

/**
 * GET /api/search
 * Fuzzy name search (phonetic + edit-distance + token-set matching), plus an
 * exact passport/ID fast path. See src/search/matcher.ts — the same matcher
 * backs this endpoint, the MCP server, and the CLI (issue #11).
 */
app.get('/api/search', async (req, res): Promise<any> => {
  const { q, source, type, limit, threshold } = req.query;

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  const requestedLimit = Math.min(parseInt(limit as string) || 20, 100);

  try {
    const { results, totalMatches, truncated } = await runSearch(q, {
      source: typeof source === 'string' ? source : undefined,
      type: typeof type === 'string' ? type : undefined,
      limit: requestedLimit,
      threshold: threshold !== undefined ? parseInt(threshold as string) : undefined,
    });

    res.json({ results, totalMatches, truncated });

  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * GET /api/sanctions/:id
 * Retrieve detail record by ID
 */
app.get('/api/sanctions/:id', async (req, res): Promise<any> => {
  const { id } = req.params;

  try {
    const doc = await db.collection('sanctions').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: `Sanction record with ID ${id} not found.` });
    }
    res.json(doc.data());
  } catch (error: any) {
    console.error('Get details error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * POST /api/import
 * Trigger background import process
 */
app.post('/api/import', async (req, res): Promise<any> => {
  const { sources, csvPath } = req.body;

  // Validate sources if provided
  if (sources && !Array.isArray(sources)) {
    return res.status(400).json({ error: '"sources" must be an array.' });
  }

  // Trigger import in the background
  console.log('Import triggered via REST API. Starting background run...');
  
  runImport({
    sources: sources,
    csvPath: csvPath,
    csvSource: 'PEP',
    csvSeparator: ';',
  })
    .then((result) => {
      console.log('API Background Import finished:', result);
    })
    .catch((err) => {
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
 * Upload a CSV or XML file for processing
 */
app.post('/api/upload', upload.single('file'), async (req, res): Promise<any> => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { source } = req.body; // e.g. "PEP", "EU", "UN"
  const uploadedPath = req.file.path;

  console.log(`Received uploaded file for source ${source}: ${uploadedPath}`);
  
  // Trigger background import with the uploaded file path
  runImport({
    sources: source ? [source] : [],
    csvPath: uploadedPath,
    csvSource: source || 'MANUAL_CSV',
    csvSeparator: ';',
  })
    .then(() => {
      console.log('Upload Background Import finished.');
      fs.remove(uploadedPath).catch(e => console.error('Failed to cleanup temp file', e));
    })
    .catch((err) => {
      console.error('Upload Background Import failed:', err);
      fs.remove(uploadedPath).catch(e => console.error('Failed to cleanup temp file', e));
    });

  res.status(202).json({
    status: 'upload_received',
    message: 'File received and import process started.',
  });
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

// Export Express App as a Firebase Cloud Function
export const api = functions.https.onRequest(app);
