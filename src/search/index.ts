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
  tookMs: number; // wall-clock time spent inside runSearch, for the UI's "search took Xms"
  sourcesSearched: string[]; // distinct sources actually present in the index for this query (respects the `source` filter)
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
 * for. Kept in a separate structure (`cachedNameIndex`, a parallel array
 * since #254) rather than as a field on `IndexedRecord` itself: spreading a
 * record into a `ScoredResult` (`{...record, score, matchedAlias}`) would
 * otherwise leak these precomputed tokens into the `/api/search` JSON
 * response.
 */
type IndexedRecord = SanctionRecord & { overriddenFields: string[] };

/**
 * Issue #254: the inverted index stores each record's POSITION in
 * `cachedRecords`, not its string id, and `cachedNameIndex` is a parallel
 * array rather than a Map keyed by id.
 *
 * Positions turn candidate lookup into direct array indexing.
 */
type Postings = number[];

let cachedRecords: IndexedRecord[] | null = null;
let cachedVersion: number | null = null;
let cachedNameIndex: TokenizedName[][] | null = null;
let cachedInvertedIndex: Map<string, Postings> | null = null;
let cachedSources: string[] | null = null;

/**
 * Reused across searches so a query does not allocate a fresh buffer of
 * corpus size every time. Marked with a monotonically increasing stamp rather
 * than being cleared, so resetting between queries is O(1) instead of O(n).
 */
let candidateMarks: Int32Array | null = null;
let candidateStamp = 0;

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

    const nameIndex: TokenizedName[][] = [];
    const invertedIndex = new Map<string, Postings>();

    // Records are indexed in position order, so a key's postings are always
    // appended non-decreasing — checking only the last entry is enough to
    // dedupe (the same record hits the same key repeatedly, e.g. two aliases
    // sharing a 3-gram) without the per-insert hashing a Set would cost.
    const addIndexKey = (key: string, position: number) => {
      if (!key) return;
      let postings = invertedIndex.get(key);
      if (!postings) {
        postings = [];
        invertedIndex.set(key, postings);
      }
      if (postings[postings.length - 1] !== position) postings.push(position);
    };

    cachedRecords = sanctionsSnapshot.docs.map((doc: any, position: number) => {
      const record = doc.data() as SanctionRecord;
      const { record: merged, overriddenFields } = applyOverride(record, overridesByEntityId.get(record.id));
      const candidateNames = allNamesOf(merged.names);
      const tokenizedNames = candidateNames.map(buildTokenizedName);
      nameIndex[position] = tokenizedNames;

      const indexedRecord: IndexedRecord = { ...merged, overriddenFields };

      // Fast ID / Passport index
      for (const ident of merged.identifications || []) {
        const num = normalizeForExactMatch(ident.number);
        if (num.length >= MIN_PASSPORT_QUERY_LENGTH) {
          addIndexKey(`id:${num}`, position);
        }
      }

      // Inverted index for candidate pruning (issue #223, #253, #300)
      for (const tName of tokenizedNames) {
        for (const group of tName.wordGroups) {
          for (const w of group) {
            const text = w.text.toLowerCase();
            if (text.length >= 1) {
              addIndexKey(`w:${text}`, position);
              // Leading character, any script (issue #253) — backs the
              // single-character query path.
              addIndexKey(`p1:${text.slice(0, 1)}`, position);
              if (text.length >= 2) {
                addIndexKey(`p2:${text.slice(0, 2)}`, position);
              }
              if (text.length >= 3) {
                addIndexKey(`p3:${text.slice(0, 3)}`, position);
              }
              if (text.length >= 4) {
                for (let i = 0; i <= text.length - 3; i++) {
                  addIndexKey(`ng3:${text.slice(i, i + 3)}`, position);
                }
              }
            }
            if (w.soundex) {
              addIndexKey(`sx:${w.soundex}`, position);
              // Soundex minus its retained leading letter (issue #253, restricted in #300).
              // ng3 already bridges words of 4+ characters (osama/usama share
              // "sam" and "ama"); this is what rescues SHORT words (<= 3 chars), where
              // ng3 is neither built nor looked up.
              if (text.length <= 3) {
                addIndexKey(`sxd:${w.soundex.slice(1)}`, position);
              }
            }
          }
        }
      }

      return indexedRecord;
    });

    cachedSources = Array.from(new Set(cachedRecords.map((r) => r.source))).sort();
    cachedNameIndex = nameIndex;
    cachedInvertedIndex = invertedIndex;
    cachedVersion = currentVersion;
    // Sized to the new corpus; the stamp keeps resets O(1) (see declaration).
    candidateMarks = new Int32Array(cachedRecords.length);
    candidateStamp = 0;
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
  const startedAt = Date.now();
  const trimmedQuery = (query || '').trim();
  if (!trimmedQuery) {
    return { results: [], totalMatches: 0, truncated: false, tookMs: Date.now() - startedAt, sourcesSearched: [] };
  }

  const records = await getRecords();
  const sourcesFilter = options.source
    ? options.source.split(',').map((s) => s.trim().toUpperCase())
    : null;
  const sourcesFilterSet = sourcesFilter ? new Set(sourcesFilter) : null;
  // Distinct sources this query actually ran over — the full loaded index by
  // default (precomputed once per index build, issue #300), narrowed to whichever
  // of the requested `source` filter values actually have records.
  const allSources = cachedSources || [];
  const sourcesSearched = sourcesFilterSet
    ? allSources.filter((s) => sourcesFilterSet.has(s))
    : allSources;
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
    if (sourcesFilterSet && !sourcesFilterSet.has(r.source)) return false;
    if (typeFilter && r.type !== typeFilter) return false;
    return true;
  };

  const normalizedQuery = normalizeForExactMatch(trimmedQuery);
  const scored: ScoredResult[] = [];
  const nameIndex = cachedNameIndex!;
  const invertedIndex = cachedInvertedIndex;

  // Positions already emitted (passport hits) or already collected as
  // candidates, marked with this search's stamp. Bumping the stamp is the
  // reset, so a query never pays an O(corpus) clear (issue #254).
  if (candidateStamp >= 0x7ffffffe) {
    candidateMarks = new Int32Array(records.length);
    candidateStamp = 0;
  }
  const marks = candidateMarks!;
  const stamp = ++candidateStamp;

  // 1. Exact passport/ID fast path via inverted index lookup. Marking these
  // positions with the stamp keeps `collect` below from re-adding them, so a
  // passport hit is never scored a second time as a name candidate.
  const passportPositions = new Set<number>();
  if (normalizedQuery.length >= MIN_PASSPORT_QUERY_LENGTH) {
    const idMatches = invertedIndex?.get(`id:${normalizedQuery}`);
    if (idMatches) {
      for (const position of idMatches) {
        const record = records[position];
        if (record && passesFilters(record)) {
          scored.push({ ...record, score: 100, matchedAlias: 'Passport/ID match' });
          marks[position] = stamp;
          passportPositions.add(position);
        }
      }
    }
  }

  // 2. Candidate Pruning via Inverted Index (issue #223, #253, #300)
  const tokenizedQuery = buildTokenizedQuery(trimmedQuery);
  const candidatePositions: number[] = [];

  const collect = (key: string) => {
    const postings = invertedIndex?.get(key);
    if (!postings) return;
    for (let i = 0; i < postings.length; i++) {
      const position = postings[i];
      if (marks[position] === stamp) continue;
      marks[position] = stamp;
      candidatePositions.push(position);
    }
  };

  for (const group of tokenizedQuery.wordGroups) {
    for (const w of group) {
      const text = w.text.toLowerCase();
      // Exact word lookup
      collect(`w:${text}`);

      // Soundex lookup
      if (w.soundex) {
        collect(`sx:${w.soundex}`);

        // First-char-insensitive lookup (issue #253, restricted in #300) — mirrors the matcher's
        // transliteration-variant rule from #252 for short words (length <= 3).
        if (text.length <= 3) {
          collect(`sxd:${w.soundex.slice(1)}`);
        }
      }

      // 2-char & 3-char prefix lookups
      if (text.length >= 2) collect(`p2:${text.slice(0, 2)}`);
      if (text.length >= 3) collect(`p3:${text.slice(0, 3)}`);

      // 3-gram lookups
      if (text.length >= 4) {
        for (let i = 0; i <= text.length - 3; i++) {
          collect(`ng3:${text.slice(i, i + 3)}`);
        }
      } else if (text.length === 1) {
        // Single-character query: every word starting with this character.
        collect(`p1:${text}`);
      }
    }
  }

  // Evaluate candidate records (pruned via inverted index when threshold > 0,
  // or full record set when threshold === 0 per test contract).
  const scoreAt = (position: number) => {
    const record = records[position];
    if (!record || !passesFilters(record)) return;

    const candidateTokens = nameIndex[position] ?? [];
    const { score, matchedName } = scoreTokenizedNameMatch(tokenizedQuery, candidateTokens);
    const boostedScore = options.dob && matchesDob(record, options.dob)
      ? Math.min(100, score + DOB_MATCH_BOOST)
      : score;

    if (boostedScore >= threshold) {
      scored.push({ ...record, score: boostedScore, matchedAlias: matchedName });
    }
  };

  if (threshold === 0) {
    for (let position = 0; position < records.length; position++) {
      if (passportPositions.has(position)) continue;
      scoreAt(position);
    }
  } else {
    for (let i = 0; i < candidatePositions.length; i++) {
      scoreAt(candidatePositions[i]);
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const totalMatches = scored.length;
  const results = scored.slice(0, limit);

  return {
    results,
    totalMatches,
    truncated: totalMatches > results.length,
    tookMs: Date.now() - startedAt,
    sourcesSearched,
  };
}
