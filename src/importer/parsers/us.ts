import { SanctionRecord, Address, NameAlias, BirthDate, Identification } from '../../shared/types';
import { streamXmlRecords } from './xmlSubtreeStream';
import { logger } from '../../shared/logger';

const log = logger.child({ module: 'importer.parsers.us' });

/**
 * Issue #6/#168: OFAC SDN has no date-precision beyond whatever string
 * `dateOfBirth` already is, but it DOES carry a real strong/weak marker per
 * alias (`<aka><category>`) — `strongAliases` (built from that field by the
 * caller) is fed through here rather than every alias being hardcoded weak
 * (the bug issue #168 fixed: 4,393 real weak aliases were being presented as
 * confirmed).
 */
function deriveNames(primaryName: string, aliases: string[], strongAliases: Set<string>): NameAlias[] {
  const names: NameAlias[] = [{ wholeName: primaryName, strong: true }];
  for (const alias of aliases) names.push({ wholeName: alias, strong: strongAliases.has(alias) });
  return names;
}

/**
 * OFAC's free-text `expirationDate` on an `<id>` entry, parsed into the
 * latest date the document should be considered valid through — or `null`
 * if the format can't be confidently interpreted (issue #168). Real formats
 * observed in the SDN export: `"17 Jul 2011"` (day+month+year), `"May
 * 2006"` (month+year — valid through month-end), `"2010"` (year only —
 * valid through year-end), and a date RANGE `"01 Jan 2026 to 31 Dec 2026"`
 * (valid through the range's end). Anything else is left unparsed rather
 * than guessed at — presence of the field alone does not mean expired: 383
 * of the 1,173 real occurrences are dated in the future.
 */
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseExpirationBoundary(raw: string): Date | null {
  const text = raw.trim();

  const rangeMatch = text.match(/^(.+?)\s+to\s+(.+)$/i);
  if (rangeMatch) return parseExpirationBoundary(rangeMatch[2]);

  const dayMonthYear = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (dayMonthYear) {
    const month = MONTHS[dayMonthYear[2]];
    if (month === undefined) return null;
    return new Date(Number(dayMonthYear[3]), month, Number(dayMonthYear[1]), 23, 59, 59);
  }

  const monthYear = text.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (monthYear) {
    const month = MONTHS[monthYear[1]];
    if (month === undefined) return null;
    return new Date(Number(monthYear[2]), month + 1, 0, 23, 59, 59); // last day of that month
  }

  const yearOnly = text.match(/^(\d{4})$/);
  if (yearOnly) {
    return new Date(Number(yearOnly[1]), 11, 31, 23, 59, 59); // last day of that year
  }

  return null;
}

function isExpired(raw: string | undefined): boolean {
  if (!raw) return false;
  const boundary = parseExpirationBoundary(raw);
  if (!boundary) return false; // can't confirm — don't claim expired
  return boundary.getTime() < Date.now();
}

function deriveBirthDates(datesOfBirth: string[]): BirthDate[] {
  return datesOfBirth.map((raw) => {
    const year = /^\d{4}$/.test(raw) ? parseInt(raw, 10) : undefined;
    return { raw, year };
  });
}

/**
 * Parser for the US Treasury OFAC Specially Designated Nationals (SDN) list.
 *
 * Streaming since issue #31: the real SDN export (~29 MB, ~19 200 entries) was
 * measured against the deployed Cloud Function's actual memory ceiling
 * (256 MiB, no `runWith` override) using the previous full-DOM
 * (`fast-xml-parser`) parse — peak RSS came in at ~317 MB, over budget, and
 * one run of that measurement crashed outright with a JS heap OOM. The UN
 * consolidated list was measured the same way and found to be no risk (a
 * ~2 MB file, comfortably under budget even at a 64 MB ceiling) — see issue
 * #31 and this PR's description for the numbers. `un.ts` is therefore left
 * as-is; only this file changes.
 *
 * `parseUSListStreaming` builds one `<sdnEntry>` subtree at a time (via the
 * shared engine in `xmlSubtreeStream.ts`, the same one issue #5 built for the
 * EU parser) and discards it before the next one, rather than holding a DOM
 * tree over the whole document.
 */

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * `uid` becomes part of a Firestore document ID (`US-SDN-<uid>`). It arrives
 * from a downloaded file, so it's validated rather than trusted — the same
 * gap the EU parser closed in issue #5 for `logicalId`.
 */
const SAFE_UID = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Issue #152: OFAC SDN exports use <idList><id> as an untyped bucket for everything
 * from real passports to legal boilerplate ("Secondary sanctions risk:"), demographic
 * markers ("Gender: Male"), organization dates ("Organization Established Date: 1994"),
 * and sanctions directives ("Executive Order 13846 information:").
 *
 * This allow-list contains all genuine identity, tax, legal entity, registration,
 * vessel/aircraft, and credential document types derived from the 171 distinct idTypes
 * found in the real OFAC SDN export.
 */
const ALLOWED_US_ID_TYPES = new Set<string>([
  // Passports & Travel Documents
  'Passport',
  'Diplomatic Passport',
  'British National Overseas Passport',
  'Stateless Person Passport',
  'Travel Document Number',
  'Refugee ID Card',
  'Stateless Person ID Card',
  "Seafarer's Identification Document",
  'Immigration No.',
  'Public Security and Immigration No.',
  'VisaNumberID',

  // National IDs, Civil IDs, Personal IDs
  'National ID No.',
  'National Foreign ID Number',
  'Identification Number',
  'Personal ID Card',
  "Citizen's Card Number",
  'Numero de Identidad',
  'Tarjeta de Identidad',
  'Credencial electoral',
  'Electoral Registry No.',
  'I.F.E.',
  'D.N.I.',
  'C.U.I.',
  'C.U.I.P.',
  'C.U.R.P.',
  'CNP (Personal Numerical Code)',
  'Tazkira National ID Card',
  'Turkish Identification Number',
  'Kenyan ID No.',
  'Moroccan Personal ID No.',
  'Bosnian Personal ID No.',
  'UAE Identification',
  'Birth Certificate Number',
  'Cartilla de Servicio Militar Nacional',
  'Military Registration Number',
  'Romanian Permanent Resident',
  'Residency Number',
  'Federal ID Card',
  'N.I.E.',
  'SSN',

  // Tax IDs, Business & Legal Entity IDs, Registration Numbers
  'Tax ID No.',
  'Registration Number',
  'Business Registration Number',
  'Business Registration Document #',
  'Registration ID',
  'Company Number',
  'UK Company Number',
  'Enterprise Number',
  'Entity Code',
  'Legal Entity Number',
  'LE Number',
  'Central Registration System Number',
  'Commercial Registry Number',
  'Romanian C.R.',
  'C.R. No.',
  'Public Registration Number',
  'Certificate of Incorporation Number',
  'Registration Certificate Number (Dubai)',
  'Chamber of Commerce Number',
  'Istanbul Chamber of Comm. No.',
  'Dubai Chamber of Commerce Membership No.',
  'Folio Mercantil No.',
  'Matricula Mercantil No',
  'Business Number',
  'Branch Unit Number',
  'Organization Code',
  'United Social Credit Code Certificate (USCCC)',
  'Unified Social Credit Code (USCC)',
  'Chinese Commercial Code',
  'Economic Register Number (CBLS)',
  'Registered Charity No.',
  'C.I.N.',
  'US FEIN',
  'D-U-N-S Number',
  'Cedula No.',
  'R.F.C.',
  'RFC',
  'RUC #',
  'NIT #',
  'RIF #',
  'RTN',
  'C.I.F.',
  'C.U.I.T.',
  'N.I.F.',
  'Numero Unico de Identificacao Tributaria (NUIT)',
  'Italian Fiscal Code',
  'Paraguayan tax identification number',
  'Romanian Tax Registration',
  'Fiscal Code',
  'V.A.T. Number',
  'Russian State Individual Business Registration Number Pattern (OGRNIP)',
  'Global Intermediary Identification Number',
  'Government Gazette Number',
  'File Number',
  'Serial No.',
  'Trade License No.',
  'License',
  'Permit Number',
  'SRE Permit No.',
  'Tourism License No.',
  "Driver's License No.",
  'Pilot License Number',
  'MSB Registration Number',
  'Afghan Money Service Provider License Number',
  'Trademark number',

  // Financial, Securities, Banking
  'SWIFT/BIC',
  'BIK (RU)',
  'ISIN',
  'MICEX Code',
  'Equity Ticker',

  // Vessel & Aircraft Identifiers
  'Vessel Registration Identification',
  'MMSI',
  'Other Vessel Call Sign',
  'Aircraft Tail Number',
  'Previous Aircraft Tail Number',
  "Aircraft Manufacturer's Serial Number (MSN)",
  'Aircraft Construction Number (also called L/N or S/N or F/N)',
  'Aircraft Serial Identification',
  'Aircraft Mode S Transponder Code',

  // Digital Currency Addresses
  'Digital Currency Address - XBT',
  'Digital Currency Address - TRX',
  'Digital Currency Address - ETH',
  'Digital Currency Address - USDT',
  'Digital Currency Address - LTC',
  'Digital Currency Address - XMR',
  'Digital Currency Address - BCH',
  'Digital Currency Address - DASH',
  'Digital Currency Address - ZEC',
  'Digital Currency Address - SOL',
  'Digital Currency Address - USDC',
  'Digital Currency Address - DOGE',
  'Digital Currency Address - BTG',
  'Digital Currency Address - ETC',
  'Digital Currency Address - BSV',
  'Digital Currency Address - XVG',
  'Digital Currency Address - XRP',
  'Digital Currency Address - ARB',
  'Digital Currency Address - BSC',
  'Digital Currency Address - BNB',
]);

function isAllowedIdType(idType: string): boolean {
  return ALLOWED_US_ID_TYPES.has(idType.trim());
}

function mapEntryToRecord(entry: any): SanctionRecord | null {
  const uid = String(entry.uid ?? '').trim();
  if (!uid) return null;
  if (!SAFE_UID.test(uid)) {
    log.warn('entry.skipped_unsafe_uid', { uid });
    return null;
  }

  const sdnTypeStr = String(entry.sdnType || '').toLowerCase();

  let type: 'individual' | 'entity' | 'vessel' | 'aircraft' = 'entity';
  if (sdnTypeStr === 'individual') type = 'individual';
  else if (sdnTypeStr === 'vessel') type = 'vessel';
  else if (sdnTypeStr === 'aircraft') type = 'aircraft';

  const first = entry.firstName ? String(entry.firstName) : '';
  const last = entry.lastName ? String(entry.lastName) : '';
  const primaryName = first ? `${first} ${last}`.trim() : last.trim();

  // Map aliases (AKA) — each carries a real strong/weak reliability marker
  // (<category>) from the source (issue #168).
  const aliases: string[] = [];
  const strongAliases = new Set<string>();
  for (const aka of toArray(entry.akaList?.aka)) {
    const akaFirst = aka.firstName ? String(aka.firstName) : '';
    const akaLast = aka.lastName ? String(aka.lastName) : '';
    const akaName = akaFirst ? `${akaFirst} ${akaLast}`.trim() : akaLast.trim();
    if (akaName && !aliases.includes(akaName)) {
      aliases.push(akaName);
      if (String(aka.category || '').trim().toLowerCase() === 'strong') {
        strongAliases.add(akaName);
      }
    }
  }

  // Map addresses
  const addresses: Address[] = [];
  for (const addr of toArray(entry.addressList?.address)) {
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

  // Map birth details
  const datesOfBirth: string[] = [];
  for (const dobItem of toArray(entry.dateOfBirthList?.dateOfBirthItem)) {
    if (dobItem.dateOfBirth) {
      datesOfBirth.push(String(dobItem.dateOfBirth));
    }
  }

  const placesOfBirth: string[] = [];
  for (const pobItem of toArray(entry.placeOfBirthList?.placeOfBirthItem)) {
    if (pobItem.placeOfBirth) {
      placesOfBirth.push(String(pobItem.placeOfBirth));
    }
  }

  // Map IDs (passports, national ID, etc.) — issue #46 / #168 / #152
  const identifications: Identification[] = [];
  for (const idItem of toArray(entry.idList?.id)) {
    const num = idItem.idNumber ? String(idItem.idNumber).trim() : '';
    const idType = idItem.idType ? String(idItem.idType).trim() : '';
    const country = idItem.idCountry ? String(idItem.idCountry).trim() : '';
    const expirationRaw = idItem.expirationDate ? String(idItem.expirationDate).trim() : undefined;
    
    if (!num || !idType || !isAllowedIdType(idType)) continue;

    const knownExpired = isExpired(expirationRaw);
    identifications.push({
      number: num,
      typeDescription: idType || undefined,
      countryIso2: country || undefined,
      knownExpired,
    });
  }

  // Map nationality/citizenship (issue #169). OFAC uses plain full-text
  // country names here (e.g. "Saudi Arabia"), not ISO codes, so no
  // placeholder-code filtering like the EU parser's '00'/unknown handling
  // is needed. Both lists feed the same field — the same country can
  // legitimately appear in both (a citizen who is also a national of that
  // country), so dedup across the combined set, not per-list.
  const citizenships: string[] = [];
  for (const nat of toArray(entry.nationalityList?.nationality)) {
    const country = nat.country ? String(nat.country).trim() : '';
    if (country && !citizenships.includes(country)) citizenships.push(country);
  }
  for (const cit of toArray(entry.citizenshipList?.citizenship)) {
    const country = cit.country ? String(cit.country).trim() : '';
    if (country && !citizenships.includes(country)) citizenships.push(country);
  }

  // Map program details as sanction reason
  const programs = toArray(entry.programList?.program).map((p) => String(p));
  const sanctionReason = programs.join(', ');

  // Structured fields from #44/#168. birthDates has no date precision
  // beyond the raw string (this source doesn't distinguish exact/year-only/
  // circa); names/identifications DO carry real reliability markers from
  // the source (category, expirationDate) rather than being invented.
  const birthDates = deriveBirthDates(datesOfBirth);

  const now = new Date().toISOString();

  return {
    id: `US-SDN-${uid}`,
    source: 'US',
    type,
    names: deriveNames(primaryName, aliases, strongAliases),
    searchNames: [], // Generated by uploader
    birthDates: birthDates.length > 0 ? birthDates : undefined,
    placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
    citizenships: citizenships.length > 0 ? citizenships : undefined,
    identifications: identifications.length > 0 ? identifications : undefined,
    addresses: addresses.length > 0 ? addresses : undefined,
    sanctionReason: sanctionReason || undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolves to the number of `sdnEntry` subtrees for which `onRecord` was
 * actually invoked (entries skipped for a missing/unsafe `uid` are not
 * counted) — same contract as `parseEUListStreaming`.
 */
export async function parseUSListStreaming(
  filePath: string,
  onRecord: (record: SanctionRecord) => void | Promise<void>,
): Promise<number> {
  log.info('stream.start', { filePath });
  let emitted = 0;

  await streamXmlRecords(filePath, 'sdnEntry', async (subtree) => {
    const record = mapEntryToRecord(subtree);
    if (!record) return;
    emitted++;
    await onRecord(record);
  });

  if (emitted === 0) {
    log.warn('stream.no_entries_found', { filePath });
  }
  log.info('stream.complete', { filePath, recordCount: emitted });
  return emitted;
}

/**
 * Array-returning form kept for existing callers and tests. Thin wrapper
 * over `parseUSListStreaming`, same relationship as `parseEUList` has to
 * `parseEUListStreaming`.
 */
export async function parseUSList(filePath: string): Promise<SanctionRecord[]> {
  const records: SanctionRecord[] = [];
  await parseUSListStreaming(filePath, (record) => {
    records.push(record);
  });
  return records;
}
