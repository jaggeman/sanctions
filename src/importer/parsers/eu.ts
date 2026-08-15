import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs-extra';
import { SanctionRecord, Address } from '../../shared/types';

/**
 * Parser for the EU Financial Sanctions Database (FSD) consolidated export,
 * schema version 1.1.
 *
 * The one thing to know before editing: in this format essentially all the data
 * lives in XML *attributes*, not child elements. A `<nameAlias>` carries
 * `wholeName="..."` as an attribute; there is no `<wholeName>` child. Reading it
 * as an element silently yields `undefined` rather than throwing, which is how
 * this parser previously produced 6 234 nameless records from a valid file.
 *
 * Reference sample: tests/fixtures/eu_sample.xml (carved from the real export).
 */

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/** Read `name` from a node, preferring the attribute form and falling back to a child element. */
function attr(node: any, name: string): string {
  if (!node) return '';
  const raw = node[`@_${name}`] ?? node[name];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

function bool(node: any, name: string): boolean {
  const raw = attr(node, name).toLowerCase();
  return raw === 'true' || raw === '1';
}

/**
 * The source uses '-' and 'UNKNOWN' as placeholders for "not stated".
 * Treat them as absent rather than rendering them to users.
 */
const PLACEHOLDERS = new Set(['', '-', '--', 'unknown']);
function meaningful(value: string): string {
  return PLACEHOLDERS.has(value.toLowerCase()) ? '' : value;
}

/**
 * Country fields additionally use the ISO code '00' for unknown. Kept separate
 * from `meaningful` so a legitimate '00' elsewhere (a postcode, a document
 * number) is not silently dropped.
 */
function meaningfulCountry(value: string): string {
  return value === '00' ? '' : meaningful(value);
}

/**
 * `logicalId` becomes a Firestore document ID. It arrives from a user-uploaded
 * file, so it is validated rather than trusted: a value containing '/' would
 * otherwise turn `EU-<id>` into a nested collection path.
 */
const SAFE_LOGICAL_ID = /^[A-Za-z0-9._-]{1,200}$/;

interface AliasCandidate {
  wholeName: string;
  hasNameParts: boolean;
  isStrong: boolean;
  isPreferredLanguage: boolean;
}

/** Language tags treated as the canonical rendering of a name. */
const PREFERRED_LANGUAGES = new Set(['', 'en']);

function collectAliases(entry: any): AliasCandidate[] {
  const seen = new Set<string>();
  const candidates: AliasCandidate[] = [];

  for (const node of toArray(entry.nameAlias)) {
    const whole = attr(node, 'wholeName');
    const first = attr(node, 'firstName');
    const middle = attr(node, 'middleName');
    const last = attr(node, 'lastName');

    const wholeName = whole || [first, middle, last].filter(Boolean).join(' ').trim();
    if (!wholeName || seen.has(wholeName)) continue;
    seen.add(wholeName);

    candidates.push({
      wholeName,
      // A structured first/last pair marks the canonical designation rather than
      // a transliteration, which is the most reliable primary-name signal here.
      hasNameParts: Boolean(first && last),
      isStrong: bool(node, 'strong'),
      isPreferredLanguage: PREFERRED_LANGUAGES.has(attr(node, 'nameLanguage').toLowerCase()),
    });
  }

  return candidates;
}

/**
 * Pick the primary name deterministically.
 *
 * There is no `primary` attribute in this schema, so selection is by successive
 * narrowing: strong names, then those with structured name parts, then those in
 * a preferred language. Each filter is skipped when it would eliminate every
 * remaining candidate. Document order breaks the final tie, so the same input
 * always yields the same primary name.
 */
function selectPrimary(candidates: AliasCandidate[]): number {
  let pool = candidates.map((_, i) => i);

  const narrow = (predicate: (c: AliasCandidate) => boolean) => {
    const next = pool.filter((i) => predicate(candidates[i]));
    if (next.length > 0) pool = next;
  };

  narrow((c) => c.isStrong);
  narrow((c) => c.hasNameParts);
  narrow((c) => c.isPreferredLanguage);

  return pool[0];
}

function parseAddresses(entry: any): Address[] {
  const addresses: Address[] = [];

  for (const node of toArray(entry.address)) {
    const street = meaningful(attr(node, 'street'));
    const city = meaningful(attr(node, 'city'));
    const zip = meaningful(attr(node, 'zipCode'));
    const poBox = meaningful(attr(node, 'poBox'));
    const region = meaningful(attr(node, 'region'));
    const place = meaningful(attr(node, 'place'));
    const country =
      meaningfulCountry(attr(node, 'countryDescription')) || meaningfulCountry(attr(node, 'countryIso2Code'));

    const fullAddress = [street, poBox, place, city, region, zip, country]
      .filter(Boolean)
      .join(', ');

    // The export contains address nodes whose every field is empty. Emitting an
    // object of undefineds for those just adds noise to the record.
    if (!fullAddress) continue;

    addresses.push({
      street: street || undefined,
      city: city || undefined,
      country: country || undefined,
      fullAddress,
    });
  }

  return addresses;
}

function parseBirthdates(entry: any): { dates: string[]; places: string[] } {
  const dates: string[] = [];
  const places: string[] = [];

  for (const node of toArray(entry.birthdate)) {
    // Prefer the full date; fall back to the year, which the source often gives
    // on its own. Year ranges and `circa` need the richer model in issue #6.
    const date = meaningful(attr(node, 'birthdate')) || meaningful(attr(node, 'year'));
    if (date && !dates.includes(date)) dates.push(date);

    const city = meaningful(attr(node, 'city'));
    const place = meaningful(attr(node, 'place'));
    const region = meaningful(attr(node, 'region'));
    const country =
      meaningfulCountry(attr(node, 'countryDescription')) || meaningfulCountry(attr(node, 'countryIso2Code'));

    const pob = [city, place, region, country].filter(Boolean).join(', ');
    if (pob && !places.includes(pob)) places.push(pob);
  }

  return { dates, places };
}

function parseIdentifications(entry: any): string[] {
  const out: string[] = [];

  for (const node of toArray(entry.identification)) {
    const number = meaningful(attr(node, 'number')) || meaningful(attr(node, 'latinNumber'));
    if (!number) continue;

    const description =
      meaningful(attr(node, 'identificationTypeDescription')) ||
      meaningful(attr(node, 'identificationTypeCode'));
    const country = meaningfulCountry(attr(node, 'countryDescription'));

    // Flag documents the source itself marks as unreliable, so a match against
    // one is not mistaken for a match against a valid document.
    const caveats = [
      bool(node, 'knownFalse') && 'known false',
      bool(node, 'knownExpired') && 'expired',
      bool(node, 'reportedLost') && 'reported lost',
      bool(node, 'revokedByIssuer') && 'revoked',
    ].filter(Boolean) as string[];

    let entryText = description ? `${description} ${number}` : String(number);
    if (country) entryText += ` (${country})`;
    if (caveats.length > 0) entryText += ` [${caveats.join(', ')}]`;

    if (!out.includes(entryText)) out.push(entryText);
  }

  return out;
}

export async function parseEUList(filePath: string): Promise<SanctionRecord[]> {
  console.log(`Parsing EU sanctions list from ${filePath}...`);
  const xmlContent = await fs.readFile(filePath, 'utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    // Deliberately off: attribute coercion turns a passport number such as
    // "007123" into 7123 and "1965" into a number, corrupting identifiers.
    // Everything is read as text and converted explicitly instead.
    parseAttributeValue: false,
    trimValues: true,
    // The real export declares a default namespace (xmlns=...), but other
    // renderings use a prefix. Stripping prefixes handles both.
    removeNSPrefix: true,
  });

  const parsed = parser.parse(xmlContent);
  const sanctionEntities = parsed.export?.sanctionEntity;

  if (!sanctionEntities) {
    console.warn('No sanctionEntity found in EU XML file.');
    return [];
  }

  const records: SanctionRecord[] = [];

  for (const entry of toArray(sanctionEntities)) {
    const logicalId = attr(entry, 'logicalId');
    if (!logicalId) continue;
    if (!SAFE_LOGICAL_ID.test(logicalId)) {
      console.warn(`Skipping EU entity with unsafe logicalId: ${JSON.stringify(logicalId)}`);
      continue;
    }

    // subjectType is code="person" | "enterprise" (classificationCode P | E).
    const subjectCode = attr(entry.subjectType, 'code').toLowerCase();
    const classification = attr(entry.subjectType, 'classificationCode').toUpperCase();
    const isPerson = subjectCode === 'person' || (!subjectCode && classification === 'P');
    const type: SanctionRecord['type'] = isPerson ? 'individual' : 'entity';

    const candidates = collectAliases(entry);
    let primaryName = 'Unknown Name';
    let aliases: string[] = [];

    if (candidates.length > 0) {
      const primaryIndex = selectPrimary(candidates);
      primaryName = candidates[primaryIndex].wholeName;
      aliases = candidates.filter((_, i) => i !== primaryIndex).map((c) => c.wholeName);
    }

    const addresses = parseAddresses(entry);
    const { dates: datesOfBirth, places: placesOfBirth } = parseBirthdates(entry);
    const passports = parseIdentifications(entry);

    const citizenships: string[] = [];
    for (const node of toArray(entry.citizenship)) {
      const country =
        meaningfulCountry(attr(node, 'countryDescription')) || meaningfulCountry(attr(node, 'countryIso2Code'));
      if (country && !citizenships.includes(country)) citizenships.push(country);
    }

    const sanctionReason =
      attr(entry.regulation, 'numberTitle') || attr(entry.regulationSummary, 'numberTitle');
    const legalBasis =
      attr(entry.regulation, 'publicationUrl') || attr(entry.regulationSummary, 'publicationUrl');

    const now = new Date().toISOString();

    records.push({
      id: `EU-${logicalId}`,
      source: 'EU',
      type,
      primaryName,
      aliases,
      searchNames: [], // Generated by uploader
      datesOfBirth: datesOfBirth.length > 0 ? datesOfBirth : undefined,
      placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
      citizenships: citizenships.length > 0 ? citizenships : undefined,
      passports: passports.length > 0 ? passports : undefined,
      addresses: addresses.length > 0 ? addresses : undefined,
      sanctionReason: sanctionReason || undefined,
      legalBasis: legalBasis || undefined,
      rawSourceData: entry,
      createdAt: now,
      updatedAt: now,
    });
  }

  console.log(`Parsed ${records.length} EU records.`);
  return records;
}
