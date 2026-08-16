import { describe, it, expect } from 'vitest';
import {
  escapeCsvField,
  sanctionRecordToCsvRow,
  recordsToCsv,
  CSV_HEADERS,
} from '../../src/shared/csvSerializer';
import type { SanctionRecord } from '../../src/shared/types';

describe('csvSerializer', () => {
  describe('escapeCsvField', () => {
    it('returns empty string for null/undefined/empty', () => {
      expect(escapeCsvField(null)).toBe('');
      expect(escapeCsvField(undefined)).toBe('');
      expect(escapeCsvField('')).toBe('');
    });

    it('returns unquoted string for simple alphanumeric values', () => {
      expect(escapeCsvField('EU-1234')).toBe('EU-1234');
      expect(escapeCsvField('individual')).toBe('individual');
    });

    it('quotes strings containing commas', () => {
      expect(escapeCsvField('Moscow, Russia')).toBe('"Moscow, Russia"');
    });

    it('escapes internal quotes with double quotes and wraps in quotes', () => {
      expect(escapeCsvField('The "Great" Entity')).toBe('"The ""Great"" Entity"');
    });

    it('quotes strings containing newlines', () => {
      expect(escapeCsvField("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
    });

    describe('formula injection mitigation (issue #299)', () => {
      it('prefixes values starting with "=" with a single quote', () => {
        expect(escapeCsvField('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
        expect(escapeCsvField('=HYPERLINK("https://attacker.example/","Open")')).toBe(
          '"\'=HYPERLINK(""https://attacker.example/"",""Open"")"',
        );
      });

      it('prefixes values starting with "+" with a single quote', () => {
        expect(escapeCsvField('+123456')).toBe("'+123456");
      });

      it('prefixes values starting with "-" with a single quote', () => {
        expect(escapeCsvField('-100')).toBe("'-100");
        expect(escapeCsvField("-cmd|' /C calc'!A0")).toBe("'-cmd|\' /C calc\'!A0");
      });

      it('prefixes values starting with "@" with a single quote', () => {
        expect(escapeCsvField('@admin')).toBe("'@admin");
        expect(escapeCsvField('@SUM(1,2)')).toBe('"\'@SUM(1,2)"');
      });

      it('prefixes values starting with tab or carriage return with a single quote', () => {
        expect(escapeCsvField('\tvalue')).toBe("'\tvalue");
        expect(escapeCsvField('\rvalue')).toBe('"\'\rvalue"');
      });
    });
  });

  describe('sanctionRecordToCsvRow & recordsToCsv', () => {
    const mockRecord: SanctionRecord = {
      id: 'EU-123',
      source: 'EU',
      type: 'individual',
      names: [
        { wholeName: 'Vladimir Putin', strong: true },
        { wholeName: 'Wladimir Putin', strong: true },
      ],
      searchNames: [],
      birthDates: [{ raw: '1952-10-07', year: 1952 }],
      placesOfBirth: ['Saint Petersburg, Russia'],
      citizenships: ['RU'],
      identifications: [
        { number: 'PASS-123', typeDescription: 'Passport', countryIso2: 'RU' },
      ],
      addresses: [
        { street: 'Red Square', city: 'Moscow', country: 'Russia', fullAddress: 'Red Square, Moscow, Russia' },
      ],
      sanctionReason: 'Actions undermining integrity',
      legalBasis: 'Council Regulation (EU) 269/2014',
      unitedNationId: 'UN-999',
      euReferenceNumber: 'EU.27.28',
      status: 'active',
      listedAt: '2022-02-24T00:00:00.000Z',
      createdAt: '2022-02-24T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('serializes a single record to a valid CSV row matching headers', () => {
      const row = sanctionRecordToCsvRow(mockRecord);
      expect(row).toContain('EU-123');
      expect(row).toContain('EU');
      expect(row).toContain('individual');
      expect(row).toContain('Vladimir Putin');
      expect(row).toContain('Wladimir Putin');
      expect(row).toContain('1952-10-07');
      expect(row).toContain('"Saint Petersburg, Russia"');
      expect(row).toContain('RU');
      expect(row).toContain('Passport PASS-123 (RU)');
      expect(row).toContain('"Red Square, Moscow, Russia"');
    });

    it('includes score and matchedAlias when provided (search results)', () => {
      const searchResult = {
        ...mockRecord,
        score: 98,
        matchedAlias: 'Vladimir Putin',
      };
      const row = sanctionRecordToCsvRow(searchResult);
      expect(row).toContain('98');
      expect(row).toContain('Vladimir Putin');
    });

    it('generates full CSV with header and records', () => {
      const csv = recordsToCsv([mockRecord]);
      const lines = csv.split('\r\n');
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe(CSV_HEADERS.join(','));
      expect(lines[1]).toContain('EU-123');
    });

    it('handles empty / sparse records without throwing', () => {
      const sparseRecord: SanctionRecord = {
        id: 'US-EMPTY',
        source: 'US',
        type: 'entity',
        names: [],
        searchNames: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const csv = recordsToCsv([sparseRecord]);
      expect(csv).toContain('US-EMPTY');
      expect(csv).toContain('Unknown Name');
    });

    it('neutralizes formula injection characters in primaryName and sanctionReason (issue #299)', () => {
      const maliciousRecord: SanctionRecord = {
        ...mockRecord,
        names: [{ wholeName: '=HYPERLINK("https://attacker.com","Click")', strong: true }],
        sanctionReason: '-2+5+cmd|',
      };
      const row = sanctionRecordToCsvRow(maliciousRecord);
      expect(row).toContain('"\'=HYPERLINK(""https://attacker.com"",""Click"")"');
      expect(row).toContain("'-2+5+cmd|");
    });
  });
});
