import { describe, it, expect, vi } from 'vitest';

const mockCreateReadStream = vi.fn();
vi.mock('fs-extra', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs-extra')>();
  return { ...actual, createReadStream: mockCreateReadStream };
});

const { streamXmlRecords } = await import('../../src/importer/parsers/xmlSubtreeStream');

/**
 * A fake fs.createReadStream() return value: streamXmlRecords only ever
 * calls .pause()/.resume()/.destroy()/.on('error', ...)/.pipe(dest) on it —
 * captures the piped destination (the real sax parser stream) so the test
 * can drive parsing directly via .write()/.end(), while spying on
 * pause/resume to observe the actual backpressure sequencing.
 */
function makeFakeReadStream() {
  let destination: any = null;
  const fake: any = {
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(() => fake),
    pipe: (dest: any) => {
      destination = dest;
      return dest;
    },
  };
  return { fake, getDestination: () => destination };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('streamXmlRecords — backpressure (issue #171)', () => {
  it('does not resume the source stream until every outstanding onSubtree promise has resolved, not just the first', async () => {
    const { fake, getDestination } = makeFakeReadStream();
    mockCreateReadStream.mockReturnValue(fake);

    const dA = deferred();
    const dB = deferred();
    const pending: Record<string, ReturnType<typeof deferred>> = { A: dA, B: dB };

    const resultPromise = streamXmlRecords('irrelevant.xml', 'r', (subtree: any) => {
      return pending[subtree].promise;
    });

    const parserStream = getDestination();
    // Both closetags fire synchronously within this single write — the exact
    // scenario that reaches the bug: onSubtree is invoked for A and then B
    // before either promise has settled.
    parserStream.write('<root><r>A</r><r>B</r></root>');

    expect(fake.pause).toHaveBeenCalled();
    expect(fake.resume).not.toHaveBeenCalled();

    // B (the second/later record) resolves first. If resume() fires here,
    // that's exactly the bug: A's own flush is still outstanding.
    dB.resolve();
    await flushMicrotasks();
    expect(fake.resume).not.toHaveBeenCalled();

    dA.resolve();
    parserStream.end();
    await resultPromise;
    expect(fake.resume).toHaveBeenCalledTimes(1);
  });

  it('still resumes exactly once when only a single onSubtree promise is outstanding', async () => {
    const { fake, getDestination } = makeFakeReadStream();
    mockCreateReadStream.mockReturnValue(fake);

    const d = deferred();
    const resultPromise = streamXmlRecords('irrelevant.xml', 'r', () => d.promise);

    const parserStream = getDestination();
    parserStream.write('<root><r>only</r></root>');
    expect(fake.pause).toHaveBeenCalledTimes(1);

    d.resolve();
    parserStream.end();
    await resultPromise;
    expect(fake.resume).toHaveBeenCalledTimes(1);
  });
});
