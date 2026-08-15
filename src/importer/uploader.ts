import { db } from '../shared/firebase';
import { SanctionRecord } from '../shared/types';

/**
 * Normalizes text to lowercase and removes accents/diacritics for uniform search.
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
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

/**
 * Uploads sanction records to Firestore in batches of 500.
 */
export async function uploadRecords(records: SanctionRecord[]): Promise<void> {
  const collectionRef = db.collection('sanctions');
  const batchSize = 500;
  
  console.log(`Starting upload of ${records.length} records to Firestore...`);

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = db.batch();
    const chunk = records.slice(i, i + batchSize);

    for (const record of chunk) {
      // Add search tokens to the record before saving
      record.searchNames = generateSearchTokens(record.primaryName, record.aliases);
      record.updatedAt = new Date().toISOString();

      const docRef = collectionRef.doc(record.id);
      // set with merge: true so we don't wipe out other fields if they exist
      batch.set(docRef, record, { merge: true });
    }

    await batch.commit();
    console.log(`Uploaded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} (${chunk.length} records)`);
  }

  console.log('All records uploaded successfully!');
}
