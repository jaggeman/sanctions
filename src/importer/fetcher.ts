import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { logger } from '../shared/logger';

const log = logger.child({ module: 'importer.fetcher' });

export const DOWNLOADS_DIR = path.resolve(__dirname, '../../downloads');

// URLs for the sanction XML lists
export const SOURCE_URLS = {
  EU: 'https://webgate.ec.europa.eu/europeaid/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content',
  UN: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
  US: 'https://www.treasury.gov/ofac/downloads/sdn.xml',
};

/**
 * Downloads a file from a URL and saves it locally.
 */
export async function downloadFile(url: string, filename: string): Promise<string> {
  await fs.ensureDir(DOWNLOADS_DIR);
  const outputPath = path.join(DOWNLOADS_DIR, filename);

  log.info('download.start', { url, outputPath });

  const response = await axios({
    method: 'get',
    url: url,
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(outputPath));
    writer.on('error', (err) => reject(err));
    // pipe() does not forward the source's errors to the destination — an
    // interrupted download (dropped connection mid-stream) would otherwise
    // leave this promise never settling instead of rejecting.
    response.data.on('error', (err: Error) => reject(err));
  });
}

/**
 * Downloads all standard sanction XML lists.
 */
export async function downloadAllSources(): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};

  try {
    paths.EU = await downloadFile(SOURCE_URLS.EU, 'eu_sanctions.xml');
  } catch (error: any) {
    log.error('download.failed', { source: 'EU', error });
  }

  try {
    paths.UN = await downloadFile(SOURCE_URLS.UN, 'un_sanctions.xml');
  } catch (error: any) {
    log.error('download.failed', { source: 'UN', error });
  }

  try {
    paths.US = await downloadFile(SOURCE_URLS.US, 'us_sdn.xml');
  } catch (error: any) {
    log.error('download.failed', { source: 'US', error });
  }

  return paths;
}
