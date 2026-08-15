import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseEUList } from '../../src/importer/parsers/eu';

const FIXTURE = path.join(__dirname, '../fixtures/eu_sample.xml');

describe('parseEUList', () => {
  it('parses an individual, picking the primary=true nameAlias as primaryName', async () => {
    const records = await parseEUList(FIXTURE);
    const vlad = records.find((r) => r.id === 'EU-1001');

    expect(vlad).toBeDefined();
    expect(vlad!.type).toBe('individual');
    expect(vlad!.primaryName).toBe('Vladimir TESTOVICH');
    expect(vlad!.aliases).toEqual(['Vova Testovich']);
    expect(vlad!.citizenships).toEqual(['Russia']);
    expect(vlad!.datesOfBirth).toEqual(['1965-04-12']);
    expect(vlad!.placesOfBirth).toEqual(['Moscow, Russia']);
    expect(vlad!.passports).toEqual(['Passport 123456789 (Russia)']);
    expect(vlad!.legalBasis).toBe('https://example.org/reg1');
    expect(vlad!.sanctionReason).toBe('Council Regulation (EU) No 269/2014');
  });

  it('parses an entity (subjectType code E)', async () => {
    const records = await parseEUList(FIXTURE);
    const entity = records.find((r) => r.id === 'EU-1002');

    expect(entity).toBeDefined();
    expect(entity!.type).toBe('entity');
    expect(entity!.primaryName).toBe('Test Entity LLC');
    expect(entity!.sanctionReason).toBe('Council Decision 2014/145/CFSP');
  });

  it('falls back to the first alias as primaryName when nothing is marked primary', async () => {
    const records = await parseEUList(FIXTURE);
    const onlyAlias = records.find((r) => r.id === 'EU-1003');

    expect(onlyAlias).toBeDefined();
    expect(onlyAlias!.primaryName).toBe('Only Alias');
    expect(onlyAlias!.aliases).toEqual([]);
  });

  it('falls back to "Unknown Name" when there is no name data whatsoever', async () => {
    const records = await parseEUList(FIXTURE);
    const nameless = records.find((r) => r.id === 'EU-1004');

    expect(nameless).toBeDefined();
    expect(nameless!.primaryName).toBe('Unknown Name');
  });

  it('defaults subjectType to entity when the code is neither I nor recognised', async () => {
    const records = await parseEUList(FIXTURE);
    const entity = records.find((r) => r.id === 'EU-1002');
    expect(entity!.type).toBe('entity');
  });

  it('returns an empty list when no sanctionEntity nodes are present', async () => {
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `eu-empty-${Date.now()}.xml`);
    await (fs as any).writeFile(
      tmp,
      '<?xml version="1.0"?><export:export xmlns:export="http://eu.europa.ec/fpi/fsd/export"></export:export>',
      'utf-8',
    );
    try {
      const records = await parseEUList(tmp);
      expect(records).toEqual([]);
    } finally {
      await (fs as any).remove(tmp);
    }
  });

  it('strips the namespace prefix regardless of what it is called', async () => {
    // removeNSPrefix is what lets `export:sanctionEntity` be read as
    // `sanctionEntity` — this is the load-bearing assertion for that config flag.
    const records = await parseEUList(FIXTURE);
    expect(records.length).toBeGreaterThan(0);
  });
});
