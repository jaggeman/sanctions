import * as path from 'path';
import * as fs from 'fs-extra';
import { downloadFile, SOURCE_URLS } from './fetcher';
import { parseEUListStreaming } from './parsers/eu';
import { parseUNList } from './parsers/un';
import { parseUSListStreaming } from './parsers/us';
import { parseCSVList } from './parsers/csv';
import { uploadRecords, filterAutomatedBatch } from './uploader';
import { runDiffForSource, DEFAULT_IMPORT_MODE, ImportMode, DiffResult } from './diff';
import { invalidateSearchIndex } from '../search';
import { SanctionRecord, SanctionSource } from '../shared/types';

interface ImportOptions {
  sources?: ('EU' | 'UN' | 'US')[];
  csvPath?: string;
  csvSource?: 'PEP' | 'CUSTOM';
  csvSeparator?: string;
  /**
   * issue #7: parse one specific, already-on-disk file (typically a user
   * upload whose format was already sniffed by formatDetection.ts) instead
   * of the download-or-csvPath model below. Self-contained — set this XOR
   * the other options, never both.
   */
  uploadedFile?: {
    path: string;
    format: 'eu-xml-1.1' | 'un-xml' | 'us-xml' | 'csv';
    source: SanctionSource;
  };
  // Issue #8: reconcile against current state instead of blindly overwriting.
  // Defaults to 'append' (never delists) — 'sync' must be opted into per
  // call, since getting this wrong on a partial/CSV-style file would delist
  // an entire source.
  mode?: ImportMode;
  dryRun?: boolean;
  force?: boolean;
  importId?: string;
}

/**
 * How many streamed records are buffered before being flushed to Firestore
 * in the separate `uploadedFile` path (issue #7) below. Unrelated to the
 * main `sources`-array path, which hands each source's full record set to
 * the diff engine (issue #8) instead of chunk-uploading directly.
 */
export const EU_UPLOAD_CHUNK_SIZE = 500;
export const US_UPLOAD_CHUNK_SIZE = 500;

async function uploadFiltered(records: SanctionRecord[]): Promise<number> {
  const uploadable = filterAutomatedBatch(records);
  if (uploadable.length > 0) {
    await uploadRecords(uploadable);
  }
  return uploadable.length;
}

/** Handles ImportOptions.uploadedFile — see issue #7. */
async function runUploadedFileImport(
  file: NonNullable<ImportOptions['uploadedFile']>,
): Promise<{ success: boolean; importedCounts: Record<string, number>; error?: string }> {
  const importedCounts: Record<string, number> = {};

  try {
    let parsed = 0;
    let uploaded = 0;

    if (file.format === 'eu-xml-1.1') {
      let buffer: SanctionRecord[] = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        uploaded += await uploadFiltered(chunk);
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
      uploaded = await uploadFiltered(records);
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
        uploaded += await uploadFiltered(chunk);
      };
      await parseUSListStreaming(file.path, async (record) => {
        parsed++;
        buffer.push(record);
        if (buffer.length >= EU_UPLOAD_CHUNK_SIZE) await flush();
      });
      await flush();
    } else {
      const records = await parseCSVList(file.path, {
        separator: ';',
        defaultSource: file.source as 'PEP' | 'CUSTOM',
      });
      parsed = records.length;
      uploaded = await uploadFiltered(records);
    }

    importedCounts[file.source] = parsed;

    if (uploaded > 0) {
      invalidateSearchIndex();
      return { success: true, importedCounts };
    } else if (parsed > 0) {
      return {
        success: false,
        importedCounts,
        error: 'No uploadable records after filtering CUSTOM-sourced records',
      };
    } else {
      return { success: false, importedCounts, error: 'No records parsed' };
    }
  } catch (error: any) {
    return { success: false, importedCounts, error: error.message };
  }
}

/**
 * Main import function that coordinates fetching, parsing, and reconciling.
 *
 * Each source is streamed/parsed one at a time and its records accumulated
 * into a per-source array (issue #5: streaming the XML parse itself is what
 * keeps memory bounded — the DOM-parse blowup this fixed was in materialising
 * the raw XML tree, not in holding ~6k already-parsed SanctionRecord objects
 * for one source, which the diff engine below needs anyway to compute
 * added/updated/unchanged/delisted). `filterAutomatedBatch` (issue #10) is
 * applied per source right before diffing, same as it was applied per upload
 * before this task.
 *
 * A source whose parse throws partway through is excluded from the
 * reconcile pass entirely (see `completedSources` below) rather than
 * reconciling whatever partial records it managed to collect — the records
 * it never reached would otherwise look identical to the diff engine as
 * "missing from the file" and get delisted in `sync` mode (issue #8's own
 * gotcha: a truncated parse must never trigger a delist pass over records it
 * never saw).
 */
export async function runImport(options: ImportOptions = {}): Promise<{
  success: boolean;
  importedCounts: Record<string, number>;
  diffs?: DiffResult[];
  error?: string;
}> {
  if (options.uploadedFile) {
    return runUploadedFileImport(options.uploadedFile);
  }

  const sources = options.sources || ['EU', 'UN', 'US'];
  const importedCounts: Record<string, number> = {};
  const bySource = new Map<SanctionSource, SanctionRecord[]>();
  const completedSources = new Set<SanctionSource>();

  console.log(`Starting import process for sources: ${sources.join(', ')}`);

  try {
    const downloadsDir = path.resolve(__dirname, '../../downloads');
    await fs.ensureDir(downloadsDir);

    const addToSource = (source: SanctionSource, record: SanctionRecord) => {
      const bucket = bySource.get(source) || [];
      bucket.push(record);
      bySource.set(source, bucket);
    };

    // 1. Process EU. Streamed one entity at a time — never held as a single
    // DOM/array of every EU record during parsing.
    if (sources.includes('EU')) {
      let parsed = 0;
      try {
        const filePath = await downloadFile(SOURCE_URLS.EU, 'eu_sanctions.xml');
        await parseEUListStreaming(filePath, async (record) => {
          parsed++;
          addToSource('EU', record);
        });
        completedSources.add('EU');
      } catch (error: any) {
        console.error(`Error importing EU sanctions list: ${error.message}`);
      }
      importedCounts.EU = parsed;
    }

    // 2. Process UN.
    if (sources.includes('UN')) {
      try {
        const filePath = await downloadFile(SOURCE_URLS.UN, 'un_sanctions.xml');
        const records = await parseUNList(filePath);
        importedCounts.UN = records.length;
        for (const record of records) addToSource('UN', record);
        completedSources.add('UN');
      } catch (error: any) {
        console.error(`Error importing UN sanctions list: ${error.message}`);
        importedCounts.UN = 0;
      }
    }

    // 3. Process US (OFAC SDN). Streamed like EU (issue #31) — the real SDN
    // export was measured to exceed the deployed function's memory budget
    // under the old full-DOM parse (see parsers/us.ts).
    if (sources.includes('US')) {
      let parsed = 0;
      try {
        const filePath = await downloadFile(SOURCE_URLS.US, 'us_sdn.xml');
        await parseUSListStreaming(filePath, async (record) => {
          parsed++;
          addToSource('US', record);
        });
        completedSources.add('US');
      } catch (error: any) {
        console.error(`Error importing US sanctions list: ${error.message}`);
      }
      importedCounts.US = parsed;
    }

    // 4. Process CSV (PEP / Custom)
    if (options.csvPath) {
      try {
        const absoluteCsvPath = path.resolve(options.csvPath);
        if (await fs.pathExists(absoluteCsvPath)) {
          const csvSource = options.csvSource || 'PEP';
          const separator = options.csvSeparator || ';';
          const records = await parseCSVList(absoluteCsvPath, {
            separator,
            defaultSource: csvSource,
          });
          importedCounts[csvSource] = records.length;
          for (const record of records) addToSource(csvSource, record);
          completedSources.add(csvSource);
        } else {
          console.error(`CSV file not found at path: ${absoluteCsvPath}`);
        }
      } catch (error: any) {
        console.error(`Error importing CSV file: ${error.message}`);
      }
    }

    // 5. Reconcile each successfully-parsed source against its current state
    // (issue #8). Scoped to one source at a time — comparing "all active
    // records missing from this batch" across mixed sources would delist
    // every UN/US record the moment an EU-only file comes through.
    const totalParsed = [...bySource.values()].reduce((sum, records) => sum + records.length, 0);

    if (totalParsed > 0) {
      const diffs: DiffResult[] = [];
      for (const [source, recordsForSource] of bySource) {
        if (!completedSources.has(source)) {
          console.warn(`Skipping reconciliation for ${source}: its parse did not complete successfully.`);
          continue;
        }
        const diff = await runDiffForSource(source, filterAutomatedBatch(recordsForSource), {
          mode: options.mode || DEFAULT_IMPORT_MODE,
          dryRun: options.dryRun,
          force: options.force,
          importId: options.importId,
        });
        diffs.push(diff);
      }

      if (!options.dryRun) {
        invalidateSearchIndex(); // next search rebuilds the in-memory index with the new data
      }
      console.log(`Successfully processed ${totalParsed} records across ${bySource.size} source(s).`);
      return { success: true, importedCounts, diffs };
    } else {
      console.warn('No records were parsed or imported.');
      return { success: false, importedCounts, error: 'No records parsed' };
    }
  } catch (error: any) {
    console.error(`Import pipeline failed: ${error.message}`);
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
      console.log('Import completed:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Import failed with error:', err);
      process.exit(1);
    });
}
