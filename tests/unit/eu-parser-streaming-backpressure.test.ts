import { describe, it, expect, vi } from 'vitest';

// Kept in its own file, separate from eu-parser-streaming.test.ts, since that
// file reads a real fixture off disk and must not have fs-extra mocked.
const mockCreateReadStream = vi.fn();
vi.mock('fs-extra', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs-extra')>();
  return { ...actual, createReadStream: mockCreateReadStream };
});

const { parseEUListStreaming } = await import('../../src/importer/parsers/eu');

/**
 * A fake fs.createReadStream() return value: parseEUListStreaming only ever
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

const EU_NS = 'xmlns="http://eu.europa.ec/fpi/fsd/export"';

function entityXml(logicalId: string, name: string): string {
  return `<sanctionEntity logicalId="${logicalId}"><subjectType code="person" classificationCode="P"/><nameAlias wholeName="${name}" strong="true"/></sanctionEntity>`;
}

describe('parseEUListStreaming — backpressure (issue #171)', () => {
  it('does not resume the source stream until every outstanding onRecord promise has resolved, not just the first', async () => {
    const { fake, getDestination } = makeFakeReadStream();
    mockCreateReadStream.mockReturnValue(fake);

    const dFirst = deferred();
    const dSecond = deferred();
    const byLogicalId: Record<string, ReturnType<typeof deferred>> = { '1': dFirst, '2': dSecond };

    const resultPromise = parseEUListStreaming('irrelevant.xml', (record) => {
      const logicalId = record.id.replace('EU-', '');
      return byLogicalId[logicalId].promise;
    });

    const parserStream = getDestination();
    // Both closetags fire synchronously within this single write — the exact
    // scenario that reaches the bug.
    parserStream.write(
      `<?xml version="1.0"?><export ${EU_NS}>${entityXml('1', 'First Person')}${entityXml('2', 'Second Person')}</export>`,
    );

    expect(fake.pause).toHaveBeenCalled();
    expect(fake.resume).not.toHaveBeenCalled();

    // The second (later) record resolves first. If resume() fires here,
    // that's the bug: the first record's flush is still outstanding.
    dSecond.resolve();
    await flushMicrotasks();
    expect(fake.resume).not.toHaveBeenCalled();

    dFirst.resolve();
    parserStream.end();
    await resultPromise;
    expect(fake.resume).toHaveBeenCalledTimes(1);
  });
});
