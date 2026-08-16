import { db } from '../shared/firebase';
import { SanctionRecord, Override, OverrideChangeType, OverrideHistoryEntry } from '../shared/types';
import { generateSearchTokens } from '../importer/uploader';

const COLLECTION = 'overrides';

// Fields an override must never touch, regardless of what the caller passes.
// `status` is real now (issue #9's RecordStatus) — this is what stops an
// override from resurrecting a delisted record, per issue #35's acceptance
// criterion. Exported so the CRUD route (src/api/routes/overrides.ts) can
// reject a write attempt at these keys with a clear 400 instead of silently
// dropping them only at read time.
export const IMMUTABLE_KEYS = new Set(['id', 'source', 'type', 'createdAt', 'searchNames', 'status']);

export interface ApplyOverrideResult {
  record: SanctionRecord;
  overriddenFields: string[];
}

/**
 * Merges a sparse override on top of an imported record for display/read
 * purposes only. The source record passed in is never mutated, which is what
 * makes an override reversible: removing it just means calling this with
 * `null` again, and the original imported values come back exactly.
 */
export function applyOverride(
  record: SanctionRecord,
  override: Override | null | undefined,
): ApplyOverrideResult {
  if (!override || !override.fields) {
    return { record, overriddenFields: [] };
  }

  const merged: SanctionRecord = { ...record };
  const overriddenFields: string[] = [];

  for (const [key, value] of Object.entries(override.fields)) {
    if (IMMUTABLE_KEYS.has(key) || value === undefined) continue;
    (merged as any)[key] = value;
    overriddenFields.push(key);
  }

  if (overriddenFields.includes('primaryName') || overriddenFields.includes('aliases')) {
    merged.searchNames = generateSearchTokens(merged.primaryName, merged.aliases);
  }

  return { record: merged, overriddenFields };
}

/** Fetches the override for an entity, or null if none exists. */
export async function getOverride(entityId: string): Promise<Override | null> {
  const doc = await db.collection(COLLECTION).doc(entityId).get();
  return doc.exists ? (doc.data() as Override) : null;
}

/**
 * Creates or replaces the override for an entity (upsert, not a field-level
 * merge — a new call fully replaces the previous fields/reason/author).
 */
export async function saveOverride(
  entityId: string,
  fields: Override['fields'],
  meta: { overriddenBy: string; reason: string },
): Promise<Override> {
  const override: Override = {
    entityId,
    fields,
    overriddenBy: meta.overriddenBy,
    overriddenAt: new Date().toISOString(),
    reason: meta.reason,
  };

  const docRef = db.collection(COLLECTION).doc(entityId);
  const existing = await docRef.get();
  const changeType: OverrideChangeType = existing.exists ? 'replaced' : 'created';

  await docRef.set(override);

  // Append-only history (issue #112) — the current-state doc above is a
  // plain upsert (a second correction is the normal case, not an error),
  // but the prior fields/author/reason must stay recoverable rather than
  // silently overwritten. Written after the primary doc: if this write
  // fails, current-state reads are still correct, just missing one
  // history entry, which is the higher-priority guarantee.
  const historyEntry: OverrideHistoryEntry = {
    changeType,
    changedAt: override.overriddenAt,
    changedBy: override.overriddenBy,
    override,
  };
  await docRef.collection('history').doc().set(historyEntry);

  return override;
}

/**
 * Removes the override for an entity. Idempotent — no error, and no history
 * entry, if none exists (nothing real happened, nothing to record).
 * `deletedBy` records who removed it (issue #112) — the stored record
 * itself was never touched, so removing an override is not a destructive
 * action for the sanctions data, but it is one for the override's own
 * audit trail, and that shouldn't vanish silently.
 */
export async function deleteOverride(entityId: string, deletedBy: string): Promise<void> {
  const docRef = db.collection(COLLECTION).doc(entityId);
  const existing = await docRef.get();
  if (!existing.exists) return;

  const removedOverride = existing.data() as Override;
  await docRef.delete();

  // Firestore does not cascade-delete subcollections when a parent doc is
  // deleted, so writing to `history` right after `.delete()` is safe — the
  // subcollection lives on even though the parent doc no longer "exists".
  const historyEntry: OverrideHistoryEntry = {
    changeType: 'deleted',
    changedAt: new Date().toISOString(),
    changedBy: deletedBy,
    override: removedOverride,
  };
  await docRef.collection('history').doc().set(historyEntry);
}

/**
 * Full change history for an entity, most recent first — every prior
 * correction and the deletion event itself, none of which `saveOverride`'s
 * upsert or `deleteOverride`'s removal leave any other trace of (issue #112).
 */
export async function getOverrideHistory(entityId: string): Promise<OverrideHistoryEntry[]> {
  const snapshot = await db.collection(COLLECTION).doc(entityId).collection('history').orderBy('changedAt', 'desc').get();
  return snapshot.docs.map((doc: any) => doc.data() as OverrideHistoryEntry);
}
