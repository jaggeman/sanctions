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
 * In-memory index shared by the API, MCP server and CLI — one matcher, not
 * three copies (issue #11's explicit requirement). Loaded once and cached;
 * `invalidateSearchIndex` should be called after a successful import so the
 * next search picks up new/changed records rather than serving a stale set.
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
let cachedVersion: number | null = null;
let cachedNameIndex: Map<string, TokenizedName[]> | null = null;

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
    cachedRecords = sanctionsSnapshot.docs.map((doc: any) => {
      const record = doc.data() as SanctionRecord;
      const { record: merged, overriddenFields } = applyOverride(record, overridesByEntityId.get(record.id));
      const candidateNames = allNamesOf(merged.names);
      nameIndex.set(merged.id, candidateNames.map(buildTokenizedName));
      return { ...merged, overriddenFields };
    });
    cachedNameIndex = nameIndex;
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

  const candidates = records.filter((r) => {
    // A delisted person is no longer sanctioned; returning them as a confident
    // match is the exact failure issue #9 exists to prevent. Records predating
    // the status field have no `status` and are treated as active.
    if (!options.includeDelisted && r.status === 'delisted') return false;
    if (sourcesFilter && !sourcesFilter.includes(r.source.toUpperCase())) return false;
    if (typeFilter && r.type !== typeFilter) return false;
    return true;
  });

  const normalizedQuery = normalizeForExactMatch(trimmedQuery);
  const scored: ScoredResult[] = [];
  const matchedIds = new Set<string>();

  // Exact passport/ID fast path takes priority — highest-precision key available.
  for (const record of candidates) {
    if (matchesPassportQuery(record, normalizedQuery)) {
      scored.push({ ...record, score: 100, matchedAlias: 'Passport/ID match' });
      matchedIds.add(record.id);
    }
  }

  // Tokenized once per search (issue #42), not once per candidate record —
  // the query is identical across every comparison within this call.
  const tokenizedQuery = buildTokenizedQuery(trimmedQuery);
  const nameIndex = cachedNameIndex!; // populated by the getRecords() call above

  for (const record of candidates) {
    if (matchedIds.has(record.id)) continue;

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
