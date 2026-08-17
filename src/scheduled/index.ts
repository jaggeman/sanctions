import { onSchedule } from 'firebase-functions/v2/scheduler';
import { runScheduledFetch } from '../importer/scheduledFetch';

/**
 * Daily automated re-fetch of the EU/UN/US sanction source lists (issue #97).
 * See `runScheduledFetch` for why this is safe to run unattended: an
 * unchanged download is rejected as a duplicate of the last run, and a
 * tripped delist guard surfaces as a per-source failure rather than
 * silently mass-delisting.
 */
export const scheduledSourceFetch = onSchedule(
  {
    schedule: '0 6 * * *',
    timeZone: 'UTC',
    memory: '1GiB',
    timeoutSeconds: 540,
  },
  async () => {
    const outcomes = await runScheduledFetch();
    const failed = outcomes.filter((o) => o.status === 'error');
    console.log(`Scheduled source fetch finished: ${outcomes.length - failed.length}/${outcomes.length} ok.`);
    if (failed.length > 0) {
      console.error('Scheduled source fetch had failures:', failed);
    }
  },
);
