import { db } from '../shared/firebase';
import { SanctionRecord } from '../shared/types';
import { generateSearchTokens } from '../importer/uploader';
import { isValidEntityId } from '../shared/entityId';
import { invalidateSearchIndex } from '../search';

// gRPC status code for ALREADY_EXISTS — what Firestore's DocumentReference.create()
// throws when the document is already present. Any other error rethrows as-is.
const FIRESTORE_ALREADY_EXISTS = 6;

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

  // docRef.create() is Firestore's own atomic "insert if absent" — the
  // existence check and the write happen as one server-side operation, so
  // two concurrent creates for the same id can no longer both pass a
  // separate get() check and both write (TOCTOU, issue #172). Only the
  // ALREADY_EXISTS case gets the friendly message; anything else rethrows.
  try {
    await docRef.create(record);
  } catch (error: any) {
    if (error?.code === FIRESTORE_ALREADY_EXISTS) {
      throw new Error(`A record with id "${input.id}" already exists — cannot create a duplicate custom record.`);
    }
    throw error;
  }

  await invalidateSearchIndex();
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
    // Re-pinned after the patch spread: `patch` originates from an
    // untrusted HTTP body (wired into the API, issue #172), and
    // CustomRecordInput's TS type is not enforced at runtime — a payload
    // could still smuggle these keys in. searchNames is always regenerated
    // from the merged record's own primaryName/aliases rather than left
    // re-pinned only conditionally, so a patch can never set it directly
    // and control what the record matches on.
    id,
    source: 'CUSTOM',
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  merged.searchNames = generateSearchTokens(merged.primaryName, merged.aliases);

  await docRef.set(merged);
  await invalidateSearchIndex();
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
  await invalidateSearchIndex();
}

export async function getCustomRecord(id: string): Promise<SanctionRecord | null> {
  assertValidId(id);
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return doc.data() as SanctionRecord;
}
