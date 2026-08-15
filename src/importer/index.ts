import * as path from 'path';
import * as fs from 'fs-extra';
import { downloadFile, SOURCE_URLS } from './fetcher';
import { parseEUList } from './parsers/eu';
import { parseUNList } from './parsers/un';
import { parseUSList } from './parsers/us';
import { parseCSVList } from './parsers/csv';
import { uploadRecords } from './uploader';
import { SanctionRecord } from '../shared/types';

interface ImportOptions {
  sources?: ('EU' | 'UN' | 'US')[];
  csvPath?: string;
  csvSource?: 'PEP' | 'CUSTOM';
  csvSeparator?: string;
}

/**
 * Main import function that coordinates fetching, parsing, and uploading.
 */
export async function runImport(options: ImportOptions = {}): Promise<{
  success: boolean;
  importedCounts: Record<string, number>;
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

    // 5. Upload everything to Firestore
    if (allRecords.length > 0) {
      await uploadRecords(allRecords);
      console.log(`Successfully processed and uploaded total of ${allRecords.length} records.`);
      return { success: true, importedCounts };
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
