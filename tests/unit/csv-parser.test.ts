import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { parseCSVList } from '../../src/importer/parsers/csv';
import { logger } from '../../src/shared/logger';

let tmpDir: string;

/** Writes a CSV fixture to disk and returns its path. */
async function fixture(name: string, contents: string): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, contents, 'utf-8');
  return file;
}

const HEADER = 'id;name;aliases;type;source;datesOfBirth;citizenships;passports;fullAddress;reason';

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sanctions-csv-'));
});

afterAll(async () => {
  await fs.remove(tmpDir);
});

describe('parseCSVList — happy path', () => {
  it('maps a full PEP row onto a SanctionRecord', async () => {
    const file = await fixture(
      'pep.csv',
      `${HEADER}\n1;Lars Gunnar Karlsson;Gunnar Karlsson;individual;PEP;1965-04-12;Sweden;Passport 998877;Storgatan 12, Stockholm;Riksdagsledamot\n`,
    );

    const [record] = await parseCSVList(file, { separator: ';' });

    expect(record.id).toBe('PEP-1');
    expect(record.source).toBe('PEP');
    expect(record.type).toBe('individual');
    expect(record.names[0].wholeName).toBe('Lars Gunnar Karlsson');
    expect(record.names.slice(1).map((n) => n.wholeName)).toEqual(['Gunnar Karlsson']);
    expect(record.birthDates!.map((b) => b.raw)).toEqual(['1965-04-12']);
    expect(record.citizenships).toEqual(['Sweden']);
    expect(record.identifications).toEqual([{ number: 'Passport 998877' }]);
    expect(record.sanctionReason).toBe('Riksdagsledamot');
    expect(record.addresses?.[0].fullAddress).toBe('Storgatan 12, Stockholm');
  });

  it('leaves searchNames empty — tokens are the uploader\'s job', async () => {
    const file = await fixture(
      'tokens.csv',
      `${HEADER}\n1;Test Person;;individual;PEP;;;;;\n`,
    );
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.searchNames).toEqual([]);
  });

  it('splits pipe-separated multi-value fields', async () => {
    const file = await fixture(
      'multi.csv',
      `${HEADER}\n7;Multi Person;Alias One|Alias Two;individual;PEP;1970-01-01|1971-02-02;Sweden|Norway;P1|P2;;\n`,
    );
    const [record] = await parseCSVList(file, { separator: ';' });

    expect(record.names.slice(1).map((n) => n.wholeName)).toEqual(['Alias One', 'Alias Two']);
    expect(record.birthDates!.map((b) => b.raw)).toEqual(['1970-01-01', '1971-02-02']);
    expect(record.citizenships).toEqual(['Sweden', 'Norway']);
    expect(record.identifications).toEqual([{ number: 'P1' }, { number: 'P2' }]);
  });

  it('omits optional multi-value fields entirely when blank', async () => {
    const file = await fixture(
      'sparse.csv',
      `${HEADER}\n8;Sparse Person;;individual;PEP;;;;;\n`,
    );
    const [record] = await parseCSVList(file, { separator: ';' });

    // undefined rather than [] — Firestore is configured with
    // ignoreUndefinedProperties, so these keys are simply not written.
    expect(record.birthDates).toBeUndefined();
    expect(record.citizenships).toBeUndefined();
    expect(record.identifications).toBeUndefined();
    expect(record.addresses).toBeUndefined();
  });

  it('returns an empty list for a header-only file', async () => {
    const file = await fixture('empty.csv', `${HEADER}\n`);
    expect(await parseCSVList(file, { separator: ';' })).toEqual([]);
  });

  it('returns an empty list for a completely empty file', async () => {
    const file = await fixture('blank.csv', '');
    expect(await parseCSVList(file, { separator: ';' })).toEqual([]);
  });

  it('ignores blank lines between records', async () => {
    const file = await fixture(
      'gaps.csv',
      `${HEADER}\n\n1;A Person;;individual;PEP;;;;;\n\n2;B Person;;individual;PEP;;;;;\n`,
    );
    expect(await parseCSVList(file, { separator: ';' })).toHaveLength(2);
  });
});

describe('parseCSVList — header aliasing', () => {
  it('accepts alternative column names for the primary name', async () => {
    const file = await fixture('altname.csv', 'id;wholeName;source\n1;Alt Named;PEP\n');
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.names[0].wholeName).toBe('Alt Named');
  });

  it('is case-insensitive about header spelling', async () => {
    const file = await fixture('caps.csv', 'ID;NAME;SOURCE\n1;Shouty Header;PEP\n');
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.names[0].wholeName).toBe('Shouty Header');
  });

  it('builds fullAddress from street/city/country when not given directly', async () => {
    const file = await fixture(
      'addr.csv',
      'id;name;source;street;city;country\n1;Addressed;PEP;Storgatan 12;Stockholm;Sweden\n',
    );
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.addresses?.[0].fullAddress).toBe('Storgatan 12, Stockholm, Sweden');
    expect(record.addresses?.[0].city).toBe('Stockholm');
  });
});

describe('parseCSVList — type mapping', () => {
  it.each([
    ['individual', 'individual'],
    ['entity', 'entity'],
    ['organisation', 'entity'],
    ['bolag', 'entity'],
    ['vessel', 'vessel'],
    ['aircraft', 'aircraft'],
    ['', 'individual'],
    ['something unrecognised', 'individual'],
  ])('maps type %o to %o', async (input, expected) => {
    const file = await fixture(
      `type-${input.replace(/\W/g, '_') || 'blank'}.csv`,
      `id;name;type;source\n1;Typed Person;${input};PEP\n`,
    );
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.type).toBe(expected);
  });
});

describe('parseCSVList — defaults and fallbacks', () => {
  it('falls back to the defaultSource option when the row has no source', async () => {
    const file = await fixture('nosource.csv', 'id;name\n1;No Source\n');
    const [record] = await parseCSVList(file, { separator: ';', defaultSource: 'CUSTOM' });
    expect(record.source).toBe('CUSTOM');
    expect(record.id).toBe('CUSTOM-1');
  });

  it('defaults to PEP when neither the row nor the options specify a source', async () => {
    const file = await fixture('defaultsource.csv', 'id;name\n1;Default Source\n');
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.source).toBe('PEP');
  });

  it('defaults to the semicolon separator when none is given', async () => {
    const file = await fixture('defaultsep.csv', 'id;name\n1;Semicolon Default\n');
    const [record] = await parseCSVList(file);
    expect(record.names[0].wholeName).toBe('Semicolon Default');
  });

  it('synthesises a row-based id when the id column is missing', async () => {
    const file = await fixture('noid.csv', 'name;source\nNo Id Person;PEP\n');
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.id).toBe('PEP-row-1');
  });

  it('skips a row with no name at all', async () => {
    const file = await fixture(
      'noname.csv',
      `${HEADER}\n1;;;individual;PEP;;;;;\n2;Has Name;;individual;PEP;;;;;\n`,
    );
    const records = await parseCSVList(file, { separator: ';' });
    expect(records).toHaveLength(1);
    expect(records[0].names[0].wholeName).toBe('Has Name');
  });
});

describe('parseCSVList — malformed input', () => {
  // --- Characterisation of a real data-loss risk. ---
  // A row with fewer fields than the header is dropped without any warning,
  // error, or counter. A truncated source file therefore imports "successfully"
  // with records silently missing.
  it('KNOWN GAP: silently drops a row that has fewer columns than the header', async () => {
    const file = await fixture(
      'short.csv',
      `${HEADER}\n1;Truncated Row;individual\n2;Complete Row;;individual;PEP;;;;;\n`,
    );
    const records = await parseCSVList(file, { separator: ';' });

    expect(records).toHaveLength(1);
    expect(records[0].names[0].wholeName).toBe('Complete Row');
  });

  it('accepts a row with more columns than the header, ignoring the extras', async () => {
    const file = await fixture(
      'long.csv',
      'id;name;source\n1;Extra Columns;PEP;ignored;also-ignored\n',
    );
    const records = await parseCSVList(file, { separator: ';' });
    expect(records).toHaveLength(1);
    expect(records[0].names[0].wholeName).toBe('Extra Columns');
  });

  it('rejects a missing file by rejecting the promise', async () => {
    await expect(
      parseCSVList(path.join(tmpDir, 'does-not-exist.csv'), { separator: ';' }),
    ).rejects.toThrow();
  });
});

describe('parseCSVList — ID and source validation (issue #167)', () => {
  it('rejects a row whose source disagrees with the invoked defaultSource, preventing cross-source overwrite', async () => {
    const file = await fixture(
      'cross-source.csv',
      'id;name;source\n13;Genuine EU Impersonator;EU\n14;Valid PEP;PEP\n',
    );
    const records = await parseCSVList(file, { separator: ';', defaultSource: 'PEP' });

    // EU row must be rejected/skipped; PEP row must be imported as PEP-14
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('PEP-14');
    expect(records[0].source).toBe('PEP');
    expect(records.find((r) => r.id.startsWith('EU-'))).toBeUndefined();
  });

  it('rejects rows with invalid or arbitrary source strings', async () => {
    const file = await fixture(
      'badsource.csv',
      'id;name;source\n1;Bad Source;NOT_A_REAL_SOURCE\n',
    );
    const records = await parseCSVList(file, { separator: ';', defaultSource: 'PEP' });
    expect(records).toHaveLength(0);
  });

  it('rejects path-injected IDs (e.g. a/b/c, ../x)', async () => {
    const file = await fixture(
      'pathinject.csv',
      'id;name;source\na/b/c;Path Injection;PEP\n../x;DotDot Injection;PEP\nvalid-1;Valid Record;PEP\n',
    );
    const records = await parseCSVList(file, { separator: ';', defaultSource: 'PEP' });

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('PEP-valid-1');
  });

  it('rejects empty IDs when id column is present in the file', async () => {
    const file = await fixture(
      'emptyid.csv',
      'id;name;source\n;Empty ID;PEP\nvalid-2;Valid Record;PEP\n',
    );
    const records = await parseCSVList(file, { separator: ';', defaultSource: 'PEP' });

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('PEP-valid-2');
  });

  it('rejects Firestore-reserved IDs like __proto__', async () => {
    const file = await fixture(
      'reservedid.csv',
      'id;name;source\n__proto__;Proto ID;PEP\nvalid-3;Valid Record;PEP\n',
    );
    const records = await parseCSVList(file, { separator: ';', defaultSource: 'PEP' });

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('PEP-valid-3');
  });

  it('aggregates parsed record count vs skipped/rejected count in complete log (CLAUDE.md §1)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const file = await fixture(
      'mixed.csv',
      'id;name;source\n' +
      '1;Valid One;PEP\n' +
      'a/b/c;Invalid ID;PEP\n' +
      ';Missing ID;PEP\n' +
      '2;Valid Two;PEP\n' +
      '3;Wrong Source;EU\n',
    );
    const records = await parseCSVList(file, { separator: ';', defaultSource: 'PEP' });

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.id)).toEqual(['PEP-1', 'PEP-2']);

    const warnCalls = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const logCalls = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string));

    expect(warnCalls).toContainEqual(
      expect.objectContaining({
        message: 'parse.row_skipped_invalid_id',
        rawId: 'a/b/c',
      }),
    );
    expect(warnCalls).toContainEqual(
      expect.objectContaining({
        message: 'parse.row_skipped_invalid_id',
        rawId: '',
      }),
    );
    expect(warnCalls).toContainEqual(
      expect.objectContaining({
        message: 'parse.row_skipped_source_mismatch',
        rowSource: 'EU',
        expectedSource: 'PEP',
      }),
    );

    expect(logCalls).toContainEqual(
      expect.objectContaining({
        message: 'parse.complete',
        recordCount: 2,
        skippedCount: 3,
        skipReasons: {
          invalidId: 2,
          sourceMismatch: 1,
        },
      }),
    );

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('parseCSVList — UTF-8 BOM handling (issue #298)', () => {
  const BOM = '\uFEFF';

  it('correctly maps the first column when it is "id" and file starts with a UTF-8 BOM', async () => {
    const file = await fixture(
      'bom-id-first.csv',
      `${BOM}id;name;type;source\n101;Test Person;individual;PEP\n102;Entity Ltd;entity;PEP\n`,
    );

    const records = await parseCSVList(file, { separator: ';' });

    expect(records).toHaveLength(2);
    // Crucial: Must parse genuine id "PEP-101", not fallback synthetic "PEP-row-1"
    expect(records[0].id).toBe('PEP-101');
    expect(records[0].names[0].wholeName).toBe('Test Person');
    expect(records[0].type).toBe('individual');

    expect(records[1].id).toBe('PEP-102');
    expect(records[1].names[0].wholeName).toBe('Entity Ltd');
    expect(records[1].type).toBe('entity');
  });

  it('correctly maps the first column when it is "name" and file starts with a UTF-8 BOM', async () => {
    const file = await fixture(
      'bom-name-first.csv',
      `${BOM}name;type;source\nAnna Svensson;individual;PEP\nNordic Holdings;entity;PEP\n`,
    );

    const records = await parseCSVList(file, { separator: ';' });

    expect(records).toHaveLength(2);
    // When name is first column, it must NOT be skipped as missing name
    expect(records[0].names[0].wholeName).toBe('Anna Svensson');
    expect(records[0].type).toBe('individual');
    expect(records[1].names[0].wholeName).toBe('Nordic Holdings');
    expect(records[1].type).toBe('entity');
  });

  it('parses identically with and without a UTF-8 BOM across all fields and aggregate counts', async () => {
    const csvContent =
      'id;name;aliases;type;source;datesOfBirth;citizenships;passports;fullAddress;reason\n' +
      '1;Person One;Alias A|Alias B;individual;PEP;1980-01-01;Sweden;P123;Street 1;MP\n' +
      '2;Company Two;;entity;PEP;;;;Street 2;State owned\n' +
      '3;Person Three;;individual;PEP;1990-05-05;Norway;P456;Street 3;Diplomat\n';

    const fileWithoutBom = await fixture('no-bom.csv', csvContent);
    const fileWithBom = await fixture('with-bom.csv', `${BOM}${csvContent}`);

    const recordsWithoutBom = await parseCSVList(fileWithoutBom, { separator: ';' });
    const recordsWithBom = await parseCSVList(fileWithBom, { separator: ';' });

    const stripTimestamps = (records: any[]) => records.map(({ createdAt, updatedAt, ...rest }) => rest);
    expect(recordsWithBom).toHaveLength(3);
    expect(stripTimestamps(recordsWithBom)).toEqual(stripTimestamps(recordsWithoutBom));

    const typeSplitWithBom = {
      individual: recordsWithBom.filter((r) => r.type === 'individual').length,
      entity: recordsWithBom.filter((r) => r.type === 'entity').length,
    };
    expect(typeSplitWithBom).toEqual({ individual: 2, entity: 1 });
  });
});

