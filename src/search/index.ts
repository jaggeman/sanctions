import { db } from '../shared/firebase';
import { SanctionRecord, Override } from '../shared/types';
import { scoreNameMatch } from './matcher';
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
 */
type IndexedRecord = SanctionRecord & { overriddenFields: string[] };

let cachedRecords: IndexedRecord[] | null = null;

export function invalidateSearchIndex(): void {
  cachedRecords = null;
}

/**
 * Merges each record's override in at index-build time, not after a result
 * is already chosen — this is what makes an overridden primaryName actually
 * searchable (issue #35), not just visible once found some other way. Every
 * caller of runSearch (API, CLI, MCP) shares this one cache, so all three
 * see the same overridden data. Call invalidateSearchIndex() after any
 * override write/delete, or the cache serves stale data until the next import.
 */
async function getRecords(): Promise<IndexedRecord[]> {
  if (cachedRecords === null) {
    const [sanctionsSnapshot, overridesSnapshot] = await Promise.all([
      db.collection('sanctions').get(),
      db.collection('overrides').get(),
    ]);

    const overridesByEntityId = new Map<string, Override>();
    overridesSnapshot.docs.forEach((doc: any) => {
      overridesByEntityId.set(doc.id, doc.data() as Override);
    });

    cachedRecords = sanctionsSnapshot.docs.map((doc: any) => {
      const record = doc.data() as SanctionRecord;
      const { record: merged, overriddenFields } = applyOverride(record, overridesByEntityId.get(record.id));
      return { ...merged, overriddenFields };
    });
  }
  return cachedRecords;
}

function normalizeForExactMatch(s: string): string {
  return s.toLowerCase().replace(/[\s-]/g, '');
}

function matchesPassportQuery(record: SanctionRecord, normalizedQuery: string): boolean {
  if (normalizedQuery.length < MIN_PASSPORT_QUERY_LENGTH) return false;
  return (record.passports || []).some((p) => normalizeForExactMatch(p).includes(normalizedQuery));
}

function matchesDob(record: SanctionRecord, dobQuery: string): boolean {
  return (record.datesOfBirth || []).some((d) => d.includes(dobQuery));
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
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

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

  for (const record of candidates) {
    if (matchedIds.has(record.id)) continue;

    const candidateNames = [record.primaryName, ...(record.aliases || [])];
    const { score, matchedName } = scoreNameMatch(trimmedQuery, candidateNames);
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

  return { results, totalMatches, truncated: totalMatches > results.length };
}
