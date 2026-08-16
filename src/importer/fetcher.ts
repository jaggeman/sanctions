import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { logger } from '../shared/logger';

const log = logger.child({ module: 'importer.fetcher' });

export const DOWNLOADS_DIR = path.resolve(__dirname, '../../downloads');

// A compromised/hijacked source host could redirect the download to an
// internal address, or a truncated/malicious response could exhaust disk —
// neither axios default (follow up to 5 redirects, no size cap on streamed
// responses) guards against that (issue #107). 200 MB is generous headroom
// over the real ~25 MB EU export while still bounding a runaway response.
const MAX_REDIRECTS = 5;
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

// URLs for the sanction XML lists
export const SOURCE_URLS = {
  EU: 'https://webgate.ec.europa.eu/europeaid/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content',
  UN: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
  US: 'https://www.treasury.gov/ofac/downloads/sdn.xml',
  UK: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml',
  CH: 'https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?lang=en&action=downloadXmlGesamtlisteAction',
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
    maxRedirects: MAX_REDIRECTS,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  // Only trustworthy when the server actually sends it (e.g. chunked
  // transfer-encoding often omits it) — null means "can't verify
  // completeness," not "the file is empty."
  const rawContentLength = response.headers?.['content-length'];
  const expectedBytes = rawContentLength !== undefined ? Number(rawContentLength) : null;
  let receivedBytes = 0;

  const writer = fs.createWriteStream(outputPath);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      response.data.destroy();
      writer.destroy();
      fs.remove(outputPath).catch((e) => log.error('download.cleanup_failed', { outputPath, error: e }));
      reject(err);
    };

    response.data.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        fail(new Error(`Download of ${url} exceeded the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB size limit.`));
      }
    });

    writer.on('finish', () => {
      if (settled) return;
      if (expectedBytes !== null && receivedBytes !== expectedBytes) {
        fail(new Error(`Download of ${url} is incomplete: expected ${expectedBytes} bytes, received ${receivedBytes}.`));
        return;
      }
      settled = true;
      resolve(outputPath);
    });
    writer.on('error', fail);
    // pipe() does not forward the source's errors to the destination — an
    // interrupted download (dropped connection mid-stream) would otherwise
    // leave this promise never settling instead of rejecting.
    response.data.on('error', fail);

    response.data.pipe(writer);
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

  try {
    paths.UK = await downloadFile(SOURCE_URLS.UK, 'uk_sanctions.xml');
  } catch (error: any) {
    log.error('download.failed', { source: 'UK', error });
  }

  try {
    paths.CH = await downloadFile(SOURCE_URLS.CH, 'ch_sanctions.xml');
  } catch (error: any) {
    log.error('download.failed', { source: 'CH', error });
  }

  return paths;
}
