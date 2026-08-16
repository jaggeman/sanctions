import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseUNList } from '../../src/importer/parsers/un';

const FIXTURE = path.join(__dirname, '../fixtures/un_sample.xml');

describe('parseUNList', () => {
  it('parses an individual with a single, real alias', async () => {
    const records = await parseUNList(FIXTURE);
    const eric = records.find((r) => r.id === 'UN-6907993');

    expect(eric).toBeDefined();
    expect(eric!.source).toBe('UN');
    expect(eric!.type).toBe('individual');
    expect(eric!.names[0].wholeName).toBe('ERIC BADEGE');
    expect(eric!.citizenships).toEqual(['Democratic Republic of the Congo']);
    expect(eric!.addresses?.[0].country).toBe('Rwanda');
    expect(eric!.sanctionReason).toBe('He fled to Rwanda in March 2013.');
  });

  it('does not treat YEAR-only birth data as a full date, but still records the year', async () => {
    const records = await parseUNList(FIXTURE);
    const eric = records.find((r) => r.id === 'UN-6907993');
    expect(eric!.birthDates!.map((b) => b.raw)).toEqual(['1971']);
  });

  it('KNOWN GAP: an empty <ALIAS_NAME/> element produces a real-looking empty string alias, not an omission', async () => {
    // Real UN data contains <INDIVIDUAL_ALIAS><ALIAS_NAME/></INDIVIDUAL_ALIAS>
    // blocks with no content — a "placeholder" alias slot. String(undefined
    // || '').trim() === '' so the `if (aliasName && ...)` guard correctly
    // excludes it — verifying that here since it's easy to regress.
    const records = await parseUNList(FIXTURE);
    const eric = records.find((r) => r.id === 'UN-6907993');
    expect(eric!.names.slice(1)).toEqual([]);
  });

  it('collects multiple real aliases into a single array', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.names.slice(1).map((n) => n.wholeName)).toEqual(['Alias One', 'Alias Two']);
  });

  it('builds the primary name from first/second/third/fourth name parts', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.names[0].wholeName).toBe('MULTI ALIAS PERSON');
  });

  it('formats each document with type, number and issuing country', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.identifications).toEqual([
      { number: 'P1234567', typeDescription: 'Passport', countryIso2: 'Sweden' },
      { number: 'N9999', typeDescription: 'National ID', countryIso2: undefined },
    ]);
  });

  it('collects multiple nationality VALUE entries', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.citizenships).toEqual(['Sweden', 'Norway']);
  });

  it('skips an individual with no DATAID', async () => {
    const records = await parseUNList(FIXTURE);
    expect(records.find((r) => r.names[0].wholeName === 'No Data Id')).toBeUndefined();
  });

  it('parses an entity with a single FIRST_NAME field as its whole name', async () => {
    const records = await parseUNList(FIXTURE);
    const adf = records.find((r) => r.id === 'UN-6908402');

    expect(adf).toBeDefined();
    expect(adf!.type).toBe('entity');
    expect(adf!.names[0].wholeName).toBe('ADF');
    expect(adf!.addresses?.[0].fullAddress).toBe('Beni, Democratic Republic of the Congo');
  });

  it('issue #34: preserves a leading-zero document number instead of silently truncating it as a number', async () => {
    // Real record (DATAID 110425) carved from the actual UN Consolidated
    // List export — its National Identification Number is "0035011785".
    // fast-xml-parser's default parseTagValue would coerce this all-digit
    // element text to the number 35011785, losing both leading zeros.
    const records = await parseUNList(FIXTURE);
    const naser = records.find((r) => r.id === 'UN-110425');

    expect(naser).toBeDefined();
    expect(naser!.identifications).toContainEqual({
      number: '0035011785',
      typeDescription: 'National Identification Number',
      countryIso2: 'Iran (Islamic Republic of)',
    });
    // The other document on the same record isn't all-digit, so it was never
    // at risk — asserting it anyway to pin the full expected shape.
    expect(naser!.identifications).toContainEqual({
      number: 'A0003039',
      typeDescription: 'Passport',
      countryIso2: 'Iran (Islamic Republic of)',
    });
  });

  it('reads the issuing country from COUNTRY_OF_ISSUE, not just ISSUING_COUNTRY', async () => {
    // Found while adding the fixture above: the real Consolidated List
    // export uses ISSUING_COUNTRY on ~293 INDIVIDUAL_DOCUMENT entries and
    // COUNTRY_OF_ISSUE on ~102 others. Both documents on DATAID 110425 use
    // COUNTRY_OF_ISSUE — this pins that the country isn't silently dropped.
    const records = await parseUNList(FIXTURE);
    const naser = records.find((r) => r.id === 'UN-110425');
    expect(naser!.identifications?.every((id) => id.countryIso2 === 'Iran (Islamic Republic of)')).toBe(true);
  });

  it('returns an empty list when CONSOLIDATED_LIST is absent', async () => {
    // Reuse the fixture dir but point at a file with a different root element.
    const emptyXml = '<?xml version="1.0"?><NotTheRightRoot/>';
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `un-empty-${Date.now()}.xml`);
    await (fs as any).writeFile(tmp, emptyXml, 'utf-8');
    try {
      const records = await parseUNList(tmp);
      expect(records).toEqual([]);
    } finally {
      await (fs as any).remove(tmp);
    }
  });
});
