import { normalizeText, transliterate } from '../importer/uploader';

/**
 * Hand-rolled Soundex + Jaro-Winkler rather than a dependency (e.g. `natural`)
 * — issue #11's own gotcha flags cold start as the real risk for a Cloud
 * Function, and these are ~30-line algorithms that don't need a general NLP
 * package pulled in just for two functions.
 */

const SOUNDEX_CODES: Record<string, string> = {
  B: '1', F: '1', P: '1', V: '1',
  C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
  D: '3', T: '3',
  L: '4',
  M: '5', N: '5',
  R: '6',
};

/** Classic Russell Soundex: same first letter + phonetic code for the rest. */
export function soundex(input: string): string {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return '';

  let result = letters[0];
  let lastCode = SOUNDEX_CODES[letters[0]] || '';

  for (let i = 1; i < letters.length && result.length < 4; i++) {
    const ch = letters[i];
    if (ch === 'H' || ch === 'W') {
      // Transparent: neither coded nor resets adjacency, so e.g. the two M's
      // in "Mohammed" still collapse into one digit across the H.
      continue;
    }
    const code = SOUNDEX_CODES[ch];
    if (code) {
      if (code !== lastCode) result += code;
      lastCode = code;
    } else {
      // A true vowel resets adjacency, so a repeated consonant code after one
      // is kept rather than collapsed.
      lastCode = '';
    }
  }

  return (result + '000').slice(0, 4);
}

/** Jaro similarity, 0..1. */
function jaro(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = Math.floor(transpositions / 2);

  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler: Jaro similarity plus a bonus for a shared prefix (up to 4 chars). */
export function jaroWinkler(a: string, b: string): number {
  const aL = a.toLowerCase();
  const bL = b.toLowerCase();
  const jaroSim = jaro(aL, bL);
  if (jaroSim === 0) return 0;

  const PREFIX_SCALE = 0.1;
  const MAX_PREFIX = 4;
  let prefixLen = 0;
  for (let i = 0; i < Math.min(MAX_PREFIX, aL.length, bL.length); i++) {
    if (aL[i] !== bL[i]) break;
    prefixLen++;
  }

  if (jaroSim < 0.7) return jaroSim;
  return jaroSim + prefixLen * PREFIX_SCALE * (1 - jaroSim);
}

const PHONETIC_MATCH_SCORE = 0.85;

// Jaro-Winkler is known to be noisy on short-to-medium strings: two unrelated
// words can share enough characters within the matching window to score
// 0.5-0.6 by pure chance (e.g. "angela"/"jong" ≈ 0.61). A raw JW score is
// therefore only trustworthy as "these are plausibly the same word" above a
// fairly high bar — below it, treat it as noise (0), not partial signal.
const MIN_LENGTH_FOR_EDIT_DISTANCE = 3;
const EDIT_DISTANCE_MATCH_THRESHOLD = 0.75;

/**
 * Generic name particles (issue #41, decision (b)): these carry far less
 * identifying information than an actual name part, so a match on one alone
 * shouldn't count the same as matching a real surname/given name. Down-
 * weighted, never excluded entirely — a name that's ALL particles ("Abu
 * Ali") must stay non-empty and searchable, so this is a weight, not a
 * stop-word filter.
 */
const GENERIC_PARTICLES = new Set(['al', 'bin', 'ibn', 'el', 'abu', 'van', 'de']);
const PARTICLE_WEIGHT = 0.3;
const REAL_WORD_WEIGHT = 1.0;

function wordWeight(word: string): number {
  return GENERIC_PARTICLES.has(word) ? PARTICLE_WEIGHT : REAL_WORD_WEIGHT;
}

/**
 * A single word variant with its Soundex code precomputed alongside it
 * (issue #42) — `pairScore` runs for every query-word/candidate-word pair
 * across every candidate name in the index on every search, so recomputing
 * `soundex()` on the same candidate token again for each query (it never
 * changes between searches) is pure waste at scale.
 */
export interface TokenizedWord {
  text: string;
  soundex: string;
}

function annotateWithSoundex(wordGroups: string[][]): TokenizedWord[][] {
  return wordGroups.map((variants) => variants.map((text) => ({ text, soundex: soundex(text) })));
}

/** Similarity (0..1) between exactly one query token and one candidate token. */
function pairScore(token: TokenizedWord, candidate: TokenizedWord): number {
  if (token.text === candidate.text) return 1;
  const phoneticScore = token.soundex === candidate.soundex && token.soundex !== ''
    ? PHONETIC_MATCH_SCORE
    : 0;
  const minLen = Math.min(token.text.length, candidate.text.length);
  let editScore = 0;
  if (minLen >= MIN_LENGTH_FOR_EDIT_DISTANCE) {
    const jw = jaroWinkler(token.text, candidate.text);
    editScore = jw >= EDIT_DISTANCE_MATCH_THRESHOLD ? jw : 0;
  }
  return Math.max(phoneticScore, editScore);
}

/**
 * Similarity between one WORD (its script-preserved + transliterated
 * spelling variants) and another — the max across every variant pairing, so
 * a word matching via either its original script or its transliteration
 * counts fully, on both the query and the candidate side alike (issue #40's
 * cross-script matching, extended symmetrically for issue #41).
 */
function groupPairScore(a: TokenizedWord[], b: TokenizedWord[]): number {
  let best = 0;
  for (const variantA of a) {
    for (const variantB of b) {
      best = Math.max(best, pairScore(variantA, variantB));
      if (best === 1) return 1;
    }
  }
  return best;
}

interface Assignment {
  queryIndex: number;
  candidateIndex: number;
  score: number;
}

/**
 * Greedy one-to-one bipartite matching (issue #41): assigns each query word
 * to at most one candidate word and vice versa, highest-scoring pairs
 * first. Without this, a single candidate word could be "matched" by
 * several query words independently (e.g. "Ali Ali" against a candidate
 * with just one "Ali" scored a perfect 100 under the old code, since
 * nothing stopped both query words from claiming the same word at full
 * score) — and, symmetrically, a single query word could double-count
 * against a candidate word's original-script AND transliterated forms if
 * those were treated as two separate candidate slots instead of one.
 */
function greedyOneToOneMatch(queryWordGroups: TokenizedWord[][], candidateWordGroups: TokenizedWord[][]): Assignment[] {
  const pairs: Assignment[] = [];
  for (let qi = 0; qi < queryWordGroups.length; qi++) {
    for (let ci = 0; ci < candidateWordGroups.length; ci++) {
      pairs.push({ queryIndex: qi, candidateIndex: ci, score: groupPairScore(queryWordGroups[qi], candidateWordGroups[ci]) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedQuery = new Array(queryWordGroups.length).fill(false);
  const usedCandidate = new Array(candidateWordGroups.length).fill(false);
  const assignments: Assignment[] = [];

  for (const pair of pairs) {
    if (usedQuery[pair.queryIndex] || usedCandidate[pair.candidateIndex]) continue;
    usedQuery[pair.queryIndex] = true;
    usedCandidate[pair.candidateIndex] = true;
    assignments.push(pair);
  }

  return assignments;
}

function weightedAverage(scores: number[], weights: number[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (let i = 0; i < scores.length; i++) {
    totalWeight += weights[i];
    weightedSum += scores[i] * weights[i];
  }
  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

/**
 * A word group's weight only depends on its first variant's text
 * (`wordWeight`), which never changes for a given query or candidate name
 * across searches — precomputed once (issue #42) alongside the word groups
 * themselves rather than recomputed via `.map()` for every single candidate
 * name comparison within every search.
 */
function computeWordWeights(wordGroups: TokenizedWord[][]): number[] {
  const weights = new Array(wordGroups.length);
  for (let i = 0; i < wordGroups.length; i++) {
    weights[i] = wordWeight(wordGroups[i][0].text);
  }
  return weights;
}

/**
 * Symmetric token-set score, 0..1 (issue #41 — the root fix).
 *
 * The old version only measured query->candidate coverage (what share of
 * the query's words appear somewhere in the candidate), so ANY query whose
 * words all happened to occur in a much longer, unrelated candidate scored
 * a perfect 1.0 — indistinguishable from an exact match. This version
 * combines that query coverage with the reverse — candidate->query coverage
 * (what share of the CANDIDATE's words the query actually accounts for) —
 * via their harmonic mean (F1), so a candidate with a lot of unexplained
 * extra content can no longer reach a perfect score. Word order still
 * doesn't matter (issue #11's scope; matching is a one-to-one assignment,
 * not a sequence comparison), and particle words contribute less to both
 * sides of the ratio than a real name part (decision (b), see
 * GENERIC_PARTICLES) — needed in combination with (a): without it, a
 * generic-particle-only overlap can still land close enough to the
 * threshold to be a false positive (see the PR description for the actual
 * numbers).
 *
 * Both `queryWordGroups` and `candidateWordGroups` hold one entry per
 * original WORD, each entry being that word's alternate spellings
 * (script-preserved + transliterated, see `tokenizeGrouped`) — never
 * counted as separate words on either side. Flattening either side's
 * variants into separate slots would let an unmatched original-script token
 * silently dilute a word that its transliterated twin matched perfectly
 * (issue #40) — and, on the candidate side specifically, would inflate the
 * candidate's word count with duplicate representations of the very same
 * word, making candidate coverage look artificially low for non-Latin
 * candidates under this task's new symmetric measure.
 */
function tokenSetScore(
  queryWordGroups: TokenizedWord[][],
  queryWeights: number[],
  candidateWordGroups: TokenizedWord[][],
  candidateWeights: number[],
): number {
  if (queryWordGroups.length === 0 || candidateWordGroups.length === 0) return 0;

  const assignments = greedyOneToOneMatch(queryWordGroups, candidateWordGroups);
  const scorePerQueryWord = new Array(queryWordGroups.length).fill(0);
  const scorePerCandidateWord = new Array(candidateWordGroups.length).fill(0);
  for (const { queryIndex, candidateIndex, score } of assignments) {
    scorePerQueryWord[queryIndex] = score;
    scorePerCandidateWord[candidateIndex] = score;
  }

  const queryCoverage = weightedAverage(scorePerQueryWord, queryWeights);
  const candidateCoverage = weightedAverage(scorePerCandidateWord, candidateWeights);

  if (queryCoverage === 0 || candidateCoverage === 0) return 0;
  return (2 * queryCoverage * candidateCoverage) / (queryCoverage + candidateCoverage);
}

export interface NameMatch {
  score: number; // 0..100
  matchedName: string;
}

/**
 * Tokenizes a name into one group per original word, each group holding
 * that word's script-preserved form and (if applicable) its transliterated
 * form (issue #40's cross-script matching). Used for BOTH sides of
 * scoreNameMatch (issue #41) — grouping the candidate the same way as the
 * query, rather than flattening it, keeps a candidate's word count from
 * being inflated by its own transliterated duplicates, which would
 * otherwise make candidate coverage look artificially low for any
 * non-Latin candidate. `normalizeText(name)` and
 * `normalizeText(transliterate(name))` split into the same number of words
 * in the same order — transliteration maps character-by-character and never
 * merges/splits words — so the two token lists line up positionally.
 *
 * Exported (issue #42) so callers can precompute a candidate name's tokens
 * once at index-build time instead of paying this cost (a Unicode NFD
 * normalize plus several regex passes) again on every single search.
 */
export function tokenizeGrouped(name: string): string[][] {
  const words = normalizeText(name).split(' ').filter(Boolean);
  const translit = transliterate(name);
  const translitWords = translit ? normalizeText(translit).split(' ').filter(Boolean) : [];

  return words.map((word, i) => {
    const variants = new Set([word]);
    if (translitWords[i]) variants.add(translitWords[i]);
    return Array.from(variants);
  });
}

// issue #41: a token-set reconstruction can mathematically reach a perfect
// 1.0 for names that are NOT literally identical (e.g. the exact same two
// name parts in reverse order — "Ali Hassan" vs "Hassan Ali" — since order
// doesn't factor into the coverage math at all, by design). A literal
// string match is strictly more confident than any reconstructed match, so
// only a true exact match (after normalisation) reaches 100; anything else
// tops out just under it. This is NOT position/sequence scoring (option (c),
// out of scope) — it's a single cheap string-equality check, not a
// comparison of word order or placement.
const NON_LITERAL_MATCH_CAP = 0.99;

/**
 * A candidate name's tokenized form, precomputed once (issue #42) so a
 * search doesn't pay tokenizeGrouped/normalizeText/soundex's cost again for
 * every query against a candidate whose name hasn't changed since the last
 * import — none of that work depends on what's being searched for.
 */
export interface TokenizedName {
  name: string;
  wordGroups: TokenizedWord[][];
  weights: number[];
  normalizedName: string;
}

export function buildTokenizedName(name: string): TokenizedName {
  const wordGroups = annotateWithSoundex(tokenizeGrouped(name));
  return { name, wordGroups, weights: computeWordWeights(wordGroups), normalizedName: normalizeText(name) };
}

/**
 * The query's own tokenized form, precomputed once per search (issue #42)
 * rather than once per candidate record — the query is identical across
 * every candidate comparison within a single search.
 */
export interface TokenizedQuery {
  wordGroups: TokenizedWord[][];
  weights: number[];
  normalizedQuery: string;
}

export function buildTokenizedQuery(query: string): TokenizedQuery {
  const wordGroups = annotateWithSoundex(tokenizeGrouped(query));
  return { wordGroups, weights: computeWordWeights(wordGroups), normalizedQuery: normalizeText(query) };
}

/**
 * The actual scoring loop `scoreNameMatch` runs, taking an already-tokenized
 * query and candidates instead of raw strings (issue #42) — lets a caller
 * that holds a precomputed index (query tokenized once per search, each
 * candidate tokenized once at index-build time) skip all re-tokenization.
 */
export function scoreTokenizedNameMatch(query: TokenizedQuery, candidates: TokenizedName[]): NameMatch {
  if (query.wordGroups.length === 0 || candidates.length === 0) {
    return { score: 0, matchedName: '' };
  }

  let best: NameMatch = { score: 0, matchedName: '' };
  for (const { name, wordGroups, weights, normalizedName } of candidates) {
    const rawScore = tokenSetScore(query.wordGroups, query.weights, wordGroups, weights);
    const isLiteralMatch = query.normalizedQuery === normalizedName;
    const boundedScore = isLiteralMatch ? rawScore : Math.min(rawScore, NON_LITERAL_MATCH_CAP);
    const score = Math.round(boundedScore * 100);
    if (score > best.score) {
      best = { score, matchedName: name };
    }
  }
  return best;
}

/**
 * Scores a query against a list of candidate names (primary name + aliases),
 * returning the best-matching one and its 0..100 score. Reuses normalizeText
 * verbatim so query-side and index-side normalisation always agree.
 *
 * A thin wrapper around `scoreTokenizedNameMatch` (issue #42) — tokenizes
 * everything on the spot for a caller that doesn't hold a precomputed index
 * (tests, one-off callers), while `runSearch` calls the precomputed variant
 * directly to avoid re-tokenizing the same candidate names on every query.
 */
export function scoreNameMatch(query: string, candidateNames: string[]): NameMatch {
  const tokenizedQuery = buildTokenizedQuery(query);
  if (tokenizedQuery.wordGroups.length === 0 || candidateNames.length === 0) {
    return { score: 0, matchedName: '' };
  }
  const candidates = candidateNames.map(buildTokenizedName);
  return scoreTokenizedNameMatch(tokenizedQuery, candidates);
}
