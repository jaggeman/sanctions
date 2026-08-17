import { downloadFile, SOURCE_URLS } from './fetcher';
import { processUpload, ProcessUploadResult } from './uploadPipeline';
import { SanctionSource } from '../shared/types';
import { parseUaListStreaming } from './parsers/ua';
import { startDiffSession } from './diff';
import { invalidateSearchIndex } from '../search';
import { logger } from '../shared/logger';

export interface ScheduledSource {
  source: Extract<SanctionSource, 'EU' | 'UN' | 'US' | 'UK' | 'CH'>;
  filename: string;
}

export const SCHEDULED_SOURCES: ScheduledSource[] = [
  { source: 'EU', filename: 'eu_sanctions.xml' },
  { source: 'UN', filename: 'un_sanctions.xml' },
  { source: 'US', filename: 'us_sdn.xml' },
  { source: 'UK', filename: 'uk_sanctions.xml' },
  { source: 'CH', filename: 'ch_sanctions.xml' },
];

export interface ScheduledFetchOutcome {
  source: ScheduledSource['source'];
  status: 'ok' | 'error';
  result?: ProcessUploadResult;
  error?: string;
}

/**
 * Re-downloads each authoritative source list and runs it through the same
 * pipeline a manual upload would (issue #7's `processUpload`), instead of a
 * separate hash-tracking/locking mechanism: an unchanged download hashes
 * identically to the last run and is rejected as a duplicate for free, and a
 * concurrent run racing on the same content is caught by the existing
 * in-flight lock (see `src/importer/importRecord.ts`).
 *
 * `mode: 'sync'` (not `processUpload`'s implicit 'append' default) because
 * these are full authoritative snapshots — a record missing from the new
 * file should be delisted. The diff engine's own delist guard
 * (`DELIST_GUARD_THRESHOLD`, src/importer/diff.ts) refuses to mass-delist an
 * implausible share of a source and surfaces as a 'failed' outcome instead,
 * so this is safe to run unattended.
 *
 * Each source is isolated: a download or import failure for one does not
 * stop the others from running (mirrors `runImport`'s existing
 * per-source try/catch pattern).
 */
export async function runScheduledFetch(): Promise<ScheduledFetchOutcome[]> {
  const log = logger.child({ module: 'importer.scheduledFetch' });
  const outcomes: ScheduledFetchOutcome[] = [];

  for (const { source, filename } of SCHEDULED_SOURCES) {
    try {
      const filePath = await downloadFile(SOURCE_URLS[source], filename);
      const result = await processUpload({
        filePath,
        originalFilename: filename,
        sourceHint: source,
        uploadedBy: null,
        importOptions: { mode: 'sync' },
      });

      if (result.outcome === 'failed') {
        console.error(`Scheduled fetch: ${source} import failed: ${result.error}`);
        outcomes.push({ source, status: 'error', result, error: result.error });
      } else {
        outcomes.push({ source, status: 'ok', result });
      }
    } catch (error: any) {
      console.error(`Scheduled fetch: ${source} download/import threw: ${error.message}`);
      outcomes.push({ source, status: 'error', error: error.message });
    }
  }

  // Ukraine NSDC — REST/JSON API, not a downloadable XML file (issue #287).
  // Runs only when NSDC_API_KEY is set; gracefully skips otherwise.
  try {
    const session = await startDiffSession('UA', { mode: 'sync' });
    let count = 0;
    let buffer: import('../shared/types').SanctionRecord[] = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      const chunk = buffer;
      buffer = [];
      await session.addChunk(chunk);
    };

    await parseUaListStreaming(async (record) => {
      count++;
      buffer.push(record);
      if (buffer.length >= 200) await flush();
    });
    await flush();

    if (count > 0) {
      await session.finish();
      await invalidateSearchIndex();
      log.info('scheduledFetch.ua.done', { count });
      outcomes.push({ source: 'UA' as any, status: 'ok' });
    } else {
      session.abort();
      log.info('scheduledFetch.ua.skipped', { reason: 'no records (API key absent or API returned 0)' });
    }
  } catch (error: any) {
    console.error(`Scheduled fetch: UA import threw: ${error.message}`);
    outcomes.push({ source: 'UA' as any, status: 'error', error: error.message });
  }

  return outcomes;
}
