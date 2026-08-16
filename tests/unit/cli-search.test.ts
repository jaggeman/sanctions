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
});
