import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { parseCSVList } from '../../src/importer/parsers/csv';

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
    expect(record.primaryName).toBe('Lars Gunnar Karlsson');
    expect(record.aliases).toEqual(['Gunnar Karlsson']);
    expect(record.datesOfBirth).toEqual(['1965-04-12']);
    expect(record.citizenships).toEqual(['Sweden']);
    expect(record.passports).toEqual(['Passport 998877']);
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

    expect(record.aliases).toEqual(['Alias One', 'Alias Two']);
    expect(record.datesOfBirth).toEqual(['1970-01-01', '1971-02-02']);
    expect(record.citizenships).toEqual(['Sweden', 'Norway']);
    expect(record.passports).toEqual(['P1', 'P2']);
  });

  it('omits optional multi-value fields entirely when blank', async () => {
    const file = await fixture(
      'sparse.csv',
      `${HEADER}\n8;Sparse Person;;individual;PEP;;;;;\n`,
    );
    const [record] = await parseCSVList(file, { separator: ';' });

    // undefined rather than [] — Firestore is configured with
    // ignoreUndefinedProperties, so these keys are simply not written.
    expect(record.datesOfBirth).toBeUndefined();
    expect(record.citizenships).toBeUndefined();
    expect(record.passports).toBeUndefined();
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
    expect(record.primaryName).toBe('Alt Named');
  });

  it('is case-insensitive about header spelling', async () => {
    const file = await fixture('caps.csv', 'ID;NAME;SOURCE\n1;Shouty Header;PEP\n');
    const [record] = await parseCSVList(file, { separator: ';' });
    expect(record.primaryName).toBe('Shouty Header');
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
    expect(record.primaryName).toBe('Semicolon Default');
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
    expect(records[0].primaryName).toBe('Has Name');
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
    expect(records[0].primaryName).toBe('Complete Row');
  });

  it('accepts a row with more columns than the header, ignoring the extras', async () => {
    const file = await fixture(
      'long.csv',
      'id;name;source\n1;Extra Columns;PEP;ignored;also-ignored\n',
    );
    const records = await parseCSVList(file, { separator: ';' });
    expect(records).toHaveLength(1);
    expect(records[0].primaryName).toBe('Extra Columns');
  });

  it('rejects a missing file by rejecting the promise', async () => {
    await expect(
      parseCSVList(path.join(tmpDir, 'does-not-exist.csv'), { separator: ';' }),
    ).rejects.toThrow();
  });
});

describe('parseCSVList — untrusted input reaches the document id', () => {
  // --- Characterisation of a real security finding (CLAUDE.md §6). ---
  // `source` is read straight off the CSV with a bare `as SanctionSource` cast
  // and no allow-list check, then interpolated into the record id, which the
  // uploader passes directly to collectionRef.doc(). Nothing validates it.

  it('KNOWN GAP: an arbitrary source string is accepted unvalidated', async () => {
    const file = await fixture('badsource.csv', 'id;name;source\n1;Bad Source;NOT_A_REAL_SOURCE\n');
    const [record] = await parseCSVList(file, { separator: ';' });

    // Should be rejected or coerced to the default; today it is taken verbatim.
    expect(record.source).toBe('NOT_A_REAL_SOURCE');
    expect(record.id).toBe('NOT_A_REAL_SOURCE-1');
  });

  it('KNOWN GAP: a slash in the id column becomes a Firestore path separator', async () => {
    const file = await fixture('pathinject.csv', 'id;name;source\na/b/c;Path Injection;PEP\n');
    const [record] = await parseCSVList(file, { separator: ';' });

    // "PEP-a/b/c" addresses a nested document, not a document literally named
    // "PEP-a/b/c" — a malicious or malformed CSV can write outside the intended
    // collection shape.
    expect(record.id).toBe('PEP-a/b/c');
    expect(record.id.split('/').length).toBeGreaterThan(1);
  });
});
