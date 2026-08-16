import * as path from 'path';
import * as fs from 'fs-extra';
import { downloadFile, SOURCE_URLS } from './fetcher';
import { parseEUListStreaming } from './parsers/eu';
import { parseUNList } from './parsers/un';
import { parseUSListStreaming } from './parsers/us';
import { parseUKListStreaming } from './parsers/uk';
import { parseChXmlStream } from './parsers/ch';
import { parseCSVList } from './parsers/csv';
import {
  startDiffSession,
  DEFAULT_IMPORT_MODE,
  ImportMode,
  RunDiffOptions,
  StreamedDiffResult,
} from './diff';
import { invalidateSearchIndex } from '../search';
import { SanctionRecord, SanctionSource } from '../shared/types';
import { logger } from '../shared/logger';
import { validateCsvPath } from './csvPath';

const log = logger.child({ module: 'importer.index' });

export interface ImportOptions {
  sources?: ('EU' | 'UN' | 'US' | 'UK' | 'CH')[];
  csvPath?: string;
  csvSource?: 'PEP' | 'CUSTOM';
  csvSeparator?: string;
  // Issue #8: reconcile against current state instead of blindly overwriting.
  // Defaults to 'append' (never delists) — 'sync' must be opted into per
  // call, since getting this wrong on a partial/CSV-style file would delist
  // an entire source.
  mode?: ImportMode;
  dryRun?: boolean;
  force?: boolean;
  importId?: string;
  /**
   * issue #7: parse one specific, already-on-disk file (typically a user
   * upload whose format was already sniffed by formatDetection.ts) instead
   * of the download-or-csvPath model below. Self-contained — set this XOR
   * the other options, never both.
   */
  uploadedFile?: {
    path: string;
    format: 'eu-xml-1.1' | 'un-xml' | 'us-xml' | 'uk-xml' | 'ch-xml' | 'csv';
    source: SanctionSource;
  };
}

function diffOptionsFrom(options: ImportOptions): RunDiffOptions {
  return {
    // 'append' by default: 'sync' delists everything missing from the file, so
    // it has to be opted into per call rather than inherited by accident.
    mode: options.mode || DEFAULT_IMPORT_MODE,
    dryRun: options.dryRun,
    force: options.force,
    importId: options.importId,
  };
}

/** Handles ImportOptions.uploadedFile — see issue #7. */
async function runUploadedFileImport(
  file: NonNullable<ImportOptions['uploadedFile']>,
  options: ImportOptions,
): Promise<{
  success: boolean;
  importedCounts: Record<string, number>;
  diffs?: StreamedDiffResult[];
  error?: string;
}> {
  const importedCounts: Record<string, number> = {};
  const session = await startDiffSession(file.source, diffOptionsFrom(options));

  try {
    let parsed = 0;
    let uploaded = 0;

    if (file.format === 'eu-xml-1.1') {
      let buffer: SanctionRecord[] = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        // issue #171: reading `uploaded` happens BEFORE evaluating an
        // awaited right-hand side in a compound assignment, so two
        // overlapping flushes would both read the same stale value and the
        // second write would clobber the first's contribution. Splitting
        // the read of `uploaded` to after the await removes that window.
        const addedCount = await session.addChunk(chunk);
        uploaded += addedCount;
      };
      await parseEUListStreaming(file.path, async (record) => {
        parsed++;
        buffer.push(record);
        if (buffer.length >= EU_UPLOAD_CHUNK_SIZE) await flush();
      });
      await flush();
    } else if (file.format === 'un-xml') {
      const records = await parseUNList(file.path);
      parsed = records.length;
      uploaded = await session.addChunk(records);
    } else if (file.format === 'us-xml') {
      // Streamed for the same reason as EU: the real OFAC SDN export (~29 MB)
      // peaked at ~317 MB RSS under the full-DOM parse, over the deployed
      // function's 256 MiB ceiling (see parsers/us.ts and issue #31). An
      // uploaded SDN file is exactly that file, so the non-streaming
      // parseUSList would OOM here.
      let buffer: SanctionRecord[] = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        // issue #171: reading `uploaded` happens BEFORE evaluating an
        // awaited right-hand side in a compound assignment, so two
        // overlapping flushes would both read the same stale value and the
        // second write would clobber the first's contribution. Splitting
        // the read of `uploaded` to after the await removes that window.
        const addedCount = await session.addChunk(chunk);
        uploaded += addedCount;
      };
      await parseUSListStreaming(file.path, async (record) => {
        parsed++;
        buffer.push(record);
        if (buffer.length >= EU_UPLOAD_CHUNK_SIZE) await flush();
      });
      await flush();
    } else if (file.format === 'uk-xml') {
      let buffer: SanctionRecord[] = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        const addedCount = await session.addChunk(chunk);
        uploaded += addedCount;
      };
      await parseUKListStreaming(file.path, async (record) => {
        parsed++;
        buffer.push(record);
        if (buffer.length >= UK_UPLOAD_CHUNK_SIZE) await flush();
      });
      await flush();
    } else if (file.format === 'ch-xml') {
      let buffer: SanctionRecord[] = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        const addedCount = await session.addChunk(chunk);
        uploaded += addedCount;
      };
      await parseChXmlStream(file.path, async (record) => {
        parsed++;
        buffer.push(record);
        if (buffer.length >= CH_UPLOAD_CHUNK_SIZE) await flush();
      });
      await flush();
    } else {
      const records = await parseCSVList(file.path, {
        separator: ';',
        defaultSource: file.source as 'PEP' | 'CUSTOM',
      });
      parsed = records.length;
      uploaded = await session.addChunk(records);
    }

    // Only now that the producer has completed cleanly is "absent from the
    // file" a trustworthy signal, so this is where delisting is allowed to
    // happen. A parse that threw skips it entirely via abort() below.
    const diff = await session.finish();
    importedCounts[file.source] = parsed;

    if (!options.dryRun && (uploaded > 0 || diff.counts.delisted > 0)) {
      await invalidateSearchIndex();
    }

    if (parsed === 0) {
      return { success: false, importedCounts, diffs: [diff], error: 'No records parsed' };
    }
    if (uploaded === 0 && diff.counts.delisted === 0 && diff.counts.skipped > 0) {
      return {
        success: false,
        importedCounts,
        diffs: [diff],
        error: 'No uploadable records after filtering CUSTOM-sourced records',
      };
    }
    return { success: true, importedCounts, diffs: [diff] };
  } catch (error: any) {
    return {
      success: false,
      importedCounts,
      diffs: [session.abort()],
      error: error.message,
    };
  }
}

/**
 * How many streamed EU records are buffered before being flushed to Firestore.
 * Keeps this task's own memory bounded independently of `uploadRecords`'
 * internal 500-per-batch write limit (issue #5) — a smaller buffer here would
 * just mean more, smaller Firestore batch commits, not a correctness change.
 */
export const EU_UPLOAD_CHUNK_SIZE = 500;

/** Same rationale as `EU_UPLOAD_CHUNK_SIZE`, for the streamed US SDN parse (issue #31). */
export const US_UPLOAD_CHUNK_SIZE = 500;

/** Same rationale as `EU_UPLOAD_CHUNK_SIZE`, for the streamed UK Sanctions List parse (issue #99). */
export const UK_UPLOAD_CHUNK_SIZE = 500;

/** Same rationale as `EU_UPLOAD_CHUNK_SIZE`, for the streamed CH SECO Sanctions List parse (issue #140). */
export const CH_UPLOAD_CHUNK_SIZE = 500;

/**
 * Main import function that coordinates fetching, parsing, and uploading.
 *
 * Each source is uploaded as soon as it (or, for EU, each chunk of it) is
 * parsed, rather than accumulated into one array across all sources before a
 * single upload at the end (issue #5) — the EU export alone is large enough
 * that holding it in memory next to UN and US was exhausting the deployed
 * Cloud Function's memory budget. `importedCounts` still reports how many
 * records each source *parsed*, matching the pre-existing contract;
 * `filterAutomatedBatch` (issue #10) is applied per chunk/source right before
 * each upload, equivalent to applying it once over the old combined array
 * since it only inspects each record's own `source` field.
 */
export async function runImport(options: ImportOptions = {}): Promise<{
  success: boolean;
  importedCounts: Record<string, number>;
  diffs?: StreamedDiffResult[];
  error?: string;
}> {
  if (options.uploadedFile) {
    return runUploadedFileImport(options.uploadedFile, options);
  }

  const sources = options.sources || ['EU', 'UN', 'US', 'UK', 'CH'];
  const importedCounts: Record<string, number> = {};
  const diffs: StreamedDiffResult[] = [];
  let totalParsed = 0;
  let totalUploaded = 0;

  log.info('import.start', { sources });

  try {
    const downloadsDir = path.resolve(__dirname, '../../downloads');
    await fs.ensureDir(downloadsDir);

    // 1. Process EU. Streamed one entity at a time and uploaded in chunks —
    // never held as a single array of every EU record.
    if (sources.includes('EU')) {
      const session = await startDiffSession('EU', diffOptionsFrom(options));
      let parseSucceeded = false;
      let buffer: SanctionRecord[] = [];
      let parsed = 0;
      let uploaded = 0;

      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        // issue #171: reading `uploaded` happens BEFORE evaluating an
        // awaited right-hand side in a compound assignment, so two
        // overlapping flushes would both read the same stale value and the
        // second write would clobber the first's contribution. Splitting
        // the read of `uploaded` to after the await removes that window.
        const addedCount = await session.addChunk(chunk);
        uploaded += addedCount;
      };

      try {
        const filePath = await downloadFile(SOURCE_URLS.EU, 'eu_sanctions.xml');
        await parseEUListStreaming(filePath, async (record) => {
          parsed++;
          buffer.push(record);
          if (buffer.length >= EU_UPLOAD_CHUNK_SIZE) {
            await flush();
          }
        });
        await flush();
        parseSucceeded = true;
      } catch (error: any) {
        // Report what actually made it to Firestore before the failure,
        // rather than silently claiming zero for records already persisted.
        await flush().catch(() => {});
        // abort(), not finish(): a partial parse cannot tell "removed
        // upstream" from "never reached", so nothing is delisted.
        diffs.push(session.abort());
        log.error('import.source_failed', { source: 'EU', error });
      }

      // finish() runs OUTSIDE the catch on purpose. A parse failure is
      // tolerated per source, but a tripped delist guard must abort the whole
      // import loudly rather than be swallowed as "error importing EU".
      if (parseSucceeded) diffs.push(await session.finish());

      importedCounts.EU = parsed;
      totalParsed += parsed;
      totalUploaded += uploaded;
    }

    // 2. Process UN. Uploaded immediately after parsing, not held alongside
    // EU/US records.
    if (sources.includes('UN')) {
      const session = await startDiffSession('UN', diffOptionsFrom(options));
      let unParseSucceeded = false;
      try {
        const filePath = await downloadFile(SOURCE_URLS.UN, 'un_sanctions.xml');
        const records = await parseUNList(filePath);
        importedCounts.UN = records.length;
        totalParsed += records.length;
        totalUploaded += await session.addChunk(records);
        unParseSucceeded = true;
      } catch (error: any) {
        diffs.push(session.abort());
        log.error('import.source_failed', { source: 'UN', error });
        importedCounts.UN = 0;
      }
      if (unParseSucceeded) diffs.push(await session.finish());
    }

    // 3. Process US (OFAC SDN). Streamed and chunk-uploaded like EU (issue #31)
    // — the real SDN export was measured to exceed the deployed function's
    // memory budget under the old full-DOM parse (see parsers/us.ts).
    if (sources.includes('US')) {
      const session = await startDiffSession('US', diffOptionsFrom(options));
      let usParseSucceeded = false;
      let buffer: SanctionRecord[] = [];
      let parsed = 0;
      let uploaded = 0;

      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        // issue #171: reading `uploaded` happens BEFORE evaluating an
        // awaited right-hand side in a compound assignment, so two
        // overlapping flushes would both read the same stale value and the
        // second write would clobber the first's contribution. Splitting
        // the read of `uploaded` to after the await removes that window.
        const addedCount = await session.addChunk(chunk);
        uploaded += addedCount;
      };

      try {
        const filePath = await downloadFile(SOURCE_URLS.US, 'us_sdn.xml');
        await parseUSListStreaming(filePath, async (record) => {
          parsed++;
          buffer.push(record);
          if (buffer.length >= US_UPLOAD_CHUNK_SIZE) {
            await flush();
          }
        });
        await flush();
        usParseSucceeded = true;
      } catch (error: any) {
        await flush().catch(() => {});
        diffs.push(session.abort());
        log.error('import.source_failed', { source: 'US', error });
      }
      if (usParseSucceeded) diffs.push(await session.finish());

      importedCounts.US = parsed;
      totalParsed += parsed;
      totalUploaded += uploaded;
    }

    // 4. Process UK (FCDO Sanctions List, issue #99). Streamed and
    // chunk-uploaded like EU/US — the real export (~22 MB) is in the same
    // size class.
    if (sources.includes('UK')) {
      const session = await startDiffSession('UK', diffOptionsFrom(options));
      let ukParseSucceeded = false;
      let buffer: SanctionRecord[] = [];
      let parsed = 0;
      let uploaded = 0;

      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        uploaded += await session.addChunk(chunk);
      };

      try {
        const filePath = await downloadFile(SOURCE_URLS.UK, 'uk_sanctions.xml');
        await parseUKListStreaming(filePath, async (record) => {
          parsed++;
          buffer.push(record);
          if (buffer.length >= UK_UPLOAD_CHUNK_SIZE) {
            await flush();
          }
        });
        await flush();
        ukParseSucceeded = true;
      } catch (error: any) {
        await flush().catch(() => {});
        diffs.push(session.abort());
        log.error('import.source_failed', { source: 'UK', error });
      }
      if (ukParseSucceeded) diffs.push(await session.finish());

      importedCounts.UK = parsed;
      totalParsed += parsed;
      totalUploaded += uploaded;
    }

    // 5. Process CH (SECO Sanctions List, issue #140). Streamed and
    // chunk-uploaded like EU/US/UK — the real export (~40 MB) is the largest
    // source ingested.
    if (sources.includes('CH')) {
      const session = await startDiffSession('CH', diffOptionsFrom(options));
      let chParseSucceeded = false;
      let buffer: SanctionRecord[] = [];
      let parsed = 0;
      let uploaded = 0;

      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        uploaded += await session.addChunk(chunk);
      };

      try {
        const filePath = await downloadFile(SOURCE_URLS.CH, 'ch_sanctions.xml');
        await parseChXmlStream(filePath, async (record) => {
          parsed++;
          buffer.push(record);
          if (buffer.length >= CH_UPLOAD_CHUNK_SIZE) {
            await flush();
          }
        });
        await flush();
        chParseSucceeded = true;
      } catch (error: any) {
        await flush().catch(() => {});
        diffs.push(session.abort());
        log.error('import.source_failed', { source: 'CH', error });
      }
      if (chParseSucceeded) diffs.push(await session.finish());

      importedCounts.CH = parsed;
      totalParsed += parsed;
      totalUploaded += uploaded;
    }

    // 5. Process CSV (PEP / Custom)
    if (options.csvPath) {
      try {
        const validation = validateCsvPath(options.csvPath);
        if (!validation.valid) {
          log.error('import.csv_forbidden_path', { path: options.csvPath, error: validation.error });
          throw new Error(`Forbidden csvPath: ${validation.error}`);
        }
        const absoluteCsvPath = validation.absolutePath!;
        if (await fs.pathExists(absoluteCsvPath)) {
          const csvSource = options.csvSource || 'PEP';
          const separator = options.csvSeparator || ';';
          const session = await startDiffSession(csvSource, diffOptionsFrom(options));
          const records = await parseCSVList(absoluteCsvPath, {
            separator,
            defaultSource: csvSource,
          });
          importedCounts[csvSource] = records.length;
          totalParsed += records.length;
          totalUploaded += await session.addChunk(records);
          diffs.push(await session.finish());
        } else {
          log.error('import.csv_file_not_found', { path: absoluteCsvPath });
        }
      } catch (error: any) {
        log.error('import.source_failed', { source: 'CSV', error });
      }
    }

    // 5. Report
    if (!options.dryRun && totalUploaded > 0) {
      await invalidateSearchIndex(); // next search rebuilds the in-memory index with the new data
    }

    if (totalParsed > 0) {
      const delisted = diffs.reduce((n, d) => n + d.counts.delisted, 0);
      const skipped = diffs.reduce((n, d) => n + d.counts.skipped, 0);
      log.info('import.finished', {
        parsed: totalParsed,
        uploaded: totalUploaded,
        delisted,
        skipped,
        sourceCount: diffs.length,
      });
      if (totalUploaded === 0 && delisted === 0 && skipped > 0) {
        log.warn('import.all_records_skipped');
        return {
          success: false,
          importedCounts,
          diffs,
          error: 'No uploadable records after filtering CUSTOM-sourced records',
        };
      }
      return { success: true, importedCounts, diffs };
    } else {
      log.warn('import.nothing_parsed');
      return { success: false, importedCounts, error: 'No records parsed' };
    }
  } catch (error: any) {
    log.error('import.pipeline_failed', { error });
    return { success: false, importedCounts, error: error.message };
  }
}

// Allow direct execution of the script
if (require.main === module) {
  const args = process.argv.slice(2);
  const importCSV = args.find(arg => arg.startsWith('--csv='));
  const csvPath = importCSV ? importCSV.split('=')[1] : undefined;

  runImport({
    csvPath,
    csvSource: 'PEP',
    csvSeparator: ';',
  })
    .then((res) => {
      log.info('cli_run.completed', { result: res });
      process.exit(0);
    })
    .catch((err) => {
      log.error('cli_run.failed', { error: err });
      process.exit(1);
    });
}
