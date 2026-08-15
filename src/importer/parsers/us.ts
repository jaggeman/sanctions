import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs-extra';
import { SanctionRecord, Address, NameAlias, BirthDate } from '../../shared/types';

/**
 * Issue #6: OFAC SDN has no strong/language markers on aliases and no
 * date-precision beyond whatever string `dateOfBirth` already is — derived
 * from the already-computed primary name/aliases/dates rather than invented.
 */
function deriveNames(primaryName: string, aliases: string[]): NameAlias[] {
  const names: NameAlias[] = [{ wholeName: primaryName, strong: true }];
  for (const alias of aliases) names.push({ wholeName: alias, strong: false });
  return names;
}

function deriveBirthDates(datesOfBirth: string[]): BirthDate[] {
  return datesOfBirth.map((raw) => {
    const year = /^\d{4}$/.test(raw) ? parseInt(raw, 10) : undefined;
    return { raw, year };
  });
}

export async function parseUSList(filePath: string): Promise<SanctionRecord[]> {
  console.log(`Parsing US OFAC SDN list from ${filePath}...`);
  const xmlContent = await fs.readFile(filePath, 'utf-8');
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlContent);
  const sdnList = parsed?.sdnList?.sdnEntry;

  if (!sdnList) {
    console.warn('No sdnEntry found in US XML file.');
    return [];
  }

  // Ensure sdnList is an array (fast-xml-parser might parse a single object if there's only 1 entry)
  const entries = Array.isArray(sdnList) ? sdnList : [sdnList];
  const records: SanctionRecord[] = [];

  for (const entry of entries) {
    const uid = entry.uid;
    const sdnTypeStr = (entry.sdnType || '').toLowerCase();
    
    let type: 'individual' | 'entity' | 'vessel' | 'aircraft' = 'entity';
    if (sdnTypeStr === 'individual') type = 'individual';
    else if (sdnTypeStr === 'vessel') type = 'vessel';
    else if (sdnTypeStr === 'aircraft') type = 'aircraft';

    const first = entry.firstName ? String(entry.firstName) : '';
    const last = entry.lastName ? String(entry.lastName) : '';
    const primaryName = first ? `${first} ${last}`.trim() : last.trim();

    // Map aliases (AKA)
    const aliases: string[] = [];
    if (entry.akaList?.aka) {
      const akas = Array.isArray(entry.akaList.aka) ? entry.akaList.aka : [entry.akaList.aka];
      for (const aka of akas) {
        const akaFirst = aka.firstName ? String(aka.firstName) : '';
        const akaLast = aka.lastName ? String(aka.lastName) : '';
        const akaName = akaFirst ? `${akaFirst} ${akaLast}`.trim() : akaLast.trim();
        if (akaName && !aliases.includes(akaName)) {
          aliases.push(akaName);
        }
      }
    }

    // Map addresses
    const addresses: Address[] = [];
    if (entry.addressList?.address) {
      const addrs = Array.isArray(entry.addressList.address) ? entry.addressList.address : [entry.addressList.address];
      for (const addr of addrs) {
        const a1 = addr.address1 ? String(addr.address1) : '';
        const a2 = addr.address2 ? String(addr.address2) : '';
        const a3 = addr.address3 ? String(addr.address3) : '';
        const city = addr.city ? String(addr.city) : '';
        const state = addr.stateOrProvince ? String(addr.stateOrProvince) : '';
        const zip = addr.postalCode ? String(addr.postalCode) : '';
        const country = addr.country ? String(addr.country) : '';

        const fullParts = [a1, a2, a3, city, state, zip, country].filter(Boolean);
        addresses.push({
          street: [a1, a2, a3].filter(Boolean).join(', ') || undefined,
          city: city || undefined,
          country: country || undefined,
          fullAddress: fullParts.join(', ') || undefined,
        });
      }
    }

    // Map birth details
    const datesOfBirth: string[] = [];
    if (entry.dateOfBirthList?.dateOfBirthItem) {
      const dobs = Array.isArray(entry.dateOfBirthList.dateOfBirthItem)
        ? entry.dateOfBirthList.dateOfBirthItem
        : [entry.dateOfBirthList.dateOfBirthItem];
      for (const dobItem of dobs) {
        if (dobItem.dateOfBirth) {
          datesOfBirth.push(String(dobItem.dateOfBirth));
        }
      }
    }

    const placesOfBirth: string[] = [];
    if (entry.placeOfBirthList?.placeOfBirthItem) {
      const pobs = Array.isArray(entry.placeOfBirthList.placeOfBirthItem)
        ? entry.placeOfBirthList.placeOfBirthItem
        : [entry.placeOfBirthList.placeOfBirthItem];
      for (const pobItem of pobs) {
        if (pobItem.placeOfBirth) {
          placesOfBirth.push(String(pobItem.placeOfBirth));
        }
      }
    }

    // Map IDs (passports, national ID, etc.)
    const passports: string[] = [];
    if (entry.idList?.id) {
      const ids = Array.isArray(entry.idList.id) ? entry.idList.id : [entry.idList.id];
      for (const idItem of ids) {
        const num = idItem.idNumber ? String(idItem.idNumber) : '';
        const idType = idItem.idType ? String(idItem.idType) : '';
        const country = idItem.idCountry ? String(idItem.idCountry) : '';
        if (num) {
          const detail = idType ? `${idType} ${num}${country ? ` (${country})` : ''}` : num;
          passports.push(detail);
        }
      }
    }

    // Map program details as sanction reason
    const programs: string[] = [];
    if (entry.programList?.program) {
      const progs = Array.isArray(entry.programList.program) ? entry.programList.program : [entry.programList.program];
      programs.push(...progs);
    }
    const sanctionReason = programs.join(', ');
    const birthDates = deriveBirthDates(datesOfBirth);

    records.push({
      id: `US-SDN-${uid}`,
      source: 'US',
      type,
      primaryName,
      aliases,
      searchNames: [], // Generated by uploader
      names: deriveNames(primaryName, aliases),
      datesOfBirth: datesOfBirth.length > 0 ? datesOfBirth : undefined,
      birthDates: birthDates.length > 0 ? birthDates : undefined,
      placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
      passports: passports.length > 0 ? passports : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason: sanctionReason || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  console.log(`Parsed ${records.length} US OFAC records.`);
  return records;
}
