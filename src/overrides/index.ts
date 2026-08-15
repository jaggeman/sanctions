import { db } from '../shared/firebase';
import { SanctionRecord, Override } from '../shared/types';
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

  await db.collection(COLLECTION).doc(entityId).set(override);
  return override;
}

/** Removes the override for an entity. Idempotent — no error if none exists. */
export async function deleteOverride(entityId: string): Promise<void> {
  await db.collection(COLLECTION).doc(entityId).delete();
}
