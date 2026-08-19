import { onSchedule } from 'firebase-functions/v2/scheduler';
import { runScheduledFetch } from '../importer/scheduledFetch';
import { runPortfolioScreening } from '../monitoring';
import { logger } from '../shared/logger';

const log = logger.child({ module: 'scheduled' });

/**
 * Daily automated re-fetch of the EU/UN/US sanction source lists (issue #97).
 * Followed by automated Ongoing Portfolio Screening (issue #317).
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

    log.info('scheduled.source_fetch_completed', {
      total: outcomes.length,
      ok: outcomes.length - failed.length,
      failed: failed.length,
    });

    if (failed.length > 0) {
      log.error('scheduled.source_fetch_errors', { failed });
    }

    // Continuous Monitoring (issue #317): run portfolio screening
    try {
      log.info('scheduled.portfolio_screening_started');
      const screeningSummary = await runPortfolioScreening();
      log.info('scheduled.portfolio_screening_completed', { ...screeningSummary });
    } catch (err: any) {
      log.error('scheduled.portfolio_screening_failed', { error: err.message });
    }
  },
);
