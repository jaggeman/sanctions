import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import type { SanctionRecord } from '../../src/shared/types';

let allRecords: SanctionRecord[] = [];
let stdoutData = '';
let logs: string[] = [];
let errors: string[] = [];
let exitCode: number | undefined;

const fakeDb = {
  collection: vi.fn((name: string) => {
    if (name === 'sanctions') {
      return {
        get: vi.fn(async () => ({
          docs: allRecords.map((r) => ({ id: r.id, data: () => r })),
        })),
      };
    }
    throw new Error(`Unexpected collection ${name}`);
  }),
};

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn() }));
vi.mock('../../src/search', () => ({ runSearch: vi.fn() }));

beforeEach(() => {
  allRecords = [];
  stdoutData = '';
  logs = [];
  errors = [];
  exitCode = undefined;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: any[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdoutData += String(chunk);
    return true;
  }) as any);
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
  const { program } = await import('../../src/cli');
  await program.parseAsync(['node', 'sanctions', ...argv]);
}

describe('CLI: export', () => {
  const record1: SanctionRecord = {
    id: 'EU-1',
    source: 'EU',
    type: 'individual',
    names: [{ wholeName: 'Vladimir Putin', strong: true }],
    searchNames: [],
    status: 'active',
    firstSeenImport: 'imp-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const record2: SanctionRecord = {
    id: 'US-2',
    source: 'US',
    type: 'entity',
    names: [{ wholeName: 'Gazprom Bank', strong: true }],
    searchNames: [],
    status: 'delisted',
    firstSeenImport: 'imp-2',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    allRecords = [record1, record2];
  });

  it('exports active records to stdout by default', async () => {
    await runCli(['export']);
    expect(exitCode).toBe(0);
    expect(stdoutData).toContain('EU-1');
    expect(stdoutData).toContain('Vladimir Putin');
    expect(stdoutData).not.toContain('US-2');
  });

  it('filters by source and status=all', async () => {
    await runCli(['export', '--sources', 'US', '--status', 'all']);
    expect(exitCode).toBe(0);
    expect(stdoutData).toContain('US-2');
    expect(stdoutData).toContain('Gazprom Bank');
    expect(stdoutData).not.toContain('EU-1');
  });

  it('writes to output file when --output is specified', async () => {
    const tmpFile = path.join(os.tmpdir(), `test-export-${Date.now()}.csv`);
    try {
      await runCli(['export', '--output', tmpFile]);
      expect(exitCode).toBe(0);
      expect(await fs.pathExists(tmpFile)).toBe(true);
      const content = await fs.readFile(tmpFile, 'utf-8');
      expect(content).toContain('EU-1');
      expect(content).toContain('Vladimir Putin');
    } finally {
      await fs.remove(tmpFile);
    }
  });
});
