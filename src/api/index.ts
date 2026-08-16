import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as functions from 'firebase-functions';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as swaggerUi from 'swagger-ui-express';
import { tokensRouter } from './routes/tokens';
import { decisionsRouter } from './routes/decisions';
import { overridesRouter } from './routes/overrides';
import { authRouter } from './routes/auth';
import { searchRouter } from './routes/search';
import { importsRouter } from './routes/imports';
import { requireAuth } from '../auth/middleware';
import { requestLogger } from './middleware/requestLogger';
import { errorLogger } from './middleware/errorLogger';
import { scheduledSourceFetch } from '../scheduled';

const app = express();
const PORT = process.env.PORT || 3000;

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

// /api/auth/* (request-otp, verify-otp, session, logout) — unauthenticated
// except GET /api/auth/session, which applies requireAuth itself.
app.use('/api/auth', authRouter);

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

// /api/search, /api/sanctions/:id, /api/sanctions/:id/versions
app.use('/api', searchRouter);

// /api/imports, /api/imports/:id, /api/import, /api/upload
app.use('/api', importsRouter);

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
