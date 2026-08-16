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
    expect(airline!.names[0].wholeName).toBe('AEROCARIBBEAN AIRLINES');
    expect(airline!.names.slice(1).map((n) => n.wholeName)).toEqual(['AERO-CARIBBEAN']);
    expect(airline!.addresses?.[0].fullAddress).toBe('Havana, Cuba');
    expect(airline!.sanctionReason).toBe('CUBA');
  });

  it('parses an individual entry, joining first and last name', async () => {
    const records = await parseUSList(FIXTURE);
    const abbas = records.find((r) => r.id === 'US-SDN-2674');

    expect(abbas).toBeDefined();
    expect(abbas!.type).toBe('individual');
    expect(abbas!.names[0].wholeName).toBe('Abu ABBAS');
    expect(abbas!.names.slice(1).map((n) => n.wholeName)).toEqual(['Muhammad ZAYDAN']);
    expect(abbas!.birthDates!.map((b) => b.raw)).toEqual(['10 Dec 1948']);
  });

  it('issue #152: excludes non-identity entries (e.g. secondary sanctions risk, gender) from identifications', async () => {
    const records = await parseUSList(FIXTURE);
    const abbas = records.find((r) => r.id === 'US-SDN-2674');
    // uid 2674 only has a "Secondary sanctions risk:" entry in idList, which is legal boilerplate,
    // so identifications must remain undefined rather than storing it as a false identity document.
    expect(abbas!.identifications).toBeUndefined();
  });

  it('issue #152: includes genuine identifiers in identifications with clean typeDescription', async () => {
    const records = await parseUSList(FIXTURE);
    const jelassi = records.find((r) => r.id === 'US-SDN-7254');
    expect(jelassi!.identifications).toEqual([
      {
        number: 'L276046',
        typeDescription: 'Passport',
        countryIso2: undefined,
        knownExpired: true,
      },
    ]);

    const dawood = records.find((r) => r.id === 'US-SDN-9758');
    expect(dawood!.identifications).toEqual([
      {
        number: 'M-110522',
        typeDescription: 'Passport',
        countryIso2: 'India',
        knownExpired: false,
      },
    ]);
  });

  it('issue #152: filters out gender, organization established date, and other non-ID entries from XML', async () => {
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `us-non-id-${process.pid}.xml`);
    const xml = `<?xml version="1.0"?><sdnList><sdnEntry>
      <uid>1001</uid>
      <lastName>Test Person</lastName>
      <sdnType>Individual</sdnType>
      <idList>
        <id><idType>Gender</idType><idNumber>Male</idNumber></id>
        <id><idType>National ID No.</idType><idNumber>12345678</idNumber><idCountry>US</idCountry></id>
        <id><idType>Organization Established Date</idType><idNumber>1990</idNumber></id>
        <id><idType>Additional Sanctions Information -</idType><idNumber>Subject to Secondary Sanctions</idNumber></id>
        <id><idType>Cedula No.</idType><idNumber>87654321</idNumber></id>
      </idList>
    </sdnEntry></sdnList>`;
    await (fs as any).writeFile(tmp, xml, 'utf-8');
    try {
      const records = await parseUSList(tmp);
      expect(records[0].identifications).toEqual([
        { number: '12345678', typeDescription: 'National ID No.', countryIso2: 'US', knownExpired: false },
        { number: '87654321', typeDescription: 'Cedula No.', countryIso2: undefined, knownExpired: false },
      ]);
    } finally {
      await (fs as any).remove(tmp);
    }
  });

  it('parses a vessel entry', async () => {
    const records = await parseUSList(FIXTURE);
    const vessel = records.find((r) => r.id === 'US-SDN-4238');

    expect(vessel).toBeDefined();
    expect(vessel!.type).toBe('vessel');
    expect(vessel!.names[0].wholeName).toBe('MAR AZUL');
  });

  it('joins multiple program entries with a comma for the sanction reason', async () => {
    const records = await parseUSList(FIXTURE);
    // Every fixture entry here has exactly one program; verify the join logic
    // directly since the fixture can't exercise the multi-program branch.
    const airline = records.find((r) => r.id === 'US-SDN-36');
    expect(airline!.sanctionReason).toBe('CUBA');
  });

  it('issue #168: marks aliases strong/weak from the real <category> value, not hardcoded weak', async () => {
    // Real record (uid 306, BANCO NACIONAL DE CUBA) — has both a weak- and a
    // strong-category aka in the same entry.
    const records = await parseUSList(FIXTURE);
    const banco = records.find((r) => r.id === 'US-SDN-306');

    expect(banco).toBeDefined();
    const bnc = banco!.names?.find((n) => n.wholeName === 'BNC');
    const nationalBank = banco!.names?.find((n) => n.wholeName === 'NATIONAL BANK OF CUBA');
    expect(bnc?.strong).toBe(false);
    expect(nationalBank?.strong).toBe(true);
  });

  it('issue #168: the existing strong-category aliases still come through as strong (regression)', async () => {
    const records = await parseUSList(FIXTURE);
    const airline = records.find((r) => r.id === 'US-SDN-36');
    const aeroCaribbean = airline!.names?.find((n) => n.wholeName === 'AERO-CARIBBEAN');
    expect(aeroCaribbean?.strong).toBe(true);
  });

  it('issue #168: marks a passport [expired] when its expirationDate has genuinely passed', async () => {
    // Real record (uid 7254, JELASSI) — passport expirationDate 30 Jun 2001,
    // long in the past. Structured `identifications` carries knownExpired
    // through too (mirrors eu.ts's Identification shape).
    const records = await parseUSList(FIXTURE);
    const jelassi = records.find((r) => r.id === 'US-SDN-7254');

    expect(jelassi).toBeDefined();
    expect(jelassi!.identifications).toEqual([
      expect.objectContaining({ number: 'L276046', knownExpired: true }),
    ]);
  });

  it('issue #168: does not flag [expired] for a document with no expirationDate at all', async () => {
    const records = await parseUSList(FIXTURE);
    const dawood = records.find((r) => r.id === 'US-SDN-9758');
    expect(dawood!.identifications?.[0].knownExpired).toBe(false);
  });

  it('issue #168: does not flag [expired] when expirationDate is a real "DD Mon YYYY" date still in the future', async () => {
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `us-not-expired-${process.pid}.xml`);
    const xml = `<?xml version="1.0"?><sdnList><sdnEntry><uid>1</uid><lastName>Solo</lastName><sdnType>Individual</sdnType><idList><id><idType>Passport</idType><idNumber>X1</idNumber><expirationDate>01 Jan 2099</expirationDate></id></idList></sdnEntry></sdnList>`;
    await (fs as any).writeFile(tmp, xml, 'utf-8');
    try {
      const records = await parseUSList(tmp);
      expect(records[0].identifications).toEqual([
        expect.objectContaining({ number: 'X1', knownExpired: false }),
      ]);
    } finally {
      await (fs as any).remove(tmp);
    }
  });

  it('issue #168: handles month+year-only and year-only expirationDate formats seen in the real export', async () => {
    // Confirmed present in the real OFAC SDN file: "May 2006" (month+year)
    // and "2010" (year only), alongside the usual "DD Mon YYYY".
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `us-month-year-${process.pid}.xml`);
    const xml = `<?xml version="1.0"?><sdnList>
      <sdnEntry><uid>1</uid><lastName>Expired My</lastName><sdnType>Individual</sdnType><idList><id><idType>Passport</idType><idNumber>A1</idNumber><expirationDate>Jan 2000</expirationDate></id></idList></sdnEntry>
      <sdnEntry><uid>2</uid><lastName>Not Expired My</lastName><sdnType>Individual</sdnType><idList><id><idType>Passport</idType><idNumber>A2</idNumber><expirationDate>Jan 2099</expirationDate></id></idList></sdnEntry>
      <sdnEntry><uid>3</uid><lastName>Expired Year</lastName><sdnType>Individual</sdnType><idList><id><idType>Passport</idType><idNumber>A3</idNumber><expirationDate>2000</expirationDate></id></idList></sdnEntry>
      <sdnEntry><uid>4</uid><lastName>Not Expired Year</lastName><sdnType>Individual</sdnType><idList><id><idType>Passport</idType><idNumber>A4</idNumber><expirationDate>2099</expirationDate></id></idList></sdnEntry>
    </sdnList>`;
    await (fs as any).writeFile(tmp, xml, 'utf-8');
    try {
      const records = await parseUSList(tmp);
      expect(records.find((r) => r.id === 'US-SDN-1')!.identifications).toEqual([expect.objectContaining({ number: 'A1', knownExpired: true })]);
      expect(records.find((r) => r.id === 'US-SDN-2')!.identifications).toEqual([expect.objectContaining({ number: 'A2', knownExpired: false })]);
      expect(records.find((r) => r.id === 'US-SDN-3')!.identifications).toEqual([expect.objectContaining({ number: 'A3', knownExpired: true })]);
      expect(records.find((r) => r.id === 'US-SDN-4')!.identifications).toEqual([expect.objectContaining({ number: 'A4', knownExpired: false })]);
    } finally {
      await (fs as any).remove(tmp);
    }
  });

  it('issue #168: treats a date RANGE expirationDate ("X to Y") as valid through the end date', async () => {
    // Confirmed present in the real export: "01 Jan 2026 to 31 Dec 2026".
    const os = await import('os');
    const fs = await import('fs-extra');
    const tmp = path.join((os as any).tmpdir(), `us-range-${process.pid}.xml`);
    const xml = `<?xml version="1.0"?><sdnList>
      <sdnEntry><uid>1</uid><lastName>Range Past</lastName><sdnType>Individual</sdnType><idList><id><idType>Passport</idType><idNumber>R1</idNumber><expirationDate>01 Jan 2020 to 31 Dec 2020</expirationDate></id></idList></sdnEntry>
      <sdnEntry><uid>2</uid><lastName>Range Future</lastName><sdnType>Individual</sdnType><idList><id><idType>Passport</idType><idNumber>R2</idNumber><expirationDate>01 Jan 2099 to 31 Dec 2099</expirationDate></id></idList></sdnEntry>
    </sdnList>`;
    await (fs as any).writeFile(tmp, xml, 'utf-8');
    try {
      const records = await parseUSList(tmp);
      expect(records.find((r) => r.id === 'US-SDN-1')!.identifications).toEqual([expect.objectContaining({ number: 'R1', knownExpired: true })]);
      expect(records.find((r) => r.id === 'US-SDN-2')!.identifications).toEqual([expect.objectContaining({ number: 'R2', knownExpired: false })]);
    } finally {
      await (fs as any).remove(tmp);
    }
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
      expect(records[0].names[0].wholeName).toBe('Solo');
    } finally {
      await (fs as any).remove(tmp);
    }
  });
});
