import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `stats` runs 5 sequential db.collection('sanctions')[.where(...)].count().get()
 * calls (total, then EU/UN/US/PEP). This fake tracks which `where` filter (if
 * any) each chain used, and returns a canned count per source from a map.
 */
let countsBySource: Record<string, number> = {};
let totalCount = 0;
let shouldThrow: Error | null = null;

function makeCountable(sourceFilter: string | null) {
  return {
    count: vi.fn(() => ({
      get: vi.fn(async () => {
        if (shouldThrow) throw shouldThrow;
        const count = sourceFilter === null ? totalCount : (countsBySource[sourceFilter] || 0);
        return { data: () => ({ count }) };
      }),
    })),
  };
}

const fakeDb = {
  collection: vi.fn(() => ({
    ...makeCountable(null),
    where: vi.fn((_field: string, _op: string, value: string) => makeCountable(value)),
  })),
};

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
  countsBySource = {};
  totalCount = 0;
  shouldThrow = null;
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

describe('CLI stats command', () => {
  it('queries the sanctions collection for the total and each of EU/UN/US/PEP', async () => {
    totalCount = 100;
    countsBySource = { EU: 40, UN: 30, US: 20, PEP: 10 };

    await runCli(['stats']);

    expect(fakeDb.collection).toHaveBeenCalledWith('sanctions');
    expect(exitCode).toBe(0);
  });

  it('prints the total and per-source counts', async () => {
    totalCount = 100;
    countsBySource = { EU: 40, UN: 30, US: 20, PEP: 10 };

    await runCli(['stats']);

    const output = logs.join('\n');
    expect(output).toContain('100');
    expect(output).toContain('40');
    expect(output).toContain('30');
    expect(output).toContain('20');
    expect(output).toContain('10');
  });

  it('handles a Firestore error without an unhandled exception reaching the user', async () => {
    shouldThrow = new Error('emulator unreachable');

    await expect(runCli(['stats'])).resolves.not.toThrow();

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/emulator unreachable/);
  });

  it('reports zero counts cleanly rather than erroring on an empty database', async () => {
    totalCount = 0;
    countsBySource = { EU: 0, UN: 0, US: 0, PEP: 0 };

    await runCli(['stats']);

    expect(exitCode).toBe(0);
    expect(errors).toHaveLength(0);
  });
});
