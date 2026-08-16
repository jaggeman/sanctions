import * as admin from 'firebase-admin';
import { db } from '../shared/firebase';
import { SanctionRecord, Override, allNamesOf, formatBirthDates } from '../shared/types';
import { scoreTokenizedNameMatch, buildTokenizedName, buildTokenizedQuery, TokenizedName } from './matcher';
import { applyOverride } from '../overrides';

export interface ScoredResult extends SanctionRecord {
  score: number;
  matchedAlias: string;
  overriddenFields: string[];
}

export interface SearchOptions {
  source?: string; // comma-separated, e.g. "EU,UN"
  type?: string;
  limit?: number;
  threshold?: number; // 0..100
  dob?: string; // booster, not a hard filter — source data has year-only values
  includeDelisted?: boolean; // default false — soft-deleted records are hidden (issue #9)
}

export interface SearchResponse {
  results: ScoredResult[];
  totalMatches: number; // count before the limit was applied
  truncated: boolean; // true if totalMatches > results.length — no silent cap
}

const DEFAULT_THRESHOLD = 65;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DOB_MATCH_BOOST = 10;
const MIN_PASSPORT_QUERY_LENGTH = 4; // avoids matching every ID on a 1-2 char query

/**
 * In-memory index shared across search consumers (API, MCP server, and CLI batch runs) —
 * one matcher, not three copies (issue #11's explicit requirement). Loaded once and cached;
 * `invalidateSearchIndex` should be called after a successful import so the next search
 * picks up new/changed records rather than serving a stale set.
 *
 * Process lifecycle note (issue #115):
 * - API & MCP server are persistent daemon processes; they pay the initial build cost once
 *   and reuse `cachedRecords` across thousands of incoming requests.
 * - Single-shot CLI invocations (`sanctions search <query>`) run as isolated OS processes
 *   that exit immediately, so they naturally pay the cold-start build per invocation.
 * - To benefit from the warm cache in batch scripts, the CLI supports multi-query arguments
 *   (`sanctions search q1 q2 ...`) and `--file <path>`, executing all queries within a single
 *   process lifetime against the warm in-memory index without paying repeated Firestore scans.
 *
 * Since issue #43, imports run in their own Cloud Function
 * (`runImportTask`), a separate process from whichever `api` instance
 * serves `/api/search` — a plain in-memory flag flip here would only clear
 * the *import worker's* copy and never reach api's, silently reintroducing
 * a stale-index bug. `meta/searchIndex.version` is a shared Firestore
 * counter every instance checks before trusting its own local cache; one
 * extra small doc read per search is far cheaper than the full `sanctions`
 * collection read it's guarding.
 *
 * Issue #42: every candidate name's tokenized form (words, transliterated
 * variants, Soundex codes, particle weights) is precomputed once here, when
 * the cache is (re)built, instead of being recomputed by `runSearch` on
 * every single query — none of that work depends on what's being searched
 * for. Kept in a separate map (`cachedNameIndex`), keyed by record id,
 * rather than as a field on `IndexedRecord` itself: spreading a record into
 * a `ScoredResult` (`{...record, score, matchedAlias}`) would otherwise leak
 * these precomputed tokens into the `/api/search` JSON response.
 */
type IndexedRecord = SanctionRecord & { overriddenFields: string[] };

let cachedRecords: IndexedRecord[] | null = null;
let cachedRecordsById: Map<string, IndexedRecord> | null = null;
let cachedVersion: number | null = null;
let cachedNameIndex: Map<string, TokenizedName[]> | null = null;
let cachedInvertedIndex: Map<string, Set<string>> | null = null;

const searchIndexMetaDoc = () => db.collection('meta').doc('searchIndex');

export async function invalidateSearchIndex(): Promise<void> {
  await searchIndexMetaDoc().set({ version: admin.firestore.FieldValue.increment(1) }, { merge: true });
}

async function getCurrentVersion(): Promise<number> {
  const snap = await searchIndexMetaDoc().get();
  const version = snap.exists ? snap.data()?.version : undefined;
  return typeof version === 'number' ? version : 0;
}

/**
 * Merges each record's override in at index-build time, not after a result
 * is already chosen — this is what makes an overridden name actually
 * searchable (issue #35), not just visible once found some other way. Every
 * caller of runSearch (API, CLI, MCP) shares this one cache, so all three
 * see the same overridden data. Call invalidateSearchIndex() after any
 * override write/delete, or the cache serves stale data until the next import.
 */
async function getRecords(): Promise<IndexedRecord[]> {
  const currentVersion = await getCurrentVersion();
  if (cachedRecords === null || currentVersion !== cachedVersion) {
    const [sanctionsSnapshot, overridesSnapshot] = await Promise.all([
      db.collection('sanctions').get(),
      db.collection('overrides').get(),
    ]);

    const overridesByEntityId = new Map<string, Override>();
    overridesSnapshot.docs.forEach((doc: any) => {
      overridesByEntityId.set(doc.id, doc.data() as Override);
    });

    const nameIndex = new Map<string, TokenizedName[]>();
    const recordsById = new Map<string, IndexedRecord>();
    const invertedIndex = new Map<string, Set<string>>();

    const addIndexKey = (key: string, recordId: string) => {
      if (!key) return;
      let set = invertedIndex.get(key);
      if (!set) {
        set = new Set<string>();
        invertedIndex.set(key, set);
      }
      set.add(recordId);
    };

    cachedRecords = sanctionsSnapshot.docs.map((doc: any) => {
      const record = doc.data() as SanctionRecord;
      const { record: merged, overriddenFields } = applyOverride(record, overridesByEntityId.get(record.id));
      const candidateNames = allNamesOf(merged.names);
      const tokenizedNames = candidateNames.map(buildTokenizedName);
      nameIndex.set(merged.id, tokenizedNames);

      const indexedRecord: IndexedRecord = { ...merged, overriddenFields };
      recordsById.set(merged.id, indexedRecord);

      // Fast ID / Passport index
      for (const ident of merged.identifications || []) {
        const num = normalizeForExactMatch(ident.number);
        if (num.length >= MIN_PASSPORT_QUERY_LENGTH) {
          addIndexKey(`id:${num}`, merged.id);
        }
      }

      // Inverted index for candidate pruning (issue #223)
      for (const tName of tokenizedNames) {
        for (const group of tName.wordGroups) {
          for (const w of group) {
            const text = w.text.toLowerCase();
            if (text.length >= 1) {
              addIndexKey(`w:${text}`, merged.id);
              if (text.length >= 2) {
                addIndexKey(`p2:${text.slice(0, 2)}`, merged.id);
              }
              if (text.length >= 3) {
                addIndexKey(`p3:${text.slice(0, 3)}`, merged.id);
              }
              if (text.length >= 4) {
                for (let i = 0; i <= text.length - 3; i++) {
                  addIndexKey(`ng3:${text.slice(i, i + 3)}`, merged.id);
                }
              }
            }
            if (w.soundex) {
              addIndexKey(`sx:${w.soundex}`, merged.id);
            }
          }
        }
      }

      return indexedRecord;
    });

    cachedRecordsById = recordsById;
    cachedNameIndex = nameIndex;
    cachedInvertedIndex = invertedIndex;
    cachedVersion = currentVersion;
  }
  return cachedRecords;
}

function normalizeForExactMatch(s: string): string {
  return s.toLowerCase().replace(/[\s-]/g, '');
}

function matchesPassportQuery(record: SanctionRecord, normalizedQuery: string): boolean {
  if (normalizedQuery.length < MIN_PASSPORT_QUERY_LENGTH) return false;
  return (record.identifications || []).some((id) => normalizeForExactMatch(id.number) === normalizedQuery);
}

function matchesDob(record: SanctionRecord, dobQuery: string): boolean {
  return formatBirthDates(record.birthDates).some((d) => d.includes(dobQuery));
}

/**
 * Runs a fuzzy name search (plus an exact passport/ID fast path) over the
 * in-memory index. Used by /api/search, the MCP search_sanctions tool, and
 * the CLI search command alike, so all three surfaces score results
 * identically.
 */
export async function runSearch(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const trimmedQuery = (query || '').trim();
  if (!trimmedQuery) {
    return { results: [], totalMatches: 0, truncated: false };
  }

  const records = await getRecords();
  const sourcesFilter = options.source
    ? options.source.split(',').map((s) => s.trim().toUpperCase())
    : null;
  const typeFilter = options.type ? options.type.trim().toLowerCase() : null;
  const rawThreshold = options.threshold !== undefined && !Number.isNaN(options.threshold)
    ? options.threshold
    : DEFAULT_THRESHOLD;
  const threshold = Math.max(0, Math.min(rawThreshold, 100));
  // issue #161: guard limit against NaN and negative values. A negative or NaN
  // limit falls back to DEFAULT_LIMIT (20). Preserve explicit limit=0 per issue #37.
  const rawLimit =
    options.limit !== undefined && !Number.isNaN(options.limit)
      ? (options.limit >= 0 ? options.limit : DEFAULT_LIMIT)
      : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(0, rawLimit), MAX_LIMIT);

  const passesFilters = (r: IndexedRecord) => {
    if (!options.includeDelisted && r.status === 'delisted') return false;
    if (sourcesFilter && !sourcesFilter.includes(r.source.toUpperCase())) return false;
    if (typeFilter && r.type !== typeFilter) return false;
    return true;
  };

  const normalizedQuery = normalizeForExactMatch(trimmedQuery);
  const scored: ScoredResult[] = [];
  const matchedIds = new Set<string>();

  // 1. Exact passport/ID fast path via inverted index lookup
  if (normalizedQuery.length >= MIN_PASSPORT_QUERY_LENGTH) {
    const idMatches = cachedInvertedIndex?.get(`id:${normalizedQuery}`);
    if (idMatches) {
      for (const id of idMatches) {
        const record = cachedRecordsById?.get(id);
        if (record && passesFilters(record)) {
          scored.push({ ...record, score: 100, matchedAlias: 'Passport/ID match' });
          matchedIds.add(record.id);
        }
      }
    }
  }

  // 2. Candidate Pruning via Inverted Index (issue #223)
  const tokenizedQuery = buildTokenizedQuery(trimmedQuery);
  const nameIndex = cachedNameIndex!;
  const candidateIdSet = new Set<string>();

  for (const group of tokenizedQuery.wordGroups) {
    for (const w of group) {
      const text = w.text.toLowerCase();
      // Exact word lookup
      const exact = cachedInvertedIndex?.get(`w:${text}`);
      if (exact) for (const id of exact) candidateIdSet.add(id);

      // Soundex lookup
      if (w.soundex) {
        const sx = cachedInvertedIndex?.get(`sx:${w.soundex}`);
        if (sx) for (const id of sx) candidateIdSet.add(id);
      }

      // 2-char & 3-char prefix lookups
      if (text.length >= 2) {
        const p2 = cachedInvertedIndex?.get(`p2:${text.slice(0, 2)}`);
        if (p2) for (const id of p2) candidateIdSet.add(id);
      }
      if (text.length >= 3) {
        const p3 = cachedInvertedIndex?.get(`p3:${text.slice(0, 3)}`);
        if (p3) for (const id of p3) candidateIdSet.add(id);
      }

      // 3-gram lookups
      if (text.length >= 4) {
        for (let i = 0; i <= text.length - 3; i++) {
          const ng = cachedInvertedIndex?.get(`ng3:${text.slice(i, i + 3)}`);
          if (ng) for (const id of ng) candidateIdSet.add(id);
        }
      } else if (text.length === 1) {
        // Single-character query: match all words starting with this character
        for (let c = 97; c <= 122; c++) {
          const p2 = cachedInvertedIndex?.get(`p2:${text}${String.fromCharCode(c)}`);
          if (p2) for (const id of p2) candidateIdSet.add(id);
        }
      }
    }
  }

  // Evaluate candidate records (pruned via inverted index when threshold > 0,
  // or full record set when threshold === 0 per test contract)
  const candidateIds: Iterable<string> =
    threshold === 0
      ? records.map((r) => r.id)
      : candidateIdSet;

  for (const id of candidateIds) {
    if (matchedIds.has(id)) continue;
    const record = cachedRecordsById?.get(id);
    if (!record || !passesFilters(record)) continue;

    const candidateTokens = nameIndex.get(record.id) ?? [];
    const { score, matchedName } = scoreTokenizedNameMatch(tokenizedQuery, candidateTokens);
    const boostedScore = options.dob && matchesDob(record, options.dob)
      ? Math.min(100, score + DOB_MATCH_BOOST)
      : score;

    if (boostedScore >= threshold) {
      scored.push({ ...record, score: boostedScore, matchedAlias: matchedName });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const totalMatches = scored.length;
  const results = scored.slice(0, limit);

  return { results, totalMatches, truncated: results.length > 0 && totalMatches > results.length };
}
