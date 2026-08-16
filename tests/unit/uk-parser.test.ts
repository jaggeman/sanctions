import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseUKList } from '../../src/importer/parsers/uk';

const FIXTURE = path.join(__dirname, '../fixtures/uk_sample.xml');

describe('parseUKList', () => {
  it('parses a real individual, building the primary name from Name1/Name2/Name6', async () => {
    const records = await parseUKList(FIXTURE);
    const abdul = records.find((r) => r.id === 'UK-AFG0011');

    expect(abdul).toBeDefined();
    expect(abdul!.source).toBe('UK');
    expect(abdul!.type).toBe('individual');
    expect(abdul!.names[0].wholeName).toBe('ABDUL LATIF MANSUR');
    expect(abdul!.unitedNationId).toBe('TAi.007');
    expect(abdul!.sourceRef).toBe('AFG0011');
  });

  it('collects Alias and "Primary Name Variation" entries as aliases, not just the primary', async () => {
    const records = await parseUKList(FIXTURE);
    const abdul = records.find((r) => r.id === 'UK-AFG0011');
    const aliases = abdul!.names.slice(1).map((n) => n.wholeName);
    expect(aliases).toContain('Abdul Latif MANSOOR');
    expect(aliases).toContain('Wali MOHAMMAD');
  });

  it('issue #99: parses a dd/mm/YYYY placeholder DOB as year-only, and a real DD/MM/YYYY DOB in full (deduped)', async () => {
    const records = await parseUKList(FIXTURE);
    const abdul = records.find((r) => r.id === 'UK-AFG0011');

    // "dd/mm/1968" is a literal placeholder in the real data for an unknown
    // day/month — must not be parsed as a real date (DD/MM as US MM/DD would
    // also be wrong here since "dd"/"mm" aren't even digits).
    const yearOnly = abdul!.birthDates?.find((b) => b.year === 1968 && !b.raw);
    expect(yearOnly).toBeDefined();

    // "12/11/1967" appears twice in the source — deduped to one entry, and
    // parsed as DD/MM/YYYY (12 Nov 1967), never as US MM/DD.
    const fullDate = abdul!.birthDates?.filter((b) => b.raw === '1967-11-12');
    expect(fullDate).toHaveLength(1);
    expect(fullDate![0].day).toBe(12);
    expect(fullDate![0].month).toBe(11);
    expect(fullDate![0].year).toBe(1967);
  });

  it('issue #187: parses month-known/day-unknown (dd/09/1958) and bare-year (1985) DOB shapes', async () => {
    const records = await parseUKList(FIXTURE);
    const akram = records.find((r) => r.id === 'UK-AQD0128');
    expect(akram).toBeDefined();

    const monthKnown = akram!.birthDates?.find((b) => b.month === 9 && b.year === 1958);
    expect(monthKnown).toBeDefined();
    expect(monthKnown!.day).toBeUndefined();
    expect(monthKnown!.raw).toBeUndefined();

    const bareYear = akram!.birthDates?.find((b) => b.year === 1985 && b.month === undefined);
    expect(bareYear).toBeDefined();
    expect(bareYear!.day).toBeUndefined();
    expect(bareYear!.raw).toBeUndefined();
  });

  it('trims a passport number with stray leading whitespace from the real source', async () => {
    const records = await parseUKList(FIXTURE);
    const abdul = records.find((r) => r.id === 'UK-AFG0011');
    const numbers = abdul!.identifications?.map((i) => i.number);
    expect(numbers).toContain('D0009720');
    expect(numbers).not.toContain(' D0009720');
  });

  it('builds a full address from AddressLine1/AddressLine2 fields', async () => {
    const records = await parseUKList(FIXTURE);
    const abdul = records.find((r) => r.id === 'UK-AFG0011');
    expect(abdul!.addresses?.[0].fullAddress).toContain('Darul Aman');
    expect(abdul!.addresses?.[0].fullAddress).toContain('Kabul');
    expect(abdul!.addresses?.[0].fullAddress).toContain('Afghanistan');
  });

  it('collects citizenships from Nationalities', async () => {
    const records = await parseUKList(FIXTURE);
    const abdul = records.find((r) => r.id === 'UK-AFG0011');
    expect(abdul!.citizenships).toEqual(['Afghanistan']);
  });

  it('issue #99: matches NameType case-insensitively ("Primary name" lowercase is real production data)', async () => {
    const records = await parseUKList(FIXTURE);
    const akram = records.find((r) => r.id === 'UK-AQD0128');

    expect(akram).toBeDefined();
    expect(akram!.names[0].wholeName).toBe('AKRAM TURKI HISHAN AL-MAZIDIH');
  });

  it('issue #99/#34-class bug: preserves a leading-zero national identifier number', async () => {
    const records = await parseUKList(FIXTURE);
    const akram = records.find((r) => r.id === 'UK-AQD0128');
    const numbers = akram!.identifications?.map((i) => i.number);
    expect(numbers).toContain('0075258');
  });

  it('parses an entity with no IndividualDetails/ShipDetails block', async () => {
    const records = await parseUKList(FIXTURE);
    const ktj = records.find((r) => r.id === 'UK-AQD0377');

    expect(ktj).toBeDefined();
    expect(ktj!.type).toBe('entity');
    expect(ktj!.names[0].wholeName).toBe('Khatiba al-Tawhid wal-Jihad (KTJ)');
    expect(ktj!.names.slice(1).map((n) => n.wholeName)).toContain("Jama'at al-Tawhid wal-Jihad");
  });

  it('maps IndividualEntityShip "Ship" to the canonical "vessel" type', async () => {
    const records = await parseUKList(FIXTURE);
    const ship = records.find((r) => r.id === 'UK-DPR0075');

    expect(ship).toBeDefined();
    expect(ship!.type).toBe('vessel');
    expect(ship!.names[0].wholeName).toBe('Petrel 8');
  });

  it('does not crash on a Ship record with no OFSIGroupID or UNReferenceNumber (both optional)', async () => {
    const records = await parseUKList(FIXTURE);
    const ship = records.find((r) => r.id === 'UK-DPR0075');
    expect(ship!.unitedNationId).toBeUndefined();
  });

  it('captures a ship IMO number as an identification', async () => {
    const records = await parseUKList(FIXTURE);
    const ship = records.find((r) => r.id === 'UK-DPR0075');
    const numbers = ship!.identifications?.map((i) => i.number);
    expect(numbers).toContain('IMO9562233');
  });

  it('skips a designation with no UniqueID', async () => {
    const records = await parseUKList(FIXTURE);
    expect(records.find((r) => r.names[0].wholeName === 'No Unique Id')).toBeUndefined();
  });

  it('parses exactly the real records in the fixture (5 designations, 1 skipped for missing id)', async () => {
    const records = await parseUKList(FIXTURE);
    expect(records).toHaveLength(4);
  });
});
