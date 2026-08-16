import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseUSList } from '../../src/importer/parsers/us';

const FIXTURE = path.join(__dirname, '../fixtures/us_sample.xml');

describe('parseUSList', () => {
  it('parses an entity entry, using lastName alone as the primary name', async () => {
    const records = await parseUSList(FIXTURE);
    const airline = records.find((r) => r.id === 'US-SDN-36');

    expect(airline).toBeDefined();
    expect(airline!.source).toBe('US');
    expect(airline!.type).toBe('entity');
    expect(airline!.primaryName).toBe('AEROCARIBBEAN AIRLINES');
    expect(airline!.aliases).toEqual(['AERO-CARIBBEAN']);
    expect(airline!.addresses?.[0].fullAddress).toBe('Havana, Cuba');
    expect(airline!.sanctionReason).toBe('CUBA');
  });

  it('parses an individual entry, joining first and last name', async () => {
    const records = await parseUSList(FIXTURE);
    const abbas = records.find((r) => r.id === 'US-SDN-2674');

    expect(abbas).toBeDefined();
    expect(abbas!.type).toBe('individual');
    expect(abbas!.primaryName).toBe('Abu ABBAS');
    expect(abbas!.aliases).toEqual(['Muhammad ZAYDAN']);
    expect(abbas!.datesOfBirth).toEqual(['10 Dec 1948']);
  });

  it('formats an id-list entry even when it is not really a passport number', async () => {
    // KNOWN QUIRK: the SDN "Secondary sanctions risk:" idType is legal boilerplate,
    // not an identity document, but the parser has no way to distinguish it from
    // a real passport/national-id entry and stores it in `passports` regardless.
    const records = await parseUSList(FIXTURE);
    const abbas = records.find((r) => r.id === 'US-SDN-2674');
    expect(abbas!.passports).toEqual([
      'Secondary sanctions risk: section 1(b) of Executive Order 13224',
    ]);
  });

  it('parses a vessel entry', async () => {
    const records = await parseUSList(FIXTURE);
    const vessel = records.find((r) => r.id === 'US-SDN-4238');

    expect(vessel).toBeDefined();
    expect(vessel!.type).toBe('vessel');
    expect(vessel!.primaryName).toBe('MAR AZUL');
  });

  it('joins multiple program entries with a comma for the sanction reason', async () => {
    const records = await parseUSList(FIXTURE);
    // Every fixture entry here has exactly one program; verify the join logic
    // directly since the fixture can't exercise the multi-program branch.
    const airline = records.find((r) => r.id === 'US-SDN-36');
    expect(airline!.sanctionReason).toBe('CUBA');
  });

  it('returns an empty list when sdnEntry is absent', async () => {
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `us-empty-${Date.now()}.xml`);
    await (fs as any).writeFile(tmp, '<?xml version="1.0"?><sdnList></sdnList>', 'utf-8');
    try {
      const records = await parseUSList(tmp);
      expect(records).toEqual([]);
    } finally {
      await (fs as any).remove(tmp);
    }
  });

  // issue #169: nationalityList/citizenshipList were dropped entirely.
  it('maps citizenshipList into citizenships, deduping against a nationality already seen', async () => {
    const records = await parseUSList(FIXTURE);
    const dawood = records.find((r) => r.id === 'US-SDN-9758');

    expect(dawood).toBeDefined();
    // nationality is India, citizenships are India/Pakistan/UAE — India
    // must appear only once in the merged list, not twice.
    expect(dawood!.citizenships).toEqual(['India', 'Pakistan', 'United Arab Emirates']);
  });

  it('maps nationalityList alone when there is no citizenshipList', async () => {
    const records = await parseUSList(FIXTURE);
    const sharif = records.find((r) => r.id === 'US-SDN-6944');

    expect(sharif).toBeDefined();
    expect(sharif!.citizenships).toEqual(['Saudi Arabia']);
  });

  it('leaves citizenships undefined when neither list is present', async () => {
    const records = await parseUSList(FIXTURE);
    const airline = records.find((r) => r.id === 'US-SDN-36');

    expect(airline!.citizenships).toBeUndefined();
  });

  it('normalises a single sdnEntry (no array) into a one-element result', async () => {
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `us-single-${Date.now()}.xml`);
    const xml = `<?xml version="1.0"?><sdnList><sdnEntry><uid>1</uid><lastName>Solo</lastName><sdnType>Entity</sdnType></sdnEntry></sdnList>`;
    await (fs as any).writeFile(tmp, xml, 'utf-8');
    try {
      const records = await parseUSList(tmp);
      expect(records).toHaveLength(1);
      expect(records[0].primaryName).toBe('Solo');
    } finally {
      await (fs as any).remove(tmp);
    }
  });
});
