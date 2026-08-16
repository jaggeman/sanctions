import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const addMock = vi.fn();
const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name !== 'searchLog') throw new Error(`unexpected collection ${name}`);
    return { add: addMock };
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));

const { logSearchEvent } = await import('../../src/search/searchLog');

function readJsonLines(spy: ReturnType<typeof vi.spyOn>): any[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe('logSearchEvent', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('LOG_LEVEL', 'debug');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('writes the entry to the searchLog collection', async () => {
    const entry = {
      action: 'search' as const,
      requestedBy: 'analyst@example.com',
      query: 'Vladimir Putin',
      resultCount: 3,
      timestamp: '2026-08-16T00:00:00.000Z',
    };

    await logSearchEvent(entry);

    expect(fakeDb.collection).toHaveBeenCalledWith('searchLog');
    expect(addMock).toHaveBeenCalledWith(entry);
  });

  it('supports a "lookup" entry (GET /api/sanctions/:id)', async () => {
    const entry = {
      action: 'lookup' as const,
      requestedBy: 'token:tok-1',
      entityId: 'EU-13',
      resultCount: 1,
      timestamp: '2026-08-16T00:00:00.000Z',
    };

    await logSearchEvent(entry);

    expect(addMock).toHaveBeenCalledWith(entry);
  });

  it('never throws when the write fails — logs the failure instead', async () => {
    addMock.mockRejectedValueOnce(new Error('Firestore unavailable'));

    await expect(
      logSearchEvent({
        action: 'search',
        requestedBy: 'analyst@example.com',
        query: 'test',
        resultCount: 0,
        timestamp: '2026-08-16T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    const lines = readJsonLines(errorSpy);
    const failureLine = lines.find((l) => l.message === 'searchLog.write_failed');
    expect(failureLine).toBeTruthy();
    expect(failureLine.action).toBe('search');
  });
});
