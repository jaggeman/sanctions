import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseEUList } from '../../src/importer/parsers/eu';
import { SanctionRecord } from '../../src/shared/types';

// Same real-structure fixture PR #13/#5 already use — issue #6 asks the
// parser to stop throwing away euReferenceNumber, unitedNationId, structured
// identifications/regulation/names/birthDates, and contactInfo.
const FIXTURE = path.join(__dirname, '../fixtures/eu_sample.xml');

let cache: SanctionRecord[] | null = null;
async function records(): Promise<SanctionRecord[]> {
  if (!cache) cache = await parseEUList(FIXTURE);
  return cache;
}
const byId = async (id: string) => (await records()).find((r) => r.id === id);

describe('parseEUList — issue #6 source-fidelity fields', () => {
  describe('entity-level reference numbers', () => {
    it('reads euReferenceNumber', async () => {
      expect((await byId('EU-13'))!.euReferenceNumber).toBe('EU.27.28');
    });

    it('reads sourceRef as the raw logicalId, before the "EU-" prefix', async () => {
      expect((await byId('EU-13'))!.sourceRef).toBe('13');
    });

    it('treats an empty unitedNationId as absent, not an empty string', async () => {
      expect((await byId('EU-13'))!.unitedNationId).toBeUndefined();
    });
  });

  describe('regulation metadata, structured', () => {
    it('captures numberTitle, programme, dates and url', async () => {
      const r = await byId('EU-13');
      expect(r!.regulation).toEqual({
        numberTitle: '1210/2003 (OJ L169)',
        programme: 'IRQ',
        publicationDate: '2003-07-08',
        entryIntoForceDate: '2003-07-07',
        url: 'http://eur-lex.europa.eu/LexUriServ/LexUriServ.do?uri=OJ:L:2003:169:0006:0023:EN:PDF',
      });
    });

    it('still derives the legacy flat sanctionReason/legalBasis from it', async () => {
      const r = await byId('EU-13');
      expect(r!.sanctionReason).toBe('1210/2003 (OJ L169)');
      expect(r!.legalBasis).toBe(r!.regulation!.url);
    });
  });

  describe('structured names', () => {
    it('produces one NameAlias per candidate, with strong/language/parts', async () => {
      const r = await byId('EU-13');
      expect(r!.names).toHaveLength(3);
      const primary = r!.names!.find((n) => n.wholeName === 'Saddam Hussein Al-Tikriti');
      expect(primary).toMatchObject({
        firstName: 'Saddam',
        lastName: 'Hussein Al-Tikriti',
        strong: true,
      });
      const french = r!.names!.find((n) => n.wholeName === 'Abou Ali');
      expect(french!.language).toBe('FR');
    });

    it('orders the selected primary name first, matching primaryNameOf/aliasNamesOf convention (issue #46)', async () => {
      const r = await byId('EU-13');
      expect(r!.names[0].wholeName).toBe('Saddam Hussein Al-Tikriti');
      expect(r!.names.slice(1).map((n) => n.wholeName)).toEqual(['Abu Ali', 'Abou Ali']);
    });
  });

  describe('structured birth dates', () => {
    it('captures year/month/day precision and circa, not just a joined string', async () => {
      const r = await byId('EU-13');
      expect(r!.birthDates).toEqual([
        {
          raw: '1937-04-28',
          year: 1937,
          month: 4,
          day: 28,
          circa: false,
          city: 'al-Awja, near Tikrit',
          countryIso2: 'IQ',
        },
      ]);
    });

  });

  describe('structured identifications', () => {
    it('captures type, country and the reliability flags, not just a formatted string', async () => {
      const r = await byId('EU-191');
      expect(r!.identifications).toEqual([
        {
          number: '488555',
          typeCode: 'passport',
          typeDescription: 'National passport',
          knownFalse: false,
          knownExpired: false,
          reportedLost: false,
          revokedByIssuer: false,
          diplomatic: false,
        },
      ]);
    });

  });

  describe('contactInfo aggregated across all address nodes', () => {
    it('collects PHONE and FAX values by key, deduplicated', async () => {
      const r = await byId('EU-330');
      expect(r!.contactInfo!.phoneNumbers).toEqual([
        '497 92 63',
        '262 38 18-19',
        '587-25 45',
        '668 33 01; 0300- 820 91 99',
        '042-681 20 81',
      ]);
      expect(r!.contactInfo!.faxNumbers).toEqual(['662 38 14']);
    });

    it('is undefined for an entity with no contactInfo anywhere', async () => {
      expect((await byId('EU-13'))!.contactInfo).toBeUndefined();
    });
  });

  describe('entity with no nameAlias at all', () => {
    it('falls back to a single "Unknown Name" entry (issue #46: names is required, never empty)', async () => {
      const r = await byId('EU-999999');
      expect(r!.names).toEqual([{ wholeName: 'Unknown Name', strong: false }]);
    });
  });
});
