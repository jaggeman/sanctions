import * as path from 'path';
import * as fs from 'fs-extra';
import { downloadFile, SOURCE_URLS } from './fetcher';
import { parseEUList } from './parsers/eu';
import { parseUNList } from './parsers/un';
import { parseUSList } from './parsers/us';
import { parseCSVList } from './parsers/csv';
import { runDiffForSource, DEFAULT_IMPORT_MODE, ImportMode, DiffResult } from './diff';
import { invalidateSearchIndex } from '../search';
import { SanctionRecord, SanctionSource } from '../shared/types';

interface ImportOptions {
  sources?: ('EU' | 'UN' | 'US')[];
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
}

/**
 * Main import function that coordinates fetching, parsing, and uploading.
 */
export async function runImport(options: ImportOptions = {}): Promise<{
  success: boolean;
  importedCounts: Record<string, number>;
  diffs?: DiffResult[];
  error?: string;
}> {
  const sources = options.sources || ['EU', 'UN', 'US'];
  const importedCounts: Record<string, number> = {};
  
  console.log(`Starting import process for sources: ${sources.join(', ')}`);

  try {
    const allRecords: SanctionRecord[] = [];
    const downloadsDir = path.resolve(__dirname, '../../downloads');
    await fs.ensureDir(downloadsDir);

    // 1. Process EU
    if (sources.includes('EU')) {
      try {
        const filePath = await downloadFile(SOURCE_URLS.EU, 'eu_sanctions.xml');
        const records = await parseEUList(filePath);
        allRecords.push(...records);
        importedCounts.EU = records.length;
      } catch (error: any) {
        console.error(`Error importing EU sanctions list: ${error.message}`);
        importedCounts.EU = 0;
      }
    }

    // 2. Process UN
    if (sources.includes('UN')) {
      try {
        const filePath = await downloadFile(SOURCE_URLS.UN, 'un_sanctions.xml');
        const records = await parseUNList(filePath);
        allRecords.push(...records);
        importedCounts.UN = records.length;
      } catch (error: any) {
        console.error(`Error importing UN sanctions list: ${error.message}`);
        importedCounts.UN = 0;
      }
    }

    // 3. Process US (OFAC SDN)
    if (sources.includes('US')) {
      try {
        const filePath = await downloadFile(SOURCE_URLS.US, 'us_sdn.xml');
        const records = await parseUSList(filePath);
        allRecords.push(...records);
        importedCounts.US = records.length;
      } catch (error: any) {
        console.error(`Error importing US sanctions list: ${error.message}`);
        importedCounts.US = 0;
      }
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
          allRecords.push(...records);
          importedCounts[csvSource] = records.length;
        } else {
          console.error(`CSV file not found at path: ${absoluteCsvPath}`);
        }
      } catch (error: any) {
        console.error(`Error importing CSV file: ${error.message}`);
      }
    }

    // 5. Reconcile each source's records against its current state (issue #8)
    if (allRecords.length > 0) {
      // Scope the diff/delist pass to one source at a time — comparing "all
      // active records missing from this batch" across mixed sources would
      // delist every UN/US record the moment an EU-only file comes through.
      const bySource = new Map<SanctionSource, SanctionRecord[]>();
      for (const record of allRecords) {
        const bucket = bySource.get(record.source) || [];
        bucket.push(record);
        bySource.set(record.source, bucket);
      }

      const diffs: DiffResult[] = [];
      for (const [source, recordsForSource] of bySource) {
        const diff = await runDiffForSource(source, recordsForSource, {
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
      console.log(`Successfully processed ${allRecords.length} records across ${bySource.size} source(s).`);
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
