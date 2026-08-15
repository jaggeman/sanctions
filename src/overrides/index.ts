import { SanctionRecord, Override } from '../shared/types';
import { generateSearchTokens } from '../importer/uploader';

// Fields an override must never touch, regardless of what the caller passes.
// `status` doesn't exist on SanctionRecord yet (issue #8), but is blocked
// pre-emptively per the "an override must never resurrect a delisted record"
// gotcha in issue #10 — so the day #8 adds it, this guard already applies.
const IMMUTABLE_KEYS = new Set(['id', 'source', 'type', 'createdAt', 'searchNames', 'status']);

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
