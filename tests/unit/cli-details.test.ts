import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let docGetResult: { exists: boolean; data?: () => any } = { exists: false };
const docMock = vi.fn(() => ({ get: vi.fn(async () => docGetResult) }));
const fakeDb = { collection: vi.fn(() => ({ doc: docMock })) };

vi.mock('../../src/shared/firebase', () => ({ db: fakeDb }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn() }));
vi.mock('../../src/search', () => ({ runSearch: vi.fn() }));

let logs: string[] = [];
let errors: string[] = [];
let exitCode: number | undefined;

beforeEach(() => {
  logs = [];
  errors = [];
  exitCode = undefined;
  docGetResult = { exists: false };
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: any[]) => { errors.push(args.map(String).join(' ')); });
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

describe('CLI details command', () => {
  it('prints the full record as JSON and exits 0 when the id is found', async () => {
    const record = { id: 'PEP-1', primaryName: 'Test Person', source: 'PEP' };
    docGetResult = { exists: true, data: () => record };

    await runCli(['details', 'PEP-1']);

    expect(fakeDb.collection).toHaveBeenCalledWith('sanctions');
    expect(docMock).toHaveBeenCalledWith('PEP-1');
    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('"id": "PEP-1"');
    expect(logs.join('\n')).toContain('Test Person');
  });

  it('reports a not-found id with exit 1, and does not print anything after the error', async () => {
    docGetResult = { exists: false };

    await runCli(['details', 'DOES-NOT-EXIST']);

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/DOES-NOT-EXIST/);
    // The real bug this test guards: without a `return` after process.exit(1),
    // execution fell through to `JSON.stringify(doc.data(), null, 2)` with
    // doc.data() undefined, logging the literal string "undefined" to a user
    // who was just told the record wasn't found.
    expect(logs.join('\n')).not.toContain('FULLSTÄNDIGA DETALJER');
    expect(logs.join('\n')).not.toMatch(/undefined/);
  });

  it('handles a Firestore error without an unhandled exception reaching the user', async () => {
    docMock.mockReturnValueOnce({ get: vi.fn(async () => { throw new Error('emulator unreachable'); }) });

    await expect(runCli(['details', 'PEP-1'])).resolves.not.toThrow();

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/emulator unreachable/);
  });
});
