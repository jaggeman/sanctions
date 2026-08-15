import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, PassThrough } from 'stream';
import * as path from 'path';

const ensureDir = vi.fn(async () => {});
const createWriteStream = vi.fn(() => new PassThrough());
vi.mock('fs-extra', () => ({
  ensureDir: (...args: any[]) => ensureDir(...args),
  createWriteStream: (...args: any[]) => createWriteStream(...args),
}));

const axiosMock = vi.fn();
vi.mock('axios', () => ({ default: (...args: any[]) => axiosMock(...args) }));

// Dynamic import: src/importer/fetcher.ts imports fs-extra/axios at module
// scope, which the mocks above must already be registered for — vi.mock
// calls are hoisted above top-level consts, so a static import here would
// risk the same TDZ ordering issue as elsewhere in this suite. Matches the
// project's own established pattern for this exact situation.
const { downloadFile, downloadAllSources, DOWNLOADS_DIR, SOURCE_URLS } =
  await import('../../src/importer/fetcher');

function readableWithChunks(chunks: string[]): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i < chunks.length) {
        this.push(chunks[i++]);
      } else {
        this.push(null);
      }
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createWriteStream.mockImplementation(() => new PassThrough());
});

describe('downloadFile', () => {
  it('resolves with the expected output path on a successful download', async () => {
    axiosMock.mockResolvedValue({ data: readableWithChunks(['<xml/>']) });

    const result = await downloadFile('https://example.test/list.xml', 'list.xml');

    expect(result).toBe(path.join(DOWNLOADS_DIR, 'list.xml'));
    expect(ensureDir).toHaveBeenCalledWith(DOWNLOADS_DIR);
  });

  it('streams the response to disk instead of buffering it in memory', async () => {
    axiosMock.mockResolvedValue({ data: readableWithChunks(['a']) });

    await downloadFile('https://example.test/list.xml', 'list.xml');

    expect(axiosMock).toHaveBeenCalledWith(
      expect.objectContaining({ responseType: 'stream' }),
    );
  });

  it('pipes the response into a write stream at the expected path', async () => {
    axiosMock.mockResolvedValue({ data: readableWithChunks(['a']) });

    await downloadFile('https://example.test/list.xml', 'list.xml');

    expect(createWriteStream).toHaveBeenCalledWith(path.join(DOWNLOADS_DIR, 'list.xml'));
  });

  it('rejects when the request itself errors, instead of swallowing it', async () => {
    axiosMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.test'));

    await expect(downloadFile('https://example.test/list.xml', 'list.xml')).rejects.toThrow(
      /ENOTFOUND/,
    );
  });

  it('rejects if the response stream errors partway through (interrupted download)', async () => {
    const stream = new Readable({ read() {} });
    axiosMock.mockResolvedValue({ data: stream });

    const promise = downloadFile('https://example.test/list.xml', 'list.xml');

    // downloadFile awaits ensureDir/axios before wiring up the error
    // listener — give those a tick to settle before emitting, or the error
    // fires before anything is listening.
    await new Promise((r) => setImmediate(r));

    stream.push('partial-chunk');
    stream.emit('error', new Error('socket hang up'));

    await expect(promise).rejects.toThrow('socket hang up');
  });
});

describe('downloadAllSources', () => {
  it("attempts every source even when one fails, and only returns paths for what actually succeeded", async () => {
    axiosMock.mockImplementation(async (opts: any) => {
      if (opts.url === SOURCE_URLS.EU) {
        throw new Error('EU source unreachable');
      }
      return { data: readableWithChunks(['<xml/>']) };
    });

    const paths = await downloadAllSources();

    expect(axiosMock).toHaveBeenCalledTimes(3);
    const requestedUrls = axiosMock.mock.calls.map((call) => call[0].url);
    expect(requestedUrls.sort()).toEqual(
      [SOURCE_URLS.EU, SOURCE_URLS.UN, SOURCE_URLS.US].sort(),
    );

    expect(paths.EU).toBeUndefined();
    expect(paths.UN).toBe(path.join(DOWNLOADS_DIR, 'un_sanctions.xml'));
    expect(paths.US).toBe(path.join(DOWNLOADS_DIR, 'us_sdn.xml'));
  });

  it('returns paths for all three sources when every download succeeds', async () => {
    axiosMock.mockResolvedValue({ data: readableWithChunks(['<xml/>']) });

    const paths = await downloadAllSources();

    expect(Object.keys(paths).sort()).toEqual(['EU', 'UN', 'US']);
  });
});
