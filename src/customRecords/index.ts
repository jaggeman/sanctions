import { db } from '../shared/firebase';
import { SanctionRecord } from '../shared/types';
import { generateSearchTokens } from '../importer/uploader';
import { isValidEntityId } from '../shared/entityId';

function assertValidId(id: string): void {
  if (!isValidEntityId(id)) {
    throw new Error(`Invalid id "${id}" — must contain only letters, numbers, hyphens, and underscores.`);
  }
}

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
  const aliases = input.aliases || [];
  const record: SanctionRecord = {
    ...input,
    aliases,
    source: 'CUSTOM',
    searchNames: generateSearchTokens(input.primaryName, aliases),
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

  const merged: SanctionRecord = {
    ...current,
    ...patch,
    // Re-pinned after the patch spread: `patch` may originate from an
    // untrusted HTTP body once this is wired into the API (deferred, see PR
    // description), and CustomRecordInput's TS type is not enforced at
    // runtime — a payload could still smuggle these keys in.
    id,
    source: 'CUSTOM',
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (patch.primaryName !== undefined || patch.aliases !== undefined) {
    merged.searchNames = generateSearchTokens(merged.primaryName, merged.aliases);
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
