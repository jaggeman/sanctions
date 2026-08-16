import { SanctionRecord, Address, Identification, NameAlias, BirthDate } from '../../shared/types';
import { streamXmlRecords } from './xmlSubtreeStream';
import { logger } from '../../shared/logger';

const log = logger.child({ module: 'importer.parsers.uk' });

/**
 * Parser for the UK Sanctions List (FCDO), issue #99.
 *
 * Streamed via the shared `streamXmlRecords` engine (built for issue #31,
 * already reused by `us.ts`) rather than fast-xml-parser's `XMLParser` —
 * the real export is ~22 MB, in the same class as EU/US, and this engine
 * builds element text as plain trimmed strings, never coercing to a number.
 * That matters here specifically: real `PassportNumber`,
 * `NationalIdentifierNumber` and `AddressPostalCode` values in the production
 * data have genuine leading zeros (verified directly against the real
 * cached export) — the same class of bug issue #34 fixed for `un.ts`. Using
 * this engine from the start means it never has a chance to regress here.
 *
 * Reference sample: tests/fixtures/uk_sample.xml (four real records carved
 * from the actual export, plus one synthetic no-id edge case).
 */

function toArray(val: any): any[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function str(val: any): string {
  return val === undefined || val === null ? '' : String(val).trim();
}

/**
 * `UniqueID` becomes part of a Firestore document ID (`UK-<UniqueID>`). It
 * arrives from a downloaded file, so it's validated rather than trusted —
 * the same gap the EU parser closed in issue #5 for `logicalId`.
 */
const SAFE_UNIQUE_ID = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * `NameType` casing is inconsistent in the real production data — "Primary
 * Name" (3 982 occurrences), "Primary name" (2 358), "Primary Name
 * Variation" (3 011), "Primary name variation" (2 502), "Alias" (3 818),
 * even "ALias" (1, a typo). A case-sensitive match would silently
 * misclassify roughly 4 861 real records. Matching case-insensitively, and
 * treating only the exact (case-insensitive) "primary name" as the single
 * canonical name — "primary name variation" is a real alternate rendering,
 * not the chosen primary, so it's collected as an alias like any other.
 */
function isPrimaryNameType(nameType: string): boolean {
  return nameType.trim().toLowerCase() === 'primary name';
}

/** Build a whole name from the positional Name1..Name6 parts, in order. */
function buildWholeName(node: any): string {
  return [node.Name1, node.Name2, node.Name3, node.Name4, node.Name5, node.Name6]
    .map((n) => str(n))
    .filter(Boolean)
    .join(' ')
    .trim();
}

interface NameCandidate {
  wholeName: string;
  isPrimary: boolean;
}

function collectNames(designation: any): NameCandidate[] {
  const seen = new Set<string>();
  const candidates: NameCandidate[] = [];

  for (const node of toArray(designation.Names?.Name)) {
    const wholeName = buildWholeName(node);
    if (!wholeName || seen.has(wholeName)) continue;
    seen.add(wholeName);
    candidates.push({ wholeName, isPrimary: isPrimaryNameType(str(node.NameType)) });
  }

  // Non-Latin script renderings (e.g. Arabic, Cyrillic) — real, additional
  // names for the same person/entity, not translations to discard.
  for (const node of toArray(designation.NonLatinNames?.NonLatinName)) {
    const wholeName = str(node.NameNonLatinScript);
    if (!wholeName || seen.has(wholeName)) continue;
    seen.add(wholeName);
    candidates.push({ wholeName, isPrimary: false });
  }

  return candidates;
}

/**
 * Real `<DOB>` values are one of two shapes: a placeholder like
 * "dd/mm/1945" (day/month genuinely unknown, only the year is real) or a
 * full "DD/MM/YYYY" date. Never US MM/DD — this is a UK source.
 */
const DOB_PLACEHOLDER = /^dd\/mm\/(\d{4})$/i;
const DOB_FULL = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function parseDob(raw: string): BirthDate | null {
  const placeholder = DOB_PLACEHOLDER.exec(raw);
  if (placeholder) {
    return { year: parseInt(placeholder[1], 10) };
  }

  const full = DOB_FULL.exec(raw);
  if (full) {
    const [, dd, mm, yyyy] = full;
    return {
      raw: `${yyyy}-${mm}-${dd}`,
      day: parseInt(dd, 10),
      month: parseInt(mm, 10),
      year: parseInt(yyyy, 10),
    };
  }

  return null;
}

function parseBirthDates(individual: any): BirthDate[] {
  const out: BirthDate[] = [];
  const seen = new Set<string>();

  for (const dobNode of toArray(individual.DOBs?.DOB)) {
    const raw = str(dobNode);
    if (!raw) continue;
    const parsed = parseDob(raw);
    if (!parsed) continue;
    const key = parsed.raw ?? `year:${parsed.year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }

  return out;
}

function parsePlacesOfBirth(individual: any): string[] {
  const places: string[] = [];
  for (const loc of toArray(individual.BirthDetails?.Location)) {
    const town = str(loc.TownOfBirth);
    const country = str(loc.CountryOfBirth);
    const place = [town, country].filter(Boolean).join(', ');
    if (place && !places.includes(place)) places.push(place);
  }
  return places;
}

function parseAddresses(designation: any): Address[] {
  const addresses: Address[] = [];

  for (const node of toArray(designation.Addresses?.Address)) {
    const lines = [node.AddressLine1, node.AddressLine2, node.AddressLine3, node.AddressLine4, node.AddressLine5, node.AddressLine6]
      .map((l) => str(l))
      .filter(Boolean);
    const postalCode = str(node.AddressPostalCode);
    const country = str(node.AddressCountry);

    const fullParts = [...lines, postalCode, country].filter(Boolean);
    if (fullParts.length === 0) continue;

    addresses.push({
      street: lines.length > 0 ? lines.join(', ') : undefined,
      country: country || undefined,
      fullAddress: fullParts.join(', '),
    });
  }

  return addresses;
}

/**
 * Structured identifications: passports, national identifier numbers, and
 * (for a ship) IMO numbers. Every number is read as text — never coerced —
 * to preserve genuine leading zeros seen in the real data.
 */
function parseIdentifications(individual: any, ship: any): Identification[] {
  const out: Identification[] = [];

  for (const p of toArray(individual?.PassportDetails?.Passport)) {
    const number = str(p.PassportNumber);
    if (!number) continue;
    out.push({ number, typeDescription: 'Passport' });
  }

  for (const n of toArray(individual?.NationalIdentifierDetails?.NationalIdentifier)) {
    const number = str(n.NationalIdentifierNumber);
    if (!number) continue;
    out.push({ number, typeDescription: 'National Identifier' });
  }

  for (const imo of toArray(ship?.IMONumbers?.IMONumber)) {
    const number = str(imo);
    if (!number) continue;
    out.push({ number, typeDescription: 'IMO Number' });
  }

  return out;
}

function mapDesignationToRecord(designation: any): SanctionRecord | null {
  const uniqueId = str(designation.UniqueID);
  if (!uniqueId) return null;
  if (!SAFE_UNIQUE_ID.test(uniqueId)) {
    log.warn('designation.skipped_unsafe_unique_id', { uniqueId });
    return null;
  }

  const shipOrEntityOrIndividual = str(designation.IndividualEntityShip).toLowerCase();
  let type: SanctionRecord['type'] = 'entity';
  if (shipOrEntityOrIndividual === 'individual') type = 'individual';
  else if (shipOrEntityOrIndividual === 'ship') type = 'vessel';

  const candidates = collectNames(designation);
  // issue #46: array order encodes primary-ness — the chosen candidate goes
  // first, mirroring the EU parser's selectPrimary()-then-reorder pattern.
  let names: NameAlias[];
  if (candidates.length > 0) {
    const primaryIndex = candidates.findIndex((c) => c.isPrimary);
    const chosenIndex = primaryIndex === -1 ? 0 : primaryIndex;
    const toNameAlias = (c: NameCandidate): NameAlias => ({ wholeName: c.wholeName, strong: c.isPrimary });
    names = [
      toNameAlias(candidates[chosenIndex]),
      ...candidates.filter((_, i) => i !== chosenIndex).map(toNameAlias),
    ];
  } else {
    names = [{ wholeName: 'Unknown Name', strong: false }];
  }

  const individual = designation.IndividualDetails?.Individual;
  const ship = designation.ShipDetails?.Ship;

  const birthDates = parseBirthDates(individual || {});
  const placesOfBirth = parsePlacesOfBirth(individual || {});
  const addresses = parseAddresses(designation);
  const identifications = parseIdentifications(individual, ship);

  const citizenships: string[] = [];
  for (const nat of toArray(individual?.Nationalities?.Nationality)) {
    const country = str(nat);
    if (country && !citizenships.includes(country)) citizenships.push(country);
  }

  const now = new Date().toISOString();

  return {
    id: `UK-${uniqueId}`,
    source: 'UK',
    type,
    names,
    searchNames: [], // Generated by uploader
    birthDates: birthDates.length > 0 ? birthDates : undefined,
    placesOfBirth: placesOfBirth.length > 0 ? placesOfBirth : undefined,
    citizenships: citizenships.length > 0 ? citizenships : undefined,
    identifications: identifications.length > 0 ? identifications : undefined,
    addresses: addresses.length > 0 ? addresses : undefined,
    sanctionReason: str(designation.OtherInformation) || undefined,
    legalBasis: str(designation.RegimeName) || undefined,
    unitedNationId: str(designation.UNReferenceNumber) || undefined,
    sourceRef: uniqueId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolves to the number of `Designation` subtrees for which `onRecord` was
 * actually invoked (designations skipped for a missing/unsafe `UniqueID`
 * are not counted) — same contract as `parseUSListStreaming`.
 */
export async function parseUKListStreaming(
  filePath: string,
  onRecord: (record: SanctionRecord) => void | Promise<void>,
): Promise<number> {
  log.info('stream.start', { filePath });
  let emitted = 0;

  await streamXmlRecords(filePath, 'Designation', async (subtree) => {
    const record = mapDesignationToRecord(subtree);
    if (!record) return;
    emitted++;
    await onRecord(record);
  });

  if (emitted === 0) {
    log.warn('stream.no_designations_found', { filePath });
  }
  log.info('stream.complete', { filePath, recordCount: emitted });
  return emitted;
}

/**
 * Array-returning form kept for existing callers and tests. Thin wrapper
 * over `parseUKListStreaming`, same relationship as `parseUSList` has to
 * `parseUSListStreaming`.
 */
export async function parseUKList(filePath: string): Promise<SanctionRecord[]> {
  const records: SanctionRecord[] = [];
  await parseUKListStreaming(filePath, (record) => {
    records.push(record);
  });
  return records;
}
