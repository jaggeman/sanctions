import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import * as path from 'path';

const ensureDir = vi.fn(async () => {});
const createWriteStream = vi.fn(() => new PassThrough());
const remove = vi.fn(async () => {});
vi.mock('fs-extra', () => ({
  ensureDir: (...args: any[]) => ensureDir(...args),
  createWriteStream: (...args: any[]) => createWriteStream(...args),
  remove: (...args: any[]) => remove(...args),
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
  // .resume() puts the mock sink in flowing mode so it drains immediately —
  // without a real disk (or another consumer) behind it, an unconsumed
  // PassThrough backpressures and stalls once a write exceeds its internal
  // highWaterMark, which a large-download test needs to push past.
  createWriteStream.mockImplementation(() => {
    const s = new PassThrough();
    s.resume();
    return s;
  });
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

  it('sets an explicit, bounded maxRedirects rather than trusting axios defaults (issue #107)', async () => {
    axiosMock.mockResolvedValue({ data: readableWithChunks(['a']), headers: {} });

    await downloadFile('https://example.test/list.xml', 'list.xml');

    expect(axiosMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxRedirects: expect.any(Number) }),
    );
    const call = axiosMock.mock.calls[0][0];
    expect(call.maxRedirects).toBeGreaterThanOrEqual(0);
    expect(call.maxRedirects).toBeLessThanOrEqual(5);
  });

  it('aborts and cleans up the partial file once the download exceeds the size cap (issue #107)', async () => {
    const stream = new Readable({ read() {} });
    axiosMock.mockResolvedValue({ data: stream, headers: {} });

    const promise = downloadFile('https://example.test/list.xml', 'list.xml');
    await new Promise((r) => setImmediate(r));

    // One chunk well over any reasonable cap for a sanctions-list XML file.
    stream.push(Buffer.alloc(250 * 1024 * 1024, 'a'));

    await expect(promise).rejects.toThrow(/size limit/i);
    expect(remove).toHaveBeenCalledWith(path.join(DOWNLOADS_DIR, 'list.xml'));
  });

  it('rejects a download that stops short of the server-declared Content-Length (issue #107)', async () => {
    const stream = new Readable({ read() {} });
    axiosMock.mockResolvedValue({ data: stream, headers: { 'content-length': '1000' } });

    const promise = downloadFile('https://example.test/list.xml', 'list.xml');
    await new Promise((r) => setImmediate(r));

    stream.push('short'); // 5 bytes, nowhere near the declared 1000
    stream.push(null); // clean end-of-stream — a truncated-but-not-erroring connection

    await expect(promise).rejects.toThrow(/incomplete/i);
  });

  it('succeeds normally when Content-Length matches the actual bytes received', async () => {
    const body = '<xml/>';
    axiosMock.mockResolvedValue({
      data: readableWithChunks([body]),
      headers: { 'content-length': String(Buffer.byteLength(body)) },
    });

    const result = await downloadFile('https://example.test/list.xml', 'list.xml');
    expect(result).toBe(path.join(DOWNLOADS_DIR, 'list.xml'));
  });

  it('succeeds without a completeness check when the server sends no Content-Length at all', async () => {
    axiosMock.mockResolvedValue({ data: readableWithChunks(['<xml/>']), headers: {} });

    const result = await downloadFile('https://example.test/list.xml', 'list.xml');
    expect(result).toBe(path.join(DOWNLOADS_DIR, 'list.xml'));
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

    expect(axiosMock).toHaveBeenCalledTimes(5);
    const requestedUrls = axiosMock.mock.calls.map((call) => call[0].url);
    expect(requestedUrls.sort()).toEqual(
      [SOURCE_URLS.EU, SOURCE_URLS.UN, SOURCE_URLS.US, SOURCE_URLS.UK, SOURCE_URLS.CH].sort(),
    );

    expect(paths.EU).toBeUndefined();
    expect(paths.UN).toBe(path.join(DOWNLOADS_DIR, 'un_sanctions.xml'));
    expect(paths.US).toBe(path.join(DOWNLOADS_DIR, 'us_sdn.xml'));
    expect(paths.UK).toBe(path.join(DOWNLOADS_DIR, 'uk_sanctions.xml'));
    expect(paths.CH).toBe(path.join(DOWNLOADS_DIR, 'ch_sanctions.xml'));
  });

  it('returns paths for all five sources when every download succeeds', async () => {
    axiosMock.mockResolvedValue({ data: readableWithChunks(['<xml/>']) });

    const paths = await downloadAllSources();

    expect(Object.keys(paths).sort()).toEqual(['CH', 'EU', 'UK', 'UN', 'US']);
  });
});
