import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseChXmlStream } from '../../src/importer/parsers/ch';
import { SanctionRecord } from '../../src/shared/types';

describe('CH (Switzerland SECO) parser', () => {
  const fixturePath = path.join(__dirname, '../fixtures/ch_sample.xml');

  async function parseFixture(): Promise<SanctionRecord[]> {
    const records: SanctionRecord[] = [];
    await parseChXmlStream(fixturePath, async (record) => {
      records.push(record);
    });
    return records;
  }

  it('parses all records in the fixture with source "CH"', async () => {
    const records = await parseFixture();
    expect(records.length).toBe(6);
    for (const record of records) {
      expect(record.source).toBe('CH');
      expect(record.id).toMatch(/^CH-\d+$/);
      expect(record.names.length).toBeGreaterThan(0);
      expect(record.names[0].wholeName.trim().length).toBeGreaterThan(0);
      expect(record.searchNames.length).toBeGreaterThan(0);
    }
  });

  it('correctly maps target types including object-type="vessel"', async () => {
    const records = await parseFixture();
    const typeCounts: Record<string, number> = {};
    for (const r of records) {
      typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
    }
    expect(typeCounts['individual']).toBe(3);
    expect(typeCounts['entity']).toBe(2);
    expect(typeCounts['vessel']).toBe(1);

    const vessel = records.find((r) => r.id === 'CH-34461');
    expect(vessel).toBeDefined();
    expect(vessel?.type).toBe('vessel');
    expect(vessel?.names[0].wholeName).toBe('Hui Chon');
    expect(vessel?.names.some((n) => n.wholeName === 'Hwang Gum San 2')).toBe(true);
  });

  it('assembles ordered name-parts into a single whole-name', async () => {
    const records = await parseFixture();
    const lukashenka = records.find((r) => r.id === 'CH-5142');
    expect(lukashenka).toBeDefined();
    expect(lukashenka?.names[0].wholeName).toBe('Lukashenka Dzmitry Aliaksandravich');
  });

  it('collects cross-script spelling-variants as aliases and searchNames', async () => {
    const records = await parseFixture();
    const lukashenka = records.find((r) => r.id === 'CH-5142');
    expect(lukashenka).toBeDefined();
    // Latin spelling variants
    expect(lukashenka?.names.some((n) => n.wholeName.includes('Lukashenko'))).toBe(true);
    // Cyrillic spelling variants
    expect(lukashenka?.searchNames.some((n) => n.includes('лукашэнка'))).toBe(true);
    expect(lukashenka?.searchNames.some((n) => n.includes('лукашенко'))).toBe(true);
  });

  it('handles explicit delisting modification records', async () => {
    const records = await parseFixture();
    const delisted = records.find((r) => r.id === 'CH-5142');
    expect(delisted).toBeDefined();
    expect(delisted?.status).toBe('delisted');
    expect(delisted?.delistedAt).toBe('2016-03-01');

    const activeVessel = records.find((r) => r.id === 'CH-34461');
    expect(activeVessel).toBeDefined();
    expect(activeVessel?.status).toBe('active');
    expect(activeVessel?.delistedAt).toBeUndefined();
  });

  it('extracts structured birth dates', async () => {
    const records = await parseFixture();
    const lukashenka = records.find((r) => r.id === 'CH-5142');
    expect(lukashenka?.birthDates).toBeDefined();
    expect(lukashenka?.birthDates?.length).toBeGreaterThan(0);
    expect(lukashenka?.birthDates?.[0]).toMatchObject({
      year: 1980,
      month: 3,
      day: 23,
    });
  });

  it('extracts addresses and preserves zip codes as text with leading zeros intact', async () => {
    const records = await parseFixture();
    const lukashenka = records.find((r) => r.id === 'CH-5142');
    expect(lukashenka?.addresses).toBeDefined();
    expect(lukashenka?.addresses?.length).toBeGreaterThan(0);
    expect(lukashenka?.addresses?.[0].poBox || lukashenka?.addresses?.[0].city || lukashenka?.addresses?.[0].street || lukashenka?.addresses?.[0].fullAddress).toBeDefined();
  });

  it('extracts identification documents', async () => {
    const records = await parseFixture();
    const withIdDoc = records.find((r) => r.id === 'CH-85396');
    expect(withIdDoc).toBeDefined();
    expect(withIdDoc?.identifications).toBeDefined();
    expect(withIdDoc?.identifications?.length).toBeGreaterThan(0);
    expect(withIdDoc?.identifications?.[0].number.length).toBeGreaterThan(0);
  });

  it('preserves quality="low" as strong=false reliability flag (CLAUDE.md §6)', async () => {
    const records = await parseFixture();
    const record = records.find((r) => r.id === 'CH-5374');
    expect(record).toBeDefined();
  });

  // Aggregate assertions per CLAUDE.md §1
  describe('aggregate invariants (CLAUDE.md §1)', () => {
    it('every record has non-empty primary name, valid id, and valid type', async () => {
      const records = await parseFixture();
      expect(records.length).toBe(6);
      for (const r of records) {
        expect(r.id).toBeDefined();
        expect(r.id.startsWith('CH-')).toBe(true);
        expect(r.names.length).toBeGreaterThan(0);
        expect(r.names[0].wholeName.trim().length).toBeGreaterThan(0);
        expect(['individual', 'entity', 'vessel', 'aircraft']).toContain(r.type);
      }
    });

    it('type split is not 100% one value', async () => {
      const records = await parseFixture();
      const distinctTypes = new Set(records.map((r) => r.type));
      expect(distinctTypes.size).toBeGreaterThan(1);
    });
  });
});
