import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs-extra';
import { SanctionRecord, Address, NameAlias, BirthDate, Identification } from '../../shared/types';
import { logger } from '../../shared/logger';

const log = logger.child({ module: 'importer.parsers.un' });

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Issue #6/#168: this source has no language/precision markers the way the
 * EU FSD export does, and either a full date or a bare year for birthdates.
 * `INDIVIDUAL_ALIAS` DOES carry a real reliability marker (`<QUALITY>Good|
 * Low</QUALITY>`) — `strongAliases` (built from that field by individual
 * callers only, see below) is fed through here instead of hardcoding every
 * alias weak. `ENTITY_ALIAS`'s `<QUALITY>` is a different thing entirely
 * (an alias-type label, `a.k.a.`/`f.k.a.` — never `Good`/`Low`) and is never
 * passed here, so entity aliases keep the unchanged default.
 */
function deriveNames(primaryName: string, aliases: string[], strongAliases: Set<string> = new Set()): NameAlias[] {
  const names: NameAlias[] = [{ wholeName: primaryName, strong: true }];
  for (const alias of aliases) names.push({ wholeName: alias, strong: strongAliases.has(alias) });
  return names;
}

function deriveBirthDates(datesOfBirth: string[]): BirthDate[] {
  return datesOfBirth.map((raw) => {
    const year = /^\d{4}$/.test(raw) ? parseInt(raw, 10) : undefined;
    return { raw, year };
  });
}

export async function parseUNList(filePath: string): Promise<SanctionRecord[]> {
  log.info('parse.start', { filePath });
  const xmlContent = await fs.readFile(filePath, 'utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: true,
    trimValues: true,
    // Issue #34: fast-xml-parser's default parseTagValue coerces any
    // all-digit element text to a JS number, silently dropping leading
    // zeros (a passport/national-ID number like "0035011785" becomes
    // 35011785). Nothing here relies on numeric auto-parsing — every field
    // consumed below is already wrapped in String(...).
    parseTagValue: false,
  });

  const parsed = parser.parse(xmlContent);
  const consolidatedList = parsed?.CONSOLIDATED_LIST;

  if (!consolidatedList) {
    log.warn('parse.no_consolidated_list_found', { filePath });
    return [];
  }

  const records: SanctionRecord[] = [];

  // 1. Process INDIVIDUALS
  const individuals = toArray(consolidatedList.INDIVIDUALS?.INDIVIDUAL);
  log.info('parse.individuals_found', { filePath, count: individuals.length });

  for (const ind of individuals) {
    const dataId = ind.DATAID;
    if (!dataId) continue;

    // Construct primary name from first, second, third and fourth names
    const nameParts = [ind.FIRST_NAME, ind.SECOND_NAME, ind.THIRD_NAME, ind.FOURTH_NAME]
      .map(n => String(n || '').trim())
      .filter(Boolean);
    const primaryName = nameParts.join(' ') || 'Unknown Name';

    // Map aliases — INDIVIDUAL_ALIAS's <QUALITY> is a genuine reliability
    // marker ("Good"/"Low"), unlike ENTITY_ALIAS's same-named field below
    // (issue #168).
    const aliases: string[] = [];
    const strongAliases = new Set<string>();
    const rawAliases = toArray(ind.INDIVIDUAL_ALIAS);
    for (const alias of rawAliases) {
      const aliasName = String(alias.ALIAS_NAME || '').trim();
      if (aliasName && !aliases.includes(aliasName)) {
        aliases.push(aliasName);
        if (String(alias.QUALITY || '').trim().toLowerCase() === 'good') {
          strongAliases.add(aliasName);
        }
      }
    }

    // Map addresses
    const addresses: Address[] = [];
    const rawAddrs = toArray(ind.INDIVIDUAL_ADDRESS);
    for (const addr of rawAddrs) {
      const street = String(addr.STREET || '').trim();
      const city = String(addr.CITY || '').trim();
      const state = String(addr.STATE_PROVINCE || '').trim();
      const country = String(addr.COUNTRY || '').trim();
      const fullParts = [street, city, state, country].filter(Boolean);
      
      addresses.push({
        street: street || undefined,
        city: city || undefined,
        country: country || undefined,
        fullAddress: fullParts.join(', ') || undefined,
      });
    }

    // Map birth details
    const datesOfBirth: string[] = [];
    const rawDobs = toArray(ind.INDIVIDUAL_DATE_OF_BIRTH);
    for (const dob of rawDobs) {
      const date = String(dob.DATE || dob.YEAR || '').trim();
      if (date) {
        datesOfBirth.push(date);
      }
    }

    const placesOfBirth: string[] = [];
    const rawPobs = toArray(ind.INDIVIDUAL_PLACE_OF_BIRTH);
    for (const pob of rawPobs) {
      const city = String(pob.CITY || '').trim();
      const state = String(pob.STATE_PROVINCE || '').trim();
      const country = String(pob.COUNTRY || '').trim();
      const full = [city, state, country].filter(Boolean).join(', ');
      if (full) {
        placesOfBirth.push(full);
      }
    }

    // Map citizenships (nationalities)
    const citizenships: string[] = [];
    const rawNats = toArray(ind.NATIONALITY?.VALUE);
    for (const nat of rawNats) {
      const country = String(nat || '').trim();
      if (country && !citizenships.includes(country)) {
        citizenships.push(country);
      }
    }

    // Map passports / documents (issue #46: structured, not a formatted string)
    const identifications: Identification[] = [];
    const rawDocs = toArray(ind.INDIVIDUAL_DOCUMENT);
    for (const doc of rawDocs) {
      const docType = String(doc.TYPE_OF_DOCUMENT || '').trim();
      const num = String(doc.NUMBER || '').trim();
      // Found while adding real-data fixture coverage for issue #34: the
      // real Consolidated List export uses ISSUING_COUNTRY on ~293
      // INDIVIDUAL_DOCUMENT entries and COUNTRY_OF_ISSUE on ~102 others —
      // reading only the first silently dropped the issuing country for
      // every document using the second name.
      const country = String(doc.ISSUING_COUNTRY || doc.COUNTRY_OF_ISSUE || '').trim();
      if (num) {
        identifications.push({
          number: num,
          typeDescription: docType || undefined,
          countryIso2: country || undefined,
        });
      }
    }

    const sanctionReason = String(ind.COMMENTS1 || '').trim();
    const birthDates = deriveBirthDates(datesOfBirth);

    records.push({
      id: `UN-${dataId}`,
      source: 'UN',
      type: 'individual',
      names: deriveNames(primaryName, aliases, strongAliases),
      searchNames: [],
      birthDates: birthDates.length > 0 ? birthDates : undefined,
      placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
      citizenships: citizenships.length > 0 ? citizenships : undefined,
      identifications: identifications.length > 0 ? identifications : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason: sanctionReason || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // 2. Process ENTITIES
  const entities = toArray(consolidatedList.ENTITIES?.ENTITY);
  log.info('parse.entities_found', { filePath, count: entities.length });

  for (const ent of entities) {
    const dataId = ent.DATAID;
    if (!dataId) continue;

    const primaryName = String(ent.FIRST_NAME || '').trim() || 'Unknown Name';

    // Map aliases. NOT reading ENTITY_ALIAS's <QUALITY> for strong/weak
    // (issue #168): on entities that field holds an alias-TYPE label
    // ("a.k.a."/"f.k.a."), never "Good"/"Low" — reusing the individual
    // mapping here would fabricate a false "every entity alias is
    // low-confidence" signal the source never actually asserted.
    const aliases: string[] = [];
    const rawAliases = toArray(ent.ENTITY_ALIAS);
    for (const alias of rawAliases) {
      const aliasName = String(alias.ALIAS_NAME || '').trim();
      if (aliasName && !aliases.includes(aliasName)) {
        aliases.push(aliasName);
      }
    }

    // Map addresses
    const addresses: Address[] = [];
    const rawAddrs = toArray(ent.ENTITY_ADDRESS);
    for (const addr of rawAddrs) {
      const street = String(addr.STREET || '').trim();
      const city = String(addr.CITY || '').trim();
      const state = String(addr.STATE_PROVINCE || '').trim();
      const country = String(addr.COUNTRY || '').trim();
      const fullParts = [street, city, state, country].filter(Boolean);
      
      addresses.push({
        street: street || undefined,
        city: city || undefined,
        country: country || undefined,
        fullAddress: fullParts.join(', ') || undefined,
      });
    }

    const sanctionReason = String(ent.COMMENTS1 || ent.REASON_FOR_LISTING || '').trim();

    records.push({
      id: `UN-${dataId}`,
      source: 'UN',
      type: 'entity',
      names: deriveNames(primaryName, aliases),
      searchNames: [],
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason: sanctionReason || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  log.info('parse.complete', { filePath, recordCount: records.length });
  return records;
}
