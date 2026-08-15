import { db } from '../shared/firebase';
import { SanctionRecord } from '../shared/types';
import { scoreNameMatch } from './matcher';

export interface ScoredResult extends SanctionRecord {
  score: number;
  matchedAlias: string;
}

export interface SearchOptions {
  source?: string; // comma-separated, e.g. "EU,UN"
  type?: string;
  limit?: number;
  threshold?: number; // 0..100
  dob?: string; // booster, not a hard filter — source data has year-only values
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
let cachedRecords: SanctionRecord[] | null = null;

export function invalidateSearchIndex(): void {
  cachedRecords = null;
}

async function getRecords(): Promise<SanctionRecord[]> {
  if (cachedRecords === null) {
    const snapshot = await db.collection('sanctions').get();
    cachedRecords = snapshot.docs.map((doc: any) => doc.data() as SanctionRecord);
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
