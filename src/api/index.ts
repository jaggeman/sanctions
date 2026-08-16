import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { onRequest } from 'firebase-functions/v2/https';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as swaggerUi from 'swagger-ui-express';
import { tokensRouter } from './routes/tokens';
import { decisionsRouter } from './routes/decisions';
import { customRecordsRouter } from './routes/customRecords';
import { overridesRouter } from './routes/overrides';
import { systemRouter } from './routes/system';
import { authRouter } from './routes/auth';
import { searchRouter } from './routes/search';
import { importsRouter } from './routes/imports';
import { exportRouter } from './routes/export';
import { requireAuth } from '../auth/middleware';
import { findMisconfiguredAdminEmails } from '../auth/admins';
import { requestLogger } from './middleware/requestLogger';
import { errorLogger } from './middleware/errorLogger';
import { scheduledSourceFetch } from '../scheduled';
import { logger } from '../shared/logger';

export const app = express();
const PORT = process.env.PORT || 3000;

// issue #144: trust 1 upstream hop (Cloud Run / Firebase Hosting reverse proxy)
// so req.ip reflects the actual client IP and cannot be spoofed by client-supplied
// X-Forwarded-For headers.
app.set('trust proxy', 1);

// issue #65: ADMIN_EMAILS and ALLOWED_EMAIL_DOMAINS are independently
// configured — an admin address whose domain isn't allow-listed gets
// silently locked out at login with no indication of why. Not fatal (an
// operator may be mid-rollout of a new domain); just surfaced in logs.
for (const { maskedEmail, domain } of findMisconfiguredAdminEmails()) {
  logger.warn(
    'ADMIN_EMAILS contains an address whose domain is not in ALLOWED_EMAIL_DOMAINS — this admin will be locked out at login (issue #65).',
    { maskedEmail, domain },
  );
}

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

// Every /api/* response is dynamic and cookie-authenticated — never
// cacheable. Without this, Firebase Hosting's CDN (Fastly) treats a
// response with no Cache-Control as publicly cacheable and, per its default
// policy for cacheable paths, STRIPS the inbound Cookie request header
// before it ever reaches this function. That's silent and total: every
// GET route gating on requireAuth/requireAuthOrScope would 401 for every
// caller, session cookie or not, because req.cookies is empty by the time
// Express sees the request — confirmed live (a real incident): the session
// cookie was correctly set by POST /api/auth/verify-otp, but GET
// /api/auth/session immediately 401'd through Hosting's rewrite while the
// exact same request against the underlying Cloud Run URL directly worked.
// POST responses happened to still work because Google Frontend
// auto-appends Cache-Control: private whenever a response sets a cookie —
// but GET routes returning no cookie of their own got no such header and
// were silently broken for cookie-forwarding on every request.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// requestLogger must run before express.json()/cookieParser() (issue #66):
// Express treats it as regular (3-arg) middleware, so if either of those
// throws (a malformed JSON body, a bad cookie), Express skips every
// remaining regular middleware — including requestLogger — and jumps
// straight to errorLogger, which then had no requestId to attach at all.
app.use(requestLogger);

// Enable CORS and JSON parsing.
// Cookie-based sessions mean credentialed CORS must not reflect an arbitrary origin —
// only an explicitly configured frontend origin is allowed to send/receive the session cookie.
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || false, credentials: true }));
app.use(express.json());
app.use(cookieParser());

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

// Authentication routes (issue #195, split from index.ts)
app.use('/api/auth', authRouter);

// Admin: API token management (create / list / revoke)
// Session-only: authenticating to the endpoint that mints API tokens with an
// API token would be circular, so this route does not accept a bearer token
// (issue #36 is about the *data* routes below, not this one).
app.use('/api/admin/tokens', requireAuth, tokensRouter);

/**
 * POST/PUT/DELETE/GET /api/custom-records & /api/admin/custom-records
 * Internal watchlist entries (source: 'CUSTOM') the official lists don't
 * cover (issue #172). Auth is enforced inside customRecordsRouter itself
 * (requireAuthOrScope('custom:write') / ('custom:read')). See
 * src/api/routes/customRecords.ts.
 */
app.use('/api/admin/custom-records', customRecordsRouter);
app.use('/api/custom-records', customRecordsRouter);

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

// System operations / Drift status diagnostic endpoints (health, logs, releases)
app.use('/api/system', systemRouter);

// Search and detail routes (issue #195, split from index.ts)
app.use('/api', searchRouter);

// Import and upload routes (issue #195, split from index.ts)
app.use('/api', importsRouter);

// CSV Export routes (issue #233)
app.use('/api', exportRouter);

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
// and durable across a cold start.
//
// The pin then stayed for a second reason: src/search/index.ts's
// `cachedRecords` was its own separate in-memory, per-instance cache,
// invalidated only within the process that ran the import — with more than
// one instance, a search served by an instance that didn't just import
// would silently return stale results. Issue #43 added a Firestore-backed
// `meta/searchIndex.version` counter that `getRecords()` checks against its
// local cache on every call, so every instance now picks up an invalidation
// regardless of which one ran the import.
//
// Both reasons are gone — no longer pinned (issue #101).
//
// Issue #230 decision: no minInstances, no Cloud Scheduler warmup ping, for
// now. A cold instance pays a one-time 1-3s penalty to build getRecords()'s
// in-memory index (src/search/index.ts) on its first search; every request
// after that on the same instance is <15ms. minInstances: 1 would eliminate
// it, but bills for a fully-allocated 1GiB instance continuously regardless
// of traffic — a real, predictable recurring cost that's disproportionate
// for this app's actual usage pattern (a small internal analyst team, not a
// public/high-traffic service). A warmup ping avoids that always-on cost but
// adds its own operational surface (a Scheduler job, a synthetic warmup
// query, monitoring the ping itself) for a penalty that's a one-time hit on
// the first search of a session, not a tax on every request. Revisit if
// usage data ever shows cold starts happening often enough to be a real
// nuisance, or if this app's audience grows beyond internal analyst use.
export const api = onRequest({ memory: '1GiB', timeoutSeconds: 120 }, app);

// Both re-exported so their deployable Cloud Functions are discovered:
// `dist/api/index.js` (package.json's `main`) is the sole file Firebase
// Functions discovery walks at deploy time.
export { runImportTask } from '../importer/importTask'; // issue #43
export { scheduledSourceFetch }; // issue #97
