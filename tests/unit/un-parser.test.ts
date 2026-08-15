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
    expect(eric!.primaryName).toBe('ERIC BADEGE');
    expect(eric!.citizenships).toEqual(['Democratic Republic of the Congo']);
    expect(eric!.addresses?.[0].country).toBe('Rwanda');
    expect(eric!.sanctionReason).toBe('He fled to Rwanda in March 2013.');
  });

  it('does not treat YEAR-only birth data as a full date, but still records the year', async () => {
    const records = await parseUNList(FIXTURE);
    const eric = records.find((r) => r.id === 'UN-6907993');
    expect(eric!.datesOfBirth).toEqual(['1971']);
  });

  it('KNOWN GAP: an empty <ALIAS_NAME/> element produces a real-looking empty string alias, not an omission', async () => {
    // Real UN data contains <INDIVIDUAL_ALIAS><ALIAS_NAME/></INDIVIDUAL_ALIAS>
    // blocks with no content — a "placeholder" alias slot. String(undefined
    // || '').trim() === '' so the `if (aliasName && ...)` guard correctly
    // excludes it — verifying that here since it's easy to regress.
    const records = await parseUNList(FIXTURE);
    const eric = records.find((r) => r.id === 'UN-6907993');
    expect(eric!.aliases).toEqual([]);
  });

  it('collects multiple real aliases into a single array', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.aliases).toEqual(['Alias One', 'Alias Two']);
  });

  it('builds the primary name from first/second/third/fourth name parts', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.primaryName).toBe('MULTI ALIAS PERSON');
  });

  it('formats each document with type, number and issuing country', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.passports).toEqual(['Passport P1234567 (Sweden)', 'National ID N9999']);
  });

  it('collects multiple nationality VALUE entries', async () => {
    const records = await parseUNList(FIXTURE);
    const multi = records.find((r) => r.id === 'UN-7000001');
    expect(multi!.citizenships).toEqual(['Sweden', 'Norway']);
  });

  it('skips an individual with no DATAID', async () => {
    const records = await parseUNList(FIXTURE);
    expect(records.find((r) => r.primaryName === 'No Data Id')).toBeUndefined();
  });

  it('parses an entity with a single FIRST_NAME field as its whole name', async () => {
    const records = await parseUNList(FIXTURE);
    const adf = records.find((r) => r.id === 'UN-6908402');

    expect(adf).toBeDefined();
    expect(adf!.type).toBe('entity');
    expect(adf!.primaryName).toBe('ADF');
    expect(adf!.addresses?.[0].fullAddress).toBe('Beni, Democratic Republic of the Congo');
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
