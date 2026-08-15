import * as crypto from 'crypto';
import * as fs from 'fs';

export interface FileHash {
  sha256: string;
  sizeBytes: number;
}

/**
 * Hashes a file streaming, never reading it fully into memory — a 25 MB
 * upload buffered whole would reintroduce the same problem tracked (and
 * fixed for parsing) in issue #5.
 */
export function hashFileStreaming(filePath: string): Promise<FileHash> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sizeBytes += buf.length;
      hash.update(buf);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), sizeBytes }));
  });
}
