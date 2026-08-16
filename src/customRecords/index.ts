import { db } from '../shared/firebase';
import { SanctionRecord, NameAlias, BirthDate, Identification, primaryNameOf, aliasNamesOf } from '../shared/types';
import { generateSearchTokens } from '../importer/uploader';
import { isValidEntityId } from '../shared/entityId';

function assertValidId(id: string): void {
  if (!isValidEntityId(id)) {
    throw new Error(`Invalid id "${id}" — must contain only letters, numbers, hyphens, and underscores.`);
  }
}

// Kept as simple flat strings on the input shape — a much easier surface
// for whoever creates a custom record (an admin UI or CLI, not a parser) than
// asking them to hand-build NameAlias[]/BirthDate[]/Identification[]. Converted
// to the structured SanctionRecord fields below (issue #46: SanctionRecord
// itself no longer has flat fields to pass these straight through onto).
export interface CustomRecordInput {
  id: string;
  type: SanctionRecord['type'];
  primaryName: string;
  aliases?: string[];
  firstNames?: string[];
  lastNames?: string[];
  titles?: string[];
  datesOfBirth?: string[];
  placesOfBirth?: string[];
  citizenships?: string[];
  passports?: string[];
  addresses?: SanctionRecord['addresses'];
  sanctionReason?: string;
  legalBasis?: string;
}

function namesFrom(primaryName: string, aliases: string[] = []): NameAlias[] {
  return [
    { wholeName: primaryName, strong: true },
    ...aliases.map((wholeName): NameAlias => ({ wholeName, strong: false })),
  ];
}

function birthDatesFrom(datesOfBirth: string[] = []): BirthDate[] {
  return datesOfBirth.map((raw) => {
    const year = /^\d{4}$/.test(raw) ? parseInt(raw, 10) : undefined;
    return { raw, year };
  });
}

function identificationsFrom(passports: string[] = []): Identification[] {
  return passports.map((number) => ({ number }));
}

const COLLECTION = 'sanctions';

/**
 * Creates a `source: 'CUSTOM'` record — internal watchlist entries or local
 * PEPs the official lists don't cover. Never touched by any automated import
 * (see src/importer/index.ts), so this is the only path that may create one.
 */
export async function createCustomRecord(input: CustomRecordInput): Promise<SanctionRecord> {
  assertValidId(input.id);
  const docRef = db.collection(COLLECTION).doc(input.id);
  const existing = await docRef.get();
  if (existing.exists) {
    throw new Error(`A record with id "${input.id}" already exists — cannot create a duplicate custom record.`);
  }

  const now = new Date().toISOString();
  const names = namesFrom(input.primaryName, input.aliases);
  const record: SanctionRecord = {
    id: input.id,
    type: input.type,
    source: 'CUSTOM',
    names,
    searchNames: generateSearchTokens(names),
    firstNames: input.firstNames,
    lastNames: input.lastNames,
    titles: input.titles,
    birthDates: input.datesOfBirth ? birthDatesFrom(input.datesOfBirth) : undefined,
    placesOfBirth: input.placesOfBirth,
    citizenships: input.citizenships,
    identifications: input.passports ? identificationsFrom(input.passports) : undefined,
    addresses: input.addresses,
    sanctionReason: input.sanctionReason,
    legalBasis: input.legalBasis,
    createdAt: now,
    updatedAt: now,
  };

  await docRef.set(record);
  return record;
}

export async function updateCustomRecord(
  id: string,
  patch: Partial<CustomRecordInput>,
): Promise<SanctionRecord> {
  assertValidId(id);
  const docRef = db.collection(COLLECTION).doc(id);
  const existing = await docRef.get();
  if (!existing.exists) {
    throw new Error(`No custom record found with id "${id}".`);
  }

  const current = existing.data() as SanctionRecord;
  if (current.source !== 'CUSTOM') {
    throw new Error(`Record "${id}" is not a custom record (source: ${current.source}) — use the overrides path instead.`);
  }

  // patch's fields don't map 1:1 onto SanctionRecord's keys any more
  // (primaryName/aliases -> names, datesOfBirth -> birthDates, passports ->
  // identifications), so each is applied explicitly rather than spread —
  // also safer given patch may originate from an untrusted HTTP body once
  // this is wired into the API (deferred, see PR description), and
  // CustomRecordInput's TS type is not enforced at runtime.
  const namesChanged = patch.primaryName !== undefined || patch.aliases !== undefined;
  const names = namesChanged
    ? namesFrom(patch.primaryName ?? primaryNameOf(current.names), patch.aliases ?? aliasNamesOf(current.names))
    : current.names;

  const merged: SanctionRecord = {
    ...current,
    id,
    source: 'CUSTOM',
    names,
    firstNames: patch.firstNames ?? current.firstNames,
    lastNames: patch.lastNames ?? current.lastNames,
    titles: patch.titles ?? current.titles,
    birthDates: patch.datesOfBirth !== undefined ? birthDatesFrom(patch.datesOfBirth) : current.birthDates,
    placesOfBirth: patch.placesOfBirth ?? current.placesOfBirth,
    citizenships: patch.citizenships ?? current.citizenships,
    identifications: patch.passports !== undefined ? identificationsFrom(patch.passports) : current.identifications,
    addresses: patch.addresses ?? current.addresses,
    sanctionReason: patch.sanctionReason ?? current.sanctionReason,
    legalBasis: patch.legalBasis ?? current.legalBasis,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (namesChanged) {
    merged.searchNames = generateSearchTokens(merged.names);
  }

  await docRef.set(merged);
  return merged;
}

export async function deleteCustomRecord(id: string, options: { confirm: boolean }): Promise<void> {
  assertValidId(id);
  if (!options?.confirm) {
    throw new Error('Deleting a custom record requires explicit confirm: true.');
  }

  const docRef = db.collection(COLLECTION).doc(id);
  const existing = await docRef.get();
  if (!existing.exists) {
    throw new Error(`No custom record found with id "${id}".`);
  }

  const current = existing.data() as SanctionRecord;
  if (current.source !== 'CUSTOM') {
    throw new Error(`Record "${id}" is not a custom record (source: ${current.source}) — refusing to delete a non-custom record via this path.`);
  }

  await docRef.delete();
}

export async function getCustomRecord(id: string): Promise<SanctionRecord | null> {
  assertValidId(id);
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return doc.data() as SanctionRecord;
}
