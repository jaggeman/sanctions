import { downloadFile, SOURCE_URLS } from './fetcher';
import { processUpload, ProcessUploadResult } from './uploadPipeline';
import { SanctionSource } from '../shared/types';

interface ScheduledSource {
  source: Extract<SanctionSource, 'EU' | 'UN' | 'US'>;
  filename: string;
}

const SCHEDULED_SOURCES: ScheduledSource[] = [
  { source: 'EU', filename: 'eu_sanctions.xml' },
  { source: 'UN', filename: 'un_sanctions.xml' },
  { source: 'US', filename: 'us_sdn.xml' },
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

  return outcomes;
}
