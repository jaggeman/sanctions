import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

const runFetchTriggeredImport = vi.fn();
const processUpload = vi.fn();
vi.mock('../../src/importer/uploadPipeline', () => ({ processUpload, runFetchTriggeredImport }));
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
  it('defaults to all four sources when --sources is omitted', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: {} });
    await runCli(['import']);

    expect(runFetchTriggeredImport).toHaveBeenCalledWith(expect.objectContaining({
      sources: ['EU', 'UN', 'US', 'UK'],
      uploadedBy: 'cli',
    }));
  });

  it('parses a comma-separated --sources list, uppercased and trimmed', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: {} });
    await runCli(['import', '--sources', ' eu, un ']);

    expect(runFetchTriggeredImport).toHaveBeenCalledWith(expect.objectContaining({ sources: ['EU', 'UN'] }));
  });

  it('on success: exits 0 and prints the per-source counts as a table', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: { EU: 12, UN: 3 } });
    await runCli(['import']);

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toMatch(/slutfördes/i);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toEqual({ EU: 12, UN: 3 });
  });

  it('on failure (result.success: false): exits 1 and reports the error', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: false, importedCounts: {}, error: 'No records parsed' });
    await runCli(['import']);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/No records parsed/);
  });

  it('handles runImport throwing without an unhandled exception reaching the user', async () => {
    runFetchTriggeredImport.mockRejectedValue(new Error('network down'));

    await expect(runCli(['import'])).resolves.not.toThrow();

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/network down/);
  });
});

// issue #192: --csv is a genuine local file, exactly what processUpload()
// wants — routing it there instead of bundling csvPath into the runImport()
// call gives a script/CLI-triggered custom import the same sha256 dedup,
// in-flight lock, and durable `imports` audit record that POST /api/upload
// already has, instead of none of it.
describe('CLI import command — --csv routes through processUpload (issue #192)', () => {
  it('given only --csv (no --sources), calls processUpload and never calls runImport', async () => {
    processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 5, uploaded: 5 } });
    await runCli(['import', '--csv', './people.csv', '--csv-source', 'CUSTOM', '--csv-separator', ',']);

    expect(processUpload).toHaveBeenCalledWith({
      filePath: './people.csv',
      originalFilename: 'people.csv',
      sourceHint: 'CUSTOM',
      uploadedBy: 'cli',
      importOptions: { csvSeparator: ',' },
    });
    expect(runFetchTriggeredImport).not.toHaveBeenCalled();
  });

  it('defaults --csv-source to PEP and --csv-separator to ";" when omitted', async () => {
    processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 1, uploaded: 1 } });
    await runCli(['import', '--csv', './people.csv']);

    expect(processUpload).toHaveBeenCalledWith(expect.objectContaining({
      sourceHint: 'PEP',
      importOptions: { csvSeparator: ';' },
    }));
  });

  it('given both --sources and --csv, calls runImport for the sources and processUpload for the csv file', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: true, importedCounts: { EU: 4 } });
    processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 2, uploaded: 2 } });

    await runCli(['import', '--sources', 'EU', '--csv', './people.csv']);

    expect(runFetchTriggeredImport).toHaveBeenCalledWith(expect.objectContaining({ sources: ['EU'] }));
    expect(processUpload).toHaveBeenCalledWith(expect.objectContaining({ filePath: './people.csv' }));
  });

  it('on outcome "applied": exits 0 and reports the import id', async () => {
    processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 5, uploaded: 5 } });
    await runCli(['import', '--csv', './people.csv']);

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('imp_1');
  });

  it('on outcome "rejected" (duplicate): still exits 0, reports which import it duplicates', async () => {
    processUpload.mockResolvedValue({ outcome: 'rejected', importId: 'imp_2', duplicateOfImportId: 'imp_1' });
    await runCli(['import', '--csv', './people.csv']);

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('imp_1');
  });

  it('on outcome "failed": exits 1 and reports the error', async () => {
    processUpload.mockResolvedValue({ outcome: 'failed', importId: 'imp_3', error: 'boom' });
    await runCli(['import', '--csv', './people.csv']);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('boom');
  });

  it('on outcome "unsupported_format": exits 1 and reports the format', async () => {
    processUpload.mockResolvedValue({ outcome: 'unsupported_format', importId: 'imp_4', format: 'eu-csv-1.0' });
    await runCli(['import', '--csv', './people.csv']);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('eu-csv-1.0');
  });

  it('when both sources and csv run: a sources failure exits 1 even if the csv upload applied cleanly', async () => {
    runFetchTriggeredImport.mockResolvedValue({ success: false, importedCounts: {}, error: 'download failed' });
    processUpload.mockResolvedValue({ outcome: 'applied', importId: 'imp_1', counts: { parsed: 1, uploaded: 1 } });

    await runCli(['import', '--sources', 'EU', '--csv', './people.csv']);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('download failed');
  });
});

describe('CLI import-dir command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cli-import-dir-${Date.now()}`);
    await fs.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('exits 1 if directory does not exist', async () => {
    await runCli(['import-dir', path.join(tmpDir, 'nonexistent')]);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/hittades inte/i);
  });

  it('exits 0 with notice if directory contains no .xml or .csv files', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.txt'), 'hello');
    await runCli(['import-dir', tmpDir]);

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toMatch(/Inga \.xml eller \.csv-filer hittades/i);
  });

  it('iterates over files and calls processUpload for each XML and CSV file', async () => {
    await fs.writeFile(path.join(tmpDir, 'eu.xml'), '<export/>');
    await fs.writeFile(path.join(tmpDir, 'un.xml'), '<CONSOLIDATED_LIST/>');

    processUpload
      .mockResolvedValueOnce({ outcome: 'applied', importId: 'imp_1' })
      .mockResolvedValueOnce({ outcome: 'rejected', duplicateOfImportId: 'imp_0' });

    await runCli(['import-dir', tmpDir]);

    expect(exitCode).toBe(0);
    expect(processUpload).toHaveBeenCalledTimes(2);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toEqual([
      { file: 'eu.xml', outcome: 'Applied', details: 'Import #imp_1' },
      { file: 'un.xml', outcome: 'Skipped (Duplicate)', details: 'Matches #imp_0' },
    ]);
  });
});
