import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runImport = vi.fn();
vi.mock('../../src/importer', () => ({ runImport }));
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/search', () => ({ runSearch: vi.fn() }));

let logs: string[] = [];
let errors: string[] = [];
let tables: any[] = [];
let exitCode: number | undefined;

beforeEach(() => {
  logs = [];
  errors = [];
  tables = [];
  exitCode = undefined;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: any[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'table').mockImplementation((data: any) => { tables.push(data); });
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
    // in case a future change makes the mocked exit throw again
  }
}

describe('CLI import command — argument parsing / wiring to runImport', () => {
  it('defaults to all three sources when --sources is omitted', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: {} });
    await runCli(['import']);

    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ sources: ['EU', 'UN', 'US'] }));
  });

  it('parses a comma-separated --sources list, uppercased and trimmed', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: {} });
    await runCli(['import', '--sources', ' eu, un ']);

    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ sources: ['EU', 'UN'] }));
  });

  it('passes --csv/--csv-source/--csv-separator through to runImport', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: {} });
    await runCli(['import', '--csv', './people.csv', '--csv-source', 'CUSTOM', '--csv-separator', ',']);

    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({
      csvPath: './people.csv',
      csvSource: 'CUSTOM',
      csvSeparator: ',',
    }));
  });

  it('defaults --csv-source to PEP and --csv-separator to ";" when omitted', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: {} });
    await runCli(['import', '--csv', './people.csv']);

    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ csvSource: 'PEP', csvSeparator: ';' }));
  });

  it('on success: exits 0 and prints the per-source counts as a table', async () => {
    runImport.mockResolvedValue({ success: true, importedCounts: { EU: 12, UN: 3 } });
    await runCli(['import']);

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toMatch(/slutfördes/i);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toEqual({ EU: 12, UN: 3 });
  });

  it('on failure (result.success: false): exits 1 and reports the error', async () => {
    runImport.mockResolvedValue({ success: false, importedCounts: {}, error: 'No records parsed' });
    await runCli(['import']);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/No records parsed/);
  });

  it('handles runImport throwing without an unhandled exception reaching the user', async () => {
    runImport.mockRejectedValue(new Error('network down'));

    await expect(runCli(['import'])).resolves.not.toThrow();

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/network down/);
  });
});
