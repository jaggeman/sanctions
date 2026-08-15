import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs-extra';
import { SanctionRecord, Address } from '../../shared/types';

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

export async function parseUNList(filePath: string): Promise<SanctionRecord[]> {
  console.log(`Parsing UN sanctions list from ${filePath}...`);
  const xmlContent = await fs.readFile(filePath, 'utf-8');
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlContent);
  const consolidatedList = parsed?.CONSOLIDATED_LIST;

  if (!consolidatedList) {
    console.warn('No CONSOLIDATED_LIST found in UN XML file.');
    return [];
  }

  const records: SanctionRecord[] = [];

  // 1. Process INDIVIDUALS
  const individuals = toArray(consolidatedList.INDIVIDUALS?.INDIVIDUAL);
  console.log(`Found ${individuals.length} UN individuals to parse.`);
  
  for (const ind of individuals) {
    const dataId = ind.DATAID;
    if (!dataId) continue;

    // Construct primary name from first, second, third and fourth names
    const nameParts = [ind.FIRST_NAME, ind.SECOND_NAME, ind.THIRD_NAME, ind.FOURTH_NAME]
      .map(n => String(n || '').trim())
      .filter(Boolean);
    const primaryName = nameParts.join(' ') || 'Unknown Name';

    // Map aliases
    const aliases: string[] = [];
    const rawAliases = toArray(ind.INDIVIDUAL_ALIAS);
    for (const alias of rawAliases) {
      const aliasName = String(alias.ALIAS_NAME || '').trim();
      if (aliasName && !aliases.includes(aliasName)) {
        aliases.push(aliasName);
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

    // Map passports / documents
    const passports: string[] = [];
    const rawDocs = toArray(ind.INDIVIDUAL_DOCUMENT);
    for (const doc of rawDocs) {
      const docType = String(doc.TYPE_OF_DOCUMENT || '').trim();
      const num = String(doc.NUMBER || '').trim();
      const country = String(doc.ISSUING_COUNTRY || '').trim();
      if (num) {
        const detail = docType ? `${docType} ${num}${country ? ` (${country})` : ''}` : num;
        passports.push(detail);
      }
    }

    const sanctionReason = String(ind.COMMENTS1 || '').trim();

    records.push({
      id: `UN-${dataId}`,
      source: 'UN',
      type: 'individual',
      primaryName,
      aliases,
      searchNames: [],
      datesOfBirth: datesOfBirth.length > 0 ? datesOfBirth : undefined,
      placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
      citizenships: citizenships.length > 0 ? citizenships : undefined,
      passports: passports.length > 0 ? passports : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason: sanctionReason || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // 2. Process ENTITIES
  const entities = toArray(consolidatedList.ENTITIES?.ENTITY);
  console.log(`Found ${entities.length} UN entities to parse.`);

  for (const ent of entities) {
    const dataId = ent.DATAID;
    if (!dataId) continue;

    const primaryName = String(ent.FIRST_NAME || '').trim() || 'Unknown Name';

    // Map aliases
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
      primaryName,
      aliases,
      searchNames: [],
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason: sanctionReason || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  console.log(`Parsed ${records.length} UN records.`);
  return records;
}
