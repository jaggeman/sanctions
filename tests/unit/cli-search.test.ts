import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runSearch = vi.fn();
vi.mock('../../src/search', () => ({ runSearch, invalidateSearchIndex: vi.fn() }));
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn() }));

let logs: string[] = [];
let errors: string[] = [];
let exitCode: number | undefined;

beforeEach(() => {
  logs = [];
  errors = [];
  exitCode = undefined;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(String(msg)); });
  vi.spyOn(console, 'error').mockImplementation((msg: string) => { errors.push(String(msg)); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    return undefined as never;
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function runCli(argv: string[]) {
  vi.resetModules();
  const mod = await import('../../src/cli/index');
  try {
    await mod.program.parseAsync(['node', 'cli', ...argv]);
  } catch {
    // expected: our mocked process.exit throws to halt execution
  }
}

describe('CLI search command', () => {
  it('calls the shared runSearch with the query and options', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await runCli(['search', 'Vladimir Putin', '--sources', 'PEP', '--type', 'individual', '--limit', '5']);

    expect(runSearch).toHaveBeenCalledWith(
      'Vladimir Putin',
      expect.objectContaining({ source: 'PEP', type: 'individual', limit: 5 }),
    );
  });

  it('issue #37: honors an explicit --limit 0 instead of silently falling back to the default', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await runCli(['search', 'Vladimir Putin', '--limit', '0']);

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.objectContaining({ limit: 0 }));
  });

  it('issue #161: falls back to the default limit of 10 when --limit is negative', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await runCli(['search', 'Vladimir Putin', '--limit', '-1']);

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.objectContaining({ limit: 10 }));

    await runCli(['search', 'Vladimir Putin', '--limit', '-40']);
    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.objectContaining({ limit: 10 }));
  });

  it('falls back to the default limit of 10 when --limit is omitted entirely', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await runCli(['search', 'Vladimir Putin']);

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.objectContaining({ limit: 10 }));
  });

  it('prints the score for each hit', async () => {
    runSearch.mockResolvedValue({
      results: [{ id: 'PEP-1', names: [{ wholeName: 'Vladimir Putin', strong: true }], source: 'PEP', type: 'individual', score: 92, matchedAlias: 'Vladimir Putin' }],
      totalMatches: 1,
      truncated: false,
    });
    await runCli(['search', 'Vladmir Putin']);
    expect(logs.join('\n')).toContain('92');
  });

  it('reports no matches without erroring', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await runCli(['search', 'Nobody Findable']);
    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toMatch(/inga träffar/i);
  });

  it('mentions total vs shown count when truncated', async () => {
    runSearch.mockResolvedValue({
      results: [{ id: 'PEP-1', names: [{ wholeName: 'X', strong: true }], source: 'PEP', type: 'individual', score: 90, matchedAlias: 'X' }],
      totalMatches: 42,
      truncated: true,
    });
    await runCli(['search', 'X']);
    expect(logs.join('\n')).toMatch(/42/);
  });

  it('issue #115: supports multiple search queries in a single invocation (batch mode with warm cache)', async () => {
    runSearch
      .mockResolvedValueOnce({
        results: [{ id: 'PEP-1', names: [{ wholeName: 'Vladimir Putin', strong: true }], source: 'PEP', type: 'individual', score: 92, matchedAlias: 'Vladimir Putin' }],
        totalMatches: 1,
        truncated: false,
      })
      .mockResolvedValueOnce({
        results: [{ id: 'PEP-2', names: [{ wholeName: 'Sergey Lavrov', strong: true }], source: 'PEP', type: 'individual', score: 88, matchedAlias: 'Sergey Lavrov' }],
        totalMatches: 1,
        truncated: false,
      });

    await runCli(['search', 'Vladimir Putin', 'Sergey Lavrov']);

    expect(runSearch).toHaveBeenCalledTimes(2);
    expect(runSearch).toHaveBeenNthCalledWith(1, 'Vladimir Putin', expect.objectContaining({ limit: 10 }));
    expect(runSearch).toHaveBeenNthCalledWith(2, 'Sergey Lavrov', expect.objectContaining({ limit: 10 }));
    expect(logs.join('\n')).toContain('Vladimir Putin');
    expect(logs.join('\n')).toContain('Sergey Lavrov');
    expect(exitCode).toBe(0);
  });

  it('issue #115: reads queries from --file in batch mode', async () => {
    const fs = await import('fs-extra');
    const os = await import('os');
    const path = await import('path');
    const tempFile = path.join(os.tmpdir(), `queries-${Date.now()}.txt`);
    await fs.writeFile(tempFile, '# Comments are ignored\nName One\n\nName Two\n');

    runSearch
      .mockResolvedValueOnce({ results: [], totalMatches: 0, truncated: false })
      .mockResolvedValueOnce({ results: [], totalMatches: 0, truncated: false });

    await runCli(['search', '--file', tempFile]);

    expect(runSearch).toHaveBeenCalledTimes(2);
    expect(runSearch).toHaveBeenNthCalledWith(1, 'Name One', expect.anything());
    expect(runSearch).toHaveBeenNthCalledWith(2, 'Name Two', expect.anything());
    expect(exitCode).toBe(0);

    await fs.remove(tempFile);
  });

  it('issue #115: exits with error if no query and no --file is provided', async () => {
    await runCli(['search']);
    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/minst ett sökord|fil/i);
  });
});
