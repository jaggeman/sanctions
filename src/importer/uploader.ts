import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import { db } from '../shared/firebase';
import { SanctionRecord, RecordVersion, ChangeType } from '../shared/types';

/**
 * Normalizes text to lowercase and removes accents/diacritics for uniform search.
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // remove accents
    .replace(/[^a-z0-9\s]/g, ' ')    // replace punctuation with spaces
    .replace(/\s+/g, ' ')            // collapse multiple spaces
    .trim();
}

/**
 * Generates search tokens from a primary name and list of aliases.
 * Splits names into individual word tokens.
 */
export function generateSearchTokens(primaryName: string, aliases: string[] = []): string[] {
  const allNames = [primaryName, ...aliases];
  const tokenSet = new Set<string>();

  for (const name of allNames) {
    const normalized = normalizeText(name);
    const parts = normalized.split(' ');
    for (const part of parts) {
      if (part.length >= 2) { // Only index tokens of length 2 or more
        tokenSet.add(part);
      }
    }
  }

  return Array.from(tokenSet);
}

// Fields excluded from the content hash: status/listedAt/delistedAt are the
// soft-delete lifecycle itself, not content — including them would make every
// relist look like a content "update". createdAt/updatedAt/searchNames are
// derived/bookkeeping, not source content.
const CONTENT_HASH_EXCLUDED_FIELDS = new Set([
  'status',
  'listedAt',
  'delistedAt',
  'contentHash',
  'createdAt',
  'updatedAt',
  'searchNames',
]);

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
    console.warn(
      `Dropping ${dropped.length} CUSTOM-sourced record(s) from an automated import batch ` +
      `(ids: ${dropped.map((r) => r.id).join(', ')}) — custom records may only be created ` +
      `via the dedicated custom-records path.`,
    );
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
      content[key] = (record as any)[key];
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

  console.log(`Starting upload of ${records.length} records to Firestore...`);

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
      record.updatedAt = now;
      record.contentHash = computeContentHash(record);

      let changeType: ChangeType | null;

      if (!existingDoc.exists) {
        record.status = 'active';
        record.listedAt = now;
        changeType = 'created';
      } else {
        const existing = existingDoc.data() as SanctionRecord;
        const wasDelisted = existing.status === 'delisted';
        const contentChanged = existing.contentHash !== record.contentHash;

        record.listedAt = existing.listedAt || now; // preserve first-listed date
        record.status = 'active';

        if (wasDelisted) {
          changeType = 'relisted';
        } else if (contentChanged) {
          changeType = 'updated';
        } else {
          changeType = null; // unchanged — no version entry
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
      } else {
        batch.set(docRef, record, { merge: true });
      }
    });

    await batch.commit();
    console.log(`Uploaded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} (${chunk.length} records)`);
  }

  console.log('All records uploaded successfully!');
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
