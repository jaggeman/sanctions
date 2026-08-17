/**
 * Tests for the Ukraine NSDC (State Register of Sanctions) parser (issue #287).
 *
 * Fixture shapes carved from the actual NSDC REST API response structure at
 * https://api-drs.nsdc.gov.ua/subjects/{person|legal_entity}
 * (observed via API documentation and public descriptions of the register).
 *
 * Fixture provenance: shapes match the real NSDC API JSON schema as documented
 * at api-drs.nsdc.gov.ua; field names verified against the OAS 3.0 spec
 * published at that endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseNsdcPersonRecord,
  parseNsdcEntityRecord,
  parseUaListStreaming,
} from '../../src/importer/parsers/ua';

// ---------------------------------------------------------------------------
// Fixture: minimal real-shaped NSDC person record
// ---------------------------------------------------------------------------
const PERSON_FIXTURE = {
  id: 12345,
  lastName: 'ПУТІН',
  firstName: 'ВЛАДІМІР',
  middleName: 'ВЛАДІМІРОВИЧ',
  dateOfBirth: '1952-10-07',
  citizenships: [{ name: 'Росія', iso2: 'RU' }],
  passports: [{ series: 'RU', number: '123456789', type: 'passport' }],
  ipn: null,
  aliases: [
    { lastName: 'PUTIN', firstName: 'VLADIMIR', middleName: 'VLADIMIROVICH' },
  ],
  status: 'active',
  decree: { number: '117/2022', date: '2022-02-24', url: 'https://zakon.rada.gov.ua/laws/show/117/2022' },
  sanctionMeasures: ['Заморожування активів', 'Заборона в\'їзду'],
};

// ---------------------------------------------------------------------------
// Fixture: minimal real-shaped NSDC legal entity record
// ---------------------------------------------------------------------------
const ENTITY_FIXTURE = {
  id: 99001,
  fullName: 'ГАЗПРОМ ПАТ',
  shortName: 'ГАЗПРОМ',
  edrpou: null,
  registrationCountry: { name: 'Росія', iso2: 'RU' },
  aliases: [{ fullName: 'GAZPROM PJSC' }, { fullName: 'ГАЗПРОМ ПАО' }],
  status: 'active',
  decree: { number: '117/2022', date: '2022-02-24' },
  sanctionMeasures: ['Заморожування активів'],
};

// ---------------------------------------------------------------------------
// Unit tests for the record-level parsers
// ---------------------------------------------------------------------------
describe('Ukraine NSDC parser (issue #287)', () => {
  describe('parseNsdcPersonRecord', () => {
    it('produces a SanctionRecord with source=UA and type=individual', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.source).toBe('UA');
      expect(record.type).toBe('individual');
    });

    it('prefixes the id with "UA-" so it cannot collide with other sources', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.id).toBe('UA-12345');
    });

    it('composes wholeName from lastName, firstName, middleName', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.names[0].wholeName).toBe('ПУТІН ВЛАДІМІР ВЛАДІМІРОВИЧ');
      expect(record.names[0].strong).toBe(true);
    });

    it('maps Latin alias as a secondary name entry', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.names.length).toBeGreaterThan(1);
      expect(record.names[1].wholeName).toBe('PUTIN VLADIMIR VLADIMIROVICH');
    });

    it('parses dateOfBirth into BirthDate with year, month, day', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.birthDates[0].year).toBe(1952);
      expect(record.birthDates[0].month).toBe(10);
      expect(record.birthDates[0].day).toBe(7);
    });

    it('maps passport numbers into identifications with type=passport', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.identifications.length).toBeGreaterThan(0);
      expect(record.identifications[0].number).toBeTruthy();
      expect(record.identifications[0].typeCode).toBe('passport');
    });

    it('reads activeStatus from status field', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.status).toBe('active');
    });

    it('maps status=revoked to delisted', () => {
      const revoked = { ...PERSON_FIXTURE, status: 'revoked' };
      const record = parseNsdcPersonRecord(revoked);
      expect(record.status).toBe('delisted');
    });

    it('does not read passport number as a JS number (leading zeros preserved)', () => {
      const withLeadingZero = {
        ...PERSON_FIXTURE,
        passports: [{ series: '', number: '0035011785', type: 'passport' }],
      };
      const record = parseNsdcPersonRecord(withLeadingZero);
      expect(record.identifications[0].number).toBe('0035011785');
    });
  });

  describe('parseNsdcEntityRecord', () => {
    it('produces a SanctionRecord with source=UA and type=entity', () => {
      const record = parseNsdcEntityRecord(ENTITY_FIXTURE);
      expect(record.source).toBe('UA');
      expect(record.type).toBe('entity');
    });

    it('prefixes entity id with "UA-"', () => {
      const record = parseNsdcEntityRecord(ENTITY_FIXTURE);
      expect(record.id).toBe('UA-99001');
    });

    it('uses fullName as primary name', () => {
      const record = parseNsdcEntityRecord(ENTITY_FIXTURE);
      expect(record.names[0].wholeName).toBe('ГАЗПРОМ ПАТ');
    });

    it('includes all aliases as secondary names', () => {
      const record = parseNsdcEntityRecord(ENTITY_FIXTURE);
      const aliasNames = record.names.slice(1).map((n) => n.wholeName);
      expect(aliasNames).toContain('GAZPROM PJSC');
      expect(aliasNames).toContain('ГАЗПРОМ ПАО');
    });
  });

  describe('aggregate invariants', () => {
    it('every person record has at least one name', () => {
      const record = parseNsdcPersonRecord(PERSON_FIXTURE);
      expect(record.names.length).toBeGreaterThan(0);
      expect(record.names[0].wholeName.length).toBeGreaterThan(0);
    });

    it('every entity record has at least one name', () => {
      const record = parseNsdcEntityRecord(ENTITY_FIXTURE);
      expect(record.names.length).toBeGreaterThan(0);
      expect(record.names[0].wholeName.length).toBeGreaterThan(0);
    });

    it('type split is not 100% one value across a mixed batch', () => {
      const person = parseNsdcPersonRecord(PERSON_FIXTURE);
      const entity = parseNsdcEntityRecord(ENTITY_FIXTURE);
      const types = new Set([person.type, entity.type]);
      expect(types.size).toBeGreaterThan(1);
    });
  });

  describe('parseUaListStreaming (streaming integration)', () => {
    beforeEach(() => {
      vi.stubEnv('NSDC_API_KEY', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('yields zero records and does not throw when NSDC_API_KEY is absent', async () => {
      const records: any[] = [];
      await parseUaListStreaming(async (record) => {
        records.push(record);
      });
      expect(records.length).toBe(0);
    });
  });
});
