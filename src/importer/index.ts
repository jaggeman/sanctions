import * as path from 'path';
import * as fs from 'fs-extra';
import { downloadFile, SOURCE_URLS } from './fetcher';
import { parseEUListStreaming } from './parsers/eu';
import { parseUNList } from './parsers/un';
import { parseUSListStreaming } from './parsers/us';
import { parseCSVList } from './parsers/csv';
import { uploadRecords, filterAutomatedBatch } from './uploader';
import { invalidateSearchIndex } from '../search';
import { SanctionRecord } from '../shared/types';

interface ImportOptions {
  sources?: ('EU' | 'UN' | 'US')[];
  csvPath?: string;
  csvSource?: 'PEP' | 'CUSTOM';
  csvSeparator?: string;
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
  error?: string;
}> {
  const sources = options.sources || ['EU', 'UN', 'US'];
  const importedCounts: Record<string, number> = {};
  let totalParsed = 0;
  let totalUploaded = 0;

  console.log(`Starting import process for sources: ${sources.join(', ')}`);

  const uploadFiltered = async (records: SanctionRecord[]): Promise<number> => {
    const uploadable = filterAutomatedBatch(records);
    if (uploadable.length > 0) {
      await uploadRecords(uploadable);
    }
    return uploadable.length;
  };

  try {
    const downloadsDir = path.resolve(__dirname, '../../downloads');
    await fs.ensureDir(downloadsDir);

    // 1. Process EU. Streamed one entity at a time and uploaded in chunks —
    // never held as a single array of every EU record.
    if (sources.includes('EU')) {
      let buffer: SanctionRecord[] = [];
      let parsed = 0;
      let uploaded = 0;

      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        uploaded += await uploadFiltered(chunk);
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
      } catch (error: any) {
        // Report what actually made it to Firestore before the failure,
        // rather than silently claiming zero for records already persisted.
        await flush().catch(() => {});
        console.error(`Error importing EU sanctions list: ${error.message}`);
      }

      importedCounts.EU = parsed;
      totalParsed += parsed;
      totalUploaded += uploaded;
    }

    // 2. Process UN. Uploaded immediately after parsing, not held alongside
    // EU/US records.
    if (sources.includes('UN')) {
      try {
        const filePath = await downloadFile(SOURCE_URLS.UN, 'un_sanctions.xml');
        const records = await parseUNList(filePath);
        importedCounts.UN = records.length;
        totalParsed += records.length;
        totalUploaded += await uploadFiltered(records);
      } catch (error: any) {
        console.error(`Error importing UN sanctions list: ${error.message}`);
        importedCounts.UN = 0;
      }
    }

    // 3. Process US (OFAC SDN). Streamed and chunk-uploaded like EU (issue #31)
    // — the real SDN export was measured to exceed the deployed function's
    // memory budget under the old full-DOM parse (see parsers/us.ts).
    if (sources.includes('US')) {
      let buffer: SanctionRecord[] = [];
      let parsed = 0;
      let uploaded = 0;

      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        uploaded += await uploadFiltered(chunk);
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
      } catch (error: any) {
        await flush().catch(() => {});
        console.error(`Error importing US sanctions list: ${error.message}`);
      }

      importedCounts.US = parsed;
      totalParsed += parsed;
      totalUploaded += uploaded;
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
          totalParsed += records.length;
          totalUploaded += await uploadFiltered(records);
        } else {
          console.error(`CSV file not found at path: ${absoluteCsvPath}`);
        }
      } catch (error: any) {
        console.error(`Error importing CSV file: ${error.message}`);
      }
    }

    // 5. Report
    if (totalUploaded > 0) {
      invalidateSearchIndex(); // next search rebuilds the in-memory index with the new data
      console.log(`Successfully processed and uploaded total of ${totalUploaded} records.`);
      return { success: true, importedCounts };
    } else if (totalParsed > 0) {
      console.warn('All parsed records were CUSTOM-sourced and were dropped from this automated import — see filterAutomatedBatch.');
      return { success: false, importedCounts, error: 'No uploadable records after filtering CUSTOM-sourced records' };
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
