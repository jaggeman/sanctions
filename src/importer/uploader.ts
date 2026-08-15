import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import { db } from '../shared/firebase';
import { SanctionRecord, RecordVersion, ChangeType } from '../shared/types';
import { logger } from '../shared/logger';

const log = logger.child({ module: 'importer.uploader' });

/**
 * Normalizes text to lowercase and removes accents/diacritics for uniform search.
 *
 * issue #40: this used to strip anything outside [a-z0-9\s], which erased
 * Cyrillic/Greek/Arabic/CJK entirely rather than transliterating it — a
 * non-Latin name normalized to '', so even an exact self-match scored 0.
 * `\p{L}`/`\p{N}` (Unicode letter/number categories) keep any script's own
 * letters instead of only ASCII Latin, which alone fixes that: two identical
 * non-Latin strings now normalize identically instead of both collapsing to
 * the empty string. Cross-script matching (e.g. a Latin query finding a
 * Cyrillic-stored name) is handled separately by `transliterate()` below —
 * normalizeText's job is to preserve script, not translate it.
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')  // remove accents
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // replace punctuation with spaces, keep any script's letters
    .replace(/\s+/g, ' ')            // collapse multiple spaces
    .trim();
}

// issue #40, decision (c): transliterate Cyrillic/Greek into the Latin token
// set IN ADDITION TO keeping the original-script token (not instead of it) —
// so a query in either script finds a record stored in the other, without
// forcing same-script lookups through Latin unnecessarily. Arabic is
// explicitly out of scope for this pass: it's a genuinely harder transliteration
// problem (short vowels are usually unwritten, and a naive per-character map
// would produce misleading, not just incomplete, output) — see the PR.
// Deliberately hand-rolled, not a library: matcher.ts already avoids a heavy
// dependency chain to keep Cloud Function cold start down, and this table is
// ~50 entries.
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht',
  ъ: 'a', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Ukrainian-specific letters not already covered above.
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

const GREEK_TO_LATIN: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i',
  κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's',
  ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

const TRANSLITERATION_MAP: Record<string, string> = { ...CYRILLIC_TO_LATIN, ...GREEK_TO_LATIN };

/**
 * Best-effort Cyrillic/Greek → Latin transliteration, character by character.
 * Returns null if nothing in the input maps (pure-Latin text, or a script
 * with no table entry e.g. Arabic/CJK) — callers use that to skip adding a
 * useless duplicate token. Any character with no mapping (including Latin
 * letters already present in mixed-script input) passes through unchanged.
 */
export function transliterate(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

  let result = '';
  let changed = false;
  for (const ch of lower) {
    const mapped = TRANSLITERATION_MAP[ch];
    if (mapped !== undefined) {
      result += mapped;
      changed = true;
    } else {
      result += ch;
    }
  }
  return changed ? result : null;
}

/**
 * Generates search tokens from a primary name and list of aliases.
 * Splits names into individual word tokens.
 *
 * issue #40: also includes a transliterated token for any Cyrillic/Greek
 * name, alongside the original-script token (decision c) — e.g. "Абу Нидал"
 * contributes both "абу"/"нидал" and "abu"/"nidal".
 */
export function generateSearchTokens(primaryName: string, aliases: string[] = []): string[] {
  const allNames = [primaryName, ...aliases];
  const tokenSet = new Set<string>();

  const addTokensFrom = (name: string) => {
    const normalized = normalizeText(name);
    for (const part of normalized.split(' ')) {
      if (part.length >= 2) { // Only index tokens of length 2 or more
        tokenSet.add(part);
      }
    }
  };

  for (const name of allNames) {
    addTokensFrom(name);
    const translit = transliterate(name);
    if (translit) addTokensFrom(translit);
  }

  return Array.from(tokenSet);
}

// Fields excluded from the content hash: status/listedAt/delistedAt are the
// soft-delete lifecycle itself, not content — including them would make every
// relist look like a content "update". createdAt/updatedAt/searchNames are
// derived/bookkeeping, not source content. firstSeenImport/lastSeenImport are
// the same kind of pipeline bookkeeping (issue #68) — nothing sets them yet,
// but the moment something does (e.g. the diff engine stamping
// lastSeenImport per parsed record), including them here would make every
// re-import of an otherwise-unchanged record look "updated."
const CONTENT_HASH_EXCLUDED_FIELDS = new Set([
  'status',
  'listedAt',
  'delistedAt',
  'contentHash',
  'createdAt',
  'updatedAt',
  'searchNames',
  'firstSeenImport',
  'lastSeenImport',
]);

/**
 * Recursively puts a value into a canonical form before hashing (issue #68):
 * object keys sorted, and array elements sorted by their own canonical JSON
 * representation. Without this, the EU FSD export reordering e.g. an
 * entity's <address> or <nameAlias> elements between two otherwise-identical
 * publications would produce a different hash for semantically unchanged
 * content. None of `SanctionRecord`'s array/object fields depend on element
 * order for meaning (aliases, addresses, names, identifications, ... are all
 * unordered collections), so sorting them is safe.
 */
function canonicalize(value: any): any {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((a, b) => {
        const sa = JSON.stringify(a);
        const sb = JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
  }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Strips any `source: 'CUSTOM'` record out of a batch headed for the
 * automated import pipeline (see runImport in ../importer/index.ts). Custom
 * records may only be created/edited through the dedicated customRecords
 * CRUD path (issue #10) — this is a defensive backstop for a mislabeled
 * source column slipping through a parser, since the diff engine (issue #8)
 * that will eventually own this enforcement doesn't exist yet.
 */
export function filterAutomatedBatch(records: SanctionRecord[]): SanctionRecord[] {
  const dropped = records.filter((r) => r.source === 'CUSTOM');
  if (dropped.length > 0) {
    log.warn('batch.custom_records_dropped', {
      count: dropped.length,
      ids: dropped.map((r) => r.id),
    });
  }
  return records.filter((r) => r.source !== 'CUSTOM');
}

/**
 * Deterministic sha256 over a record's content fields only. Two records that
 * differ solely in status/timestamps hash identically, so relisting an
 * unchanged record is never mistaken for a content update.
 */
export function computeContentHash(record: SanctionRecord): string {
  const content: Record<string, any> = {};
  for (const key of Object.keys(record).sort()) {
    if (!CONTENT_HASH_EXCLUDED_FIELDS.has(key)) {
      content[key] = canonicalize((record as any)[key]);
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function generateImportId(): string {
  return `import_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function writeVersion(
  batch: FirebaseFirestore.WriteBatch,
  docRef: FirebaseFirestore.DocumentReference,
  importId: string,
  changeType: ChangeType,
  changedAt: string,
  record: SanctionRecord,
): void {
  const version: RecordVersion = { importId, changedAt, changeType, record };
  batch.set(docRef.collection('versions').doc(importId), version);
}

/**
 * Uploads sanction records to Firestore in batches of 500. Never issues
 * `.delete()` — an imported record is soft-deleted via `delistRecords`
 * instead. Writes a version entry on create/update/relist; an unchanged
 * re-import (identical contentHash, already active) writes nothing.
 */
export async function uploadRecords(records: SanctionRecord[], importId?: string): Promise<void> {
  const collectionRef = db.collection('sanctions');
  const batchSize = 500;
  const effectiveImportId = importId || generateImportId();

  log.info('upload.start', { recordCount: records.length, importId: effectiveImportId });

  for (let i = 0; i < records.length; i += batchSize) {
    const chunk = records.slice(i, i + batchSize);
    const docRefs = chunk.map((record) => collectionRef.doc(record.id));
    const existingDocs = await db.getAll(...docRefs);

    const batch = db.batch();
    const now = new Date().toISOString();

    chunk.forEach((record, idx) => {
      const docRef = docRefs[idx];
      const existingDoc = existingDocs[idx];

      // Add search tokens to the record before saving
      record.searchNames = generateSearchTokens(record.primaryName, record.aliases);
      record.contentHash = computeContentHash(record);

      let changeType: ChangeType | null;

      if (!existingDoc.exists) {
        record.status = 'active';
        record.listedAt = now;
        record.updatedAt = now;
        changeType = 'created';
      } else {
        const existing = existingDoc.data() as SanctionRecord;
        const wasDelisted = existing.status === 'delisted';
        const contentChanged = existing.contentHash !== record.contentHash;

        record.status = 'active';

        if (wasDelisted) {
          changeType = 'relisted';
          record.listedAt = existing.listedAt || now; // preserve first-listed date
          record.updatedAt = now;
        } else if (contentChanged) {
          changeType = 'updated';
          record.listedAt = existing.listedAt || now; // preserve first-listed date
          record.updatedAt = now;
        } else {
          // Truly unchanged (issue #68): don't let updatedAt/listedAt drift
          // forward on every import run just because the record was
          // re-uploaded — that would contradict "an unchanged re-import
          // writes nothing" above and silently corrupt listedAt for legacy
          // records that never had one stored (it would otherwise reset to
          // "today" on every re-import until the first real content change
          // happened to lock it in).
          changeType = null;
          record.listedAt = existing.listedAt;
          record.updatedAt = existing.updatedAt;
        }
      }

      if (changeType) {
        // Clear delistedAt on relist by omitting it from the merged write and
        // explicitly deleting any existing value.
        const toWrite: any = { ...record };
        if (changeType === 'relisted') {
          toWrite.delistedAt = admin.firestore.FieldValue.delete();
        }
        batch.set(docRef, toWrite, { merge: true });
        writeVersion(batch, docRef, effectiveImportId, changeType, now, record);
      }
      // changeType === null: truly unchanged (issue #108) — the docstring
      // above says this case "writes nothing," so it must not, not even a
      // same-data merge. record's in-memory contentHash/searchNames were
      // already recomputed above for this batch's own bookkeeping, but
      // nothing about the stored doc actually needs to change.
    });

    await batch.commit();
    log.info('upload.batch_committed', {
      importId: effectiveImportId,
      batchNumber: Math.floor(i / batchSize) + 1,
      totalBatches: Math.ceil(records.length / batchSize),
      batchSize: chunk.length,
    });
  }

  log.info('upload.complete', { importId: effectiveImportId, recordCount: records.length });
}

/**
 * Soft-deletes records by id: flips status to 'delisted', stamps
 * delistedAt, and writes a 'delisted' version entry. Never calls
 * `.delete()`. A no-op for ids that don't exist or are already delisted (no
 * version entry is written for those).
 *
 * This is the primitive the diff engine (issue #8) will call once it exists
 * with "records missing from this import" — issue #9 only builds the
 * primitive, not the comparison logic that decides which ids to pass in.
 */
export async function delistRecords(ids: string[], importId?: string): Promise<void> {
  if (ids.length === 0) return;

  const collectionRef = db.collection('sanctions');
  const batchSize = 500;
  const effectiveImportId = importId || generateImportId();
  const now = new Date().toISOString();

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunkIds = ids.slice(i, i + batchSize);
    const docRefs = chunkIds.map((id) => collectionRef.doc(id));
    const existingDocs = await db.getAll(...docRefs);

    const batch = db.batch();

    existingDocs.forEach((doc, idx) => {
      if (!doc.exists) return;
      const existing = doc.data() as SanctionRecord;
      if (existing.status === 'delisted') return; // already delisted, no-op

      const docRef = docRefs[idx];
      const delisted: SanctionRecord = { ...existing, status: 'delisted', delistedAt: now, updatedAt: now };

      batch.set(docRef, { status: 'delisted', delistedAt: now, updatedAt: now }, { merge: true });
      writeVersion(batch, docRef, effectiveImportId, 'delisted', now, delisted);
    });

    await batch.commit();
  }
}

/**
 * Returns a record's full version trail, newest first (issue #12 — record
 * detail view). Empty array if the record has no version history (or
 * doesn't exist) — callers that need to distinguish "no history" from
 * "no such record" should check the record itself first.
 */
export async function listRecordVersions(id: string): Promise<RecordVersion[]> {
  const snapshot = await db.collection('sanctions').doc(id).collection('versions').orderBy('changedAt', 'desc').get();
  return snapshot.docs.map((doc: any) => doc.data() as RecordVersion);
}
