import { Router, Request } from 'express';
import { db } from '../../shared/firebase';
import { runSearch } from '../../search';
import { logSearchEvent } from '../../search/searchLog';
import { applyOverride, getOverride } from '../../overrides';
import { listRecordVersions } from '../../importer/uploader';
import { SanctionRecord } from '../../shared/types';
import { requireAuthOrScope } from '../middleware/requireAuthOrScope';
import { validateEntityIdParam } from '../middleware/validateEntityIdParam';

// Allow-list for Firestore document IDs taken from a URL path param (CLAUDE.md
// §6) — rejects '/' and other structural characters so a client can't smuggle
// a multi-segment path (e.g. "../otherCollection/doc") into .doc(id).
const DOC_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;

export const searchRouter = Router();

// Param callbacks are local to the router they're registered on — this
// router's own :id routes (GET /api/sanctions/:id, /:id/versions) need
// their own copy (see src/api/index.ts's comment on this pattern).
searchRouter.param('id', validateEntityIdParam);

/**
 * Requester identity for the search audit log (issue #109) — a session
 * carries `userEmail` (set by requireAuth), a bearer-token request carries
 * `apiTokenId` instead (set by requireScope). Exactly one is ever present,
 * since requireAuthOrScope delegates to one or the other, never both.
 */
function requesterIdentity(req: Request): string {
  const userEmail = (req as any).userEmail;
  if (userEmail) return userEmail;
  if (req.apiTokenId) return `token:${req.apiTokenId}`;
  return 'unknown';
}

/**
 * GET /api/search
 * Fuzzy name search (phonetic + edit-distance + token-set matching), plus an
 * exact passport/ID fast path. See src/search/matcher.ts — the same matcher
 * backs this endpoint, the MCP server, and the CLI (issue #11).
 *
 * Accepts either a logged-in session or a `read`-scoped API token (issue #36)
 * — this is the exact route external, session-less integrations need.
 *
 * Fires (does not await) a durable searchLog entry (issue #109) so a later
 * "did we ever search for X" question is answerable — never on the response
 * latency path, and a write failure there is logged, not thrown.
 */
searchRouter.get('/search', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  const { q, source, type, limit, threshold, includeDelisted, dob } = req.query;

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  // issue #37 & issue #161: `|| 20` treats an explicit limit=0 the same as "not provided".
  // Check for NaN and negative values explicitly — negative or NaN falls back to default 20,
  // while preserving explicit limit=0.
  const parsedLimit = parseInt(limit as string, 10);
  const requestedLimit =
    Number.isNaN(parsedLimit) || parsedLimit < 0
      ? 20
      : Math.min(parsedLimit, 100);

  // issue #148: guard against NaN and clamp threshold to [0, 100]
  let parsedThreshold: number | undefined;
  if (threshold !== undefined) {
    const rawVal = parseInt(threshold as string, 10);
    if (!Number.isNaN(rawVal)) {
      parsedThreshold = Math.max(0, Math.min(rawVal, 100));
    }
  }

  try {
    const { results, totalMatches, truncated } = await runSearch(q, {
      source: typeof source === 'string' ? source : undefined,
      type: typeof type === 'string' ? type : undefined,
      limit: requestedLimit,
      threshold: parsedThreshold,
      // Delisted records are excluded by default (issue #9); ?includeDelisted=true
      // opts in. Filtered inside runSearch rather than here, so a delisted record
      // never enters the matcher and cannot surface as a scored hit.
      includeDelisted: includeDelisted === 'true',
      // Booster, not a hard filter (src/search/index.ts) — was already built
      // into runSearch/matcher but never reachable from this route.
      dob: typeof dob === 'string' ? dob : undefined,
    });

    res.json({ results, totalMatches, truncated });

    logSearchEvent({
      action: 'search',
      requestedBy: requesterIdentity(req),
      query: q,
      filters: {
        source: typeof source === 'string' ? source : undefined,
        type: typeof type === 'string' ? type : undefined,
        threshold: parsedThreshold,
        includeDelisted: includeDelisted === 'true',
        dob: typeof dob === 'string' ? dob : undefined,
      },
      resultCount: totalMatches,
      timestamp: new Date().toISOString(),
    });

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
searchRouter.get('/sanctions/:id', requireAuthOrScope('read'), async (req, res): Promise<any> => {
  const { id } = req.params;

  try {
    const doc = await db.collection('sanctions').doc(id).get();
    if (!doc.exists) {
      logSearchEvent({
        action: 'lookup',
        requestedBy: requesterIdentity(req),
        entityId: id,
        resultCount: 0,
        timestamp: new Date().toISOString(),
      });
      return res.status(404).json({ error: `Sanction record with ID ${id} not found.` });
    }

    const override = await getOverride(id);
    const { record, overriddenFields } = applyOverride(doc.data() as SanctionRecord, override);
    res.json({ ...record, overriddenFields });

    logSearchEvent({
      action: 'lookup',
      requestedBy: requesterIdentity(req),
      entityId: id,
      resultCount: 1,
      timestamp: new Date().toISOString(),
    });
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
searchRouter.get('/sanctions/:id/versions', requireAuthOrScope('read'), async (req, res): Promise<any> => {
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
