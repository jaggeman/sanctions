import { db } from '../shared/firebase';
import { logger } from '../shared/logger';
import { SearchLogEntry } from '../shared/types';

const log = logger.child({ module: 'search.searchLog' });
const COLLECTION = 'searchLog';

/**
 * Durable, queryable audit trail (issue #109) — "did we ever search for
 * person X, and when, and who ran it" was previously unanswerable at all,
 * since the query/requester were never captured anywhere beyond an
 * ephemeral request-line log.
 *
 * Callers fire this without awaiting so it never adds latency to the
 * search/lookup response it's logging. Never throws: a failure to write the
 * audit entry must not fail the underlying request it's describing, but per
 * the issue's own instruction it also must not be silently swallowed —
 * logged via the structured logger instead.
 */
export async function logSearchEvent(entry: SearchLogEntry): Promise<void> {
  try {
    await db.collection(COLLECTION).add(entry);
  } catch (error) {
    log.error('searchLog.write_failed', { error, action: entry.action });
  }
}
