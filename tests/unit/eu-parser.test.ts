import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseEUList } from '../../src/importer/parsers/eu';
import { SanctionRecord } from '../../src/shared/types';

// tests/fixtures/eu_sample.xml is carved verbatim out of the official EU FSD
// v1.1 consolidated export. Every element and attribute name below is what the
// EU actually ships — see issue #4 for why that matters.
const FIXTURE = path.join(__dirname, '../fixtures/eu_sample.xml');

let cache: SanctionRecord[] | null = null;
async function records(): Promise<SanctionRecord[]> {
  if (!cache) cache = await parseEUList(FIXTURE);
  return cache;
}
const byId = async (id: string) => (await records()).find((r) => r.id === id);

describe('parseEUList — real EU FSD v1.1 structure', () => {
  describe('names live in attributes, not child elements', () => {
    it('extracts a name for every entity that has one', async () => {
      const all = await records();
      const nameless = all.filter((r) => r.primaryName === 'Unknown Name');
      // Only the synthetic no-nameAlias entity may fall back.
      expect(nameless.map((r) => r.id)).toEqual(['EU-999999']);
    });

    it('reads wholeName off the nameAlias attribute', async () => {
      const r = await byId('EU-13');
      expect(r!.primaryName).toBe('Saddam Hussein Al-Tikriti');
    });

    it('keeps the remaining aliases, without duplicating the primary', async () => {
      const r = await byId('EU-13');
      expect(r!.aliases).toEqual(['Abu Ali', 'Abou Ali']);
      expect(r!.aliases).not.toContain(r!.primaryName);
    });

    it('preserves non-Latin aliases verbatim', async () => {
      const r = await byId('EU-330');
      expect(r!.aliases).toContain('Организация за подпомагане на Ulema, Пакистан');
    });
  });

  describe('subjectType uses person/enterprise, not I/E', () => {
    it('maps code="person" to individual', async () => {
      expect((await byId('EU-13'))!.type).toBe('individual');
      expect((await byId('EU-191'))!.type).toBe('individual');
    });

    it('maps code="enterprise" to entity', async () => {
      expect((await byId('EU-980'))!.type).toBe('entity');
      expect((await byId('EU-330'))!.type).toBe('entity');
    });

    it('does not collapse every record into a single type', async () => {
      const all = await records();
      const types = new Set(all.map((r) => r.type));
      expect(types.size).toBeGreaterThan(1);
    });
  });

  describe('primary name selection is deterministic', () => {
    it('prefers the alias carrying structured first/last name parts', async () => {
      // EU-191 lists seven strong aliases; only logicalId 289 has firstName +
      // lastName, and it is the canonical form. Document order would instead
      // pick the French transliteration at logicalId 161419.
      expect((await byId('EU-191'))!.primaryName).toBe('Khalid Sheikh MOHAMMED');
    });

    it('prefers English/unmarked aliases over other languages', async () => {
      // EU-330 has no structured names at all, and one Bulgarian alias.
      expect((await byId('EU-330'))!.primaryName).toBe('Al-Rasheed Trust');
    });

    it('produces the same result on a re-parse', async () => {
      const a = await parseEUList(FIXTURE);
      const b = await parseEUList(FIXTURE);
      expect(a.map((r) => r.primaryName)).toEqual(b.map((r) => r.primaryName));
    });
  });

  describe('<identification> — not <identificationDocument>', () => {
    it('captures the passport number and its type', async () => {
      const r = await byId('EU-191');
      expect(r!.passports).toBeDefined();
      expect(r!.passports).toContain('National passport 488555');
    });

    it('omits the issuing country when the source says it is unknown', async () => {
      // countryIso2Code="00" countryDescription="UNKNOWN"
      const r = await byId('EU-191');
      expect(r!.passports!.join(' ')).not.toMatch(/UNKNOWN/);
    });
  });

  describe('addresses', () => {
    it('reads zipCode, not zipcode', async () => {
      const r = await byId('EU-980');
      const withZip = r!.addresses!.find((a) => a.fullAddress?.includes('60455'));
      expect(withZip).toBeDefined();
    });

    it('reads street and city off attributes', async () => {
      const r = await byId('EU-980');
      const street = r!.addresses!.find(
        (a) => a.street === '9935 South 76th Avenue, Unit 1',
      );
      expect(street).toBeDefined();
      expect(street!.city).toBe('Bridgeview, Illinois');
      expect(street!.country).toBe('UNITED STATES');
    });

    it('never emits an address object with nothing in it', async () => {
      const all = await records();
      for (const r of all) {
        for (const a of r.addresses ?? []) {
          expect(a.fullAddress, `empty address on ${r.id}`).toBeTruthy();
        }
      }
    });
  });

  describe('birthdate and citizenship', () => {
    it('reads the birthdate attribute', async () => {
      expect((await byId('EU-13'))!.datesOfBirth).toEqual(['1937-04-28']);
    });

    it('reads multiple birthdates when the source lists several', async () => {
      expect((await byId('EU-191'))!.datesOfBirth).toEqual([
        '1965-04-14',
        '1964-03-01',
      ]);
    });

    it('combines birth city and country', async () => {
      expect((await byId('EU-13'))!.placesOfBirth).toEqual([
        'al-Awja, near Tikrit, IRAQ',
      ]);
    });

    it('treats a placeholder city of "-" as absent and de-duplicates', async () => {
      expect((await byId('EU-191'))!.placesOfBirth).toEqual(['PAKISTAN']);
    });

    it('reads citizenship countryDescription', async () => {
      expect((await byId('EU-13'))!.citizenships).toEqual(['IRAQ']);
    });
  });

  describe('regulation metadata', () => {
    it('reads numberTitle and publicationUrl off the regulation element', async () => {
      const r = await byId('EU-13');
      expect(r!.sanctionReason).toBe('1210/2003 (OJ L169)');
      expect(r!.legalBasis).toBe(
        'http://eur-lex.europa.eu/LexUriServ/LexUriServ.do?uri=OJ:L:2003:169:0006:0023:EN:PDF',
      );
    });
  });

  describe('structural handling', () => {
    it('parses the default namespace, which has no prefix', async () => {
      // The real export declares xmlns="..." on <export>, not export:export.
      expect((await records()).length).toBe(5);
    });

    it('falls back to "Unknown Name" only when there is no nameAlias at all', async () => {
      expect((await byId('EU-999999'))!.primaryName).toBe('Unknown Name');
    });

    it('skips an entity whose logicalId would escape the collection path', async () => {
      // logicalId becomes a Firestore document ID and arrives from an uploaded
      // file, so a value containing '/' must not be trusted.
      const os = await import('os');
      const fs = await import('fs-extra');
      const tmp = path.join(os.tmpdir(), `eu-unsafe-${process.pid}.xml`);
      await fs.writeFile(
        tmp,
        `<?xml version="1.0"?><export xmlns="http://eu.europa.ec/fpi/fsd/export">
           <sanctionEntity logicalId="../../admin/evil">
             <subjectType code="person" classificationCode="P"/>
             <nameAlias wholeName="Path Traversal" strong="true"/>
           </sanctionEntity>
           <sanctionEntity logicalId="42">
             <subjectType code="person" classificationCode="P"/>
             <nameAlias wholeName="Legitimate Record" strong="true"/>
           </sanctionEntity>
         </export>`,
        'utf-8',
      );
      try {
        const parsed = await parseEUList(tmp);
        expect(parsed.map((r) => r.id)).toEqual(['EU-42']);
      } finally {
        await fs.remove(tmp);
      }
    });

    it('returns an empty list when there are no sanctionEntity nodes', async () => {
      const os = await import('os');
      const fs = await import('fs-extra');
      const tmp = path.join(os.tmpdir(), `eu-empty-${process.pid}.xml`);
      await fs.writeFile(
        tmp,
        '<?xml version="1.0"?><export xmlns="http://eu.europa.ec/fpi/fsd/export"></export>',
        'utf-8',
      );
      try {
        expect(await parseEUList(tmp)).toEqual([]);
      } finally {
        await fs.remove(tmp);
      }
    });
  });
});
