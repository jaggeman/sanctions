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

/**
 * Jaro-Winkler: Jaro similarity plus a bonus for a shared prefix (up to 4 chars).
 * Inputs inside pairScore/search are pre-normalized lowercase, so redundant
 * lowercasing is omitted (issue #300).
 */
export function jaroWinkler(a: string, b: string): number {
  const jaroSim = jaro(a, b);
  if (jaroSim === 0) return 0;

  const PREFIX_SCALE = 0.1;
  const MAX_PREFIX = 4;
  let prefixLen = 0;
  for (let i = 0; i < Math.min(MAX_PREFIX, a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    prefixLen++;
  }

  if (jaroSim < 0.7) return jaroSim;
  return jaroSim + prefixLen * PREFIX_SCALE * (1 - jaroSim);
}

/**
 * A shared Soundex code is corroborating evidence, not decisive evidence
 * (issue #239). This was 0.85 — above DEFAULT_THRESHOLD (65) — which made
 * every Soundex collision a guaranteed hit, rendered in the UI's orange
 * "warning" band. Soundex is a 4-character code and collides densely: over
 * the real UN + US SDN corpora, M200 covers 174 distinct spellings (musa,
 * mzee, mihigo, mwissa, maheshe…) and A134 covers 159. Searching "musa"
 * returned 23 results related to the query by nothing but that code — 3MG,
 * MAK, MIKE, MYC. Because that noise sat ABOVE most genuine variants, no
 * threshold could remove it without removing real matches too.
 *
 * What separates a real spelling variant from a code collision is whether
 * the two words also LOOK alike, so the phonetic path now has two levels:
 *
 *   qusay/qoussai  soundex Q200=Q200, JW 0.81  -> a real transliteration
 *   linda/lamd     soundex L530=L530, JW 0.63  -> a code collision
 *   musa/mzee      soundex M200=M200, JW 0.45  -> a code collision
 *
 * Corroborated agreement scores high; uncorroborated agreement stays under
 * DEFAULT_THRESHOLD (65) so it cannot carry a match on its own, while still
 * lifting a candidate whose other words support it and still ranking a
 * phonetic near-miss above an unrelated name.
 *
 * Note the JW bar here is deliberately BELOW #104's short-word bar (0.9):
 * that bar governs edit distance used alone, where a coincidence is the main
 * risk. Here the soundex agreement has already been established, so a weaker
 * textual signal is enough to tell "same name, spelled differently" from
 * "same four-character code by chance".
 */
const PHONETIC_MATCH_SCORE = 0.9;
const PHONETIC_MATCH_SCORE_UNCORROBORATED = 0.5;
const PHONETIC_CORROBORATION_MIN_JW = 0.8;

/**
 * Jaro-Winkler only ever REWARDS a shared prefix — it has no penalty for a
 * differing one. Dropping the single most identifying character in a name
 * therefore barely moved the score: jaroWinkler('linda','inda') = 0.9333,
 * clearing even the stricter short-word bar from #104. That is how a vessel
 * named INDA came back as a 93% match for "linda" (issue #239).
 */
const FIRST_CHAR_MISMATCH_PENALTY = 0.9;

/**
 * ...but a differing initial is ALSO the dominant transliteration axis in
 * sanctions data (O/U, V/W, Y/J, G/J), and issue #252 measured what a blanket
 * penalty costs: "Osama bin Laden" missed the UN's `USAMA BIN LADEN`, and
 * "Wagner" missed OFAC's real `CHVK VAGNER` alias records. Both of the
 * matcher's mechanisms share this blind spot — Russell Soundex retains the
 * first letter verbatim, and a first-char change costs a short name ~0.11 of
 * JW while also forfeiting the Winkler prefix bonus — so they fail together
 * rather than covering for each other, producing a score of 0 rather than a
 * low one.
 *
 * Raw JW cannot separate the two situations; measured, they interleave:
 *
 *   yevgeny/evgeny  0.9524  a real variant   (scored 98 before #239)
 *   linda/inda      0.9333  noise            (the reported vessel)
 *   zaiz/aziz       0.9167  a real variant
 *
 * What DOES separate them is what the initial change leaves behind. A
 * SUBSTITUTED initial leaves the rest of the word intact ("osama"/"usama" ->
 * "sama"/"sama"); a DROPPED one does not ("linda"/"inda" -> "inda"/"nda").
 * So a first-char difference counts as a transliteration variant only when
 * the Soundex DIGITS agree — the phonetic body is identical, only the
 * retained initial differs — AND either the tail after the initial matches
 * exactly, or JW is high enough to carry it alone.
 */
const INITIAL_VARIANT_SCORE = 0.92;
const INITIAL_VARIANT_MIN_JW = 0.95;

/** Soundex minus its retained leading letter — the purely phonetic body. */
function soundexDigits(code: string): string {
  return code.slice(1);
}

// Jaro-Winkler is known to be noisy on short-to-medium strings: two unrelated
// words can share enough characters within the matching window to score
// 0.5-0.6 by pure chance (e.g. "angela"/"jong" ≈ 0.61). A raw JW score is
// therefore only trustworthy as "these are plausibly the same word" above a
// fairly high bar — below it, treat it as noise (0), not partial signal.
const MIN_LENGTH_FOR_EDIT_DISTANCE = 3;
const EDIT_DISTANCE_MATCH_THRESHOLD = 0.75;

// issue #104: 0.75 was not a high enough bar for genuinely SHORT words
// specifically — e.g. jaroWinkler('qusay','musa') = 0.7833, two real,
// phonetically-unrelated (soundex 'Q200' vs 'M200') aliases in the corpus
// that happen to share enough characters by pure chance. A corpus-wide
// calibration (see this fix's PR description) found coincidental short-word
// pairs scoring as high as ~0.88-0.89 with no phonetic or substring
// relationship at all, while genuine short-name spelling variants
// (ahmed/ahmad, nasser/nassar, musa/musab, hana/hanan...) mostly score
// >= 0.90 even when their soundex codes disagree too. A stricter bar for
// short words (rather than raising MIN_LENGTH_FOR_EDIT_DISTANCE, which
// would drop genuine short variants to phonetic-only matching and miss the
// ones whose soundex also disagrees) keeps both effects: it rejects the
// reported coincidence and its siblings while still matching real variants.
const SHORT_WORD_MAX_LENGTH = 6;
const EDIT_DISTANCE_MATCH_THRESHOLD_SHORT_WORD = 0.9;

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

  const soundexAgrees = token.soundex === candidate.soundex && token.soundex !== '';
  const minLen = Math.min(token.text.length, candidate.text.length);
  const canUseEditDistance = minLen >= MIN_LENGTH_FOR_EDIT_DISTANCE;

  // With neither a phonetic nor an edit-distance path open there is no way to
  // score at all, so skip Jaro-Winkler entirely. This function runs for every
  // query-word × candidate-word pair across the whole index on every search,
  // and JW is by far the most expensive part of it.
  if (!soundexAgrees && !canUseEditDistance) return 0;

  const rawJw = jaroWinkler(token.text, candidate.text);

  // A differing initial over an identical phonetic body is a transliteration
  // variant, not a different name — but only when what follows the initial
  // corroborates it (issue #252). Checked before the penalty below, which
  // would otherwise push these exact pairs under the bar.
  if (
    token.text[0] !== candidate.text[0]
    && token.soundex !== ''
    && soundexDigits(token.soundex) === soundexDigits(candidate.soundex)
    && (token.text.slice(1) === candidate.text.slice(1) || rawJw >= INITIAL_VARIANT_MIN_JW)
  ) {
    return INITIAL_VARIANT_SCORE;
  }

  // The first-character penalty applies before every threshold comparison
  // below, not after, so a name that only resembles the query once its initial
  // is ignored fails the bar outright rather than landing just under it as a
  // weak partial signal (issue #239).
  const jw = rawJw
    * (token.text[0] === candidate.text[0] ? 1 : FIRST_CHAR_MISMATCH_PENALTY);

  const phoneticScore = !soundexAgrees
    ? 0
    : jw >= PHONETIC_CORROBORATION_MIN_JW
      ? PHONETIC_MATCH_SCORE
      : PHONETIC_MATCH_SCORE_UNCORROBORATED;

  let editScore = 0;
  if (canUseEditDistance) {
    const threshold = minLen <= SHORT_WORD_MAX_LENGTH
      ? EDIT_DISTANCE_MATCH_THRESHOLD_SHORT_WORD
      : EDIT_DISTANCE_MATCH_THRESHOLD;
    editScore = jw >= threshold ? jw : 0;
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

/**
 * Reusable scratch buffers for greedy bipartite matching (issue #300).
 * Avoids per-candidate-name heap allocations in the hot search scoring loop.
 */
let matrixScores = new Float64Array(256);
let queryAssignedScores = new Float64Array(32);
let candidateAssignedScores = new Float64Array(32);
let usedQueryFlags = new Uint8Array(32);
let usedCandidateFlags = new Uint8Array(32);

function ensureScratchCapacity(qLen: number, cLen: number): void {
  const totalPairs = qLen * cLen;
  if (totalPairs > matrixScores.length) {
    matrixScores = new Float64Array(Math.max(totalPairs * 2, 256));
  }
  if (qLen > queryAssignedScores.length) {
    queryAssignedScores = new Float64Array(Math.max(qLen * 2, 32));
    usedQueryFlags = new Uint8Array(Math.max(qLen * 2, 32));
  }
  if (cLen > candidateAssignedScores.length) {
    candidateAssignedScores = new Float64Array(Math.max(cLen * 2, 32));
    usedCandidateFlags = new Uint8Array(Math.max(cLen * 2, 32));
  }
}

/**
 * How much of a match's score survives when the candidate carries name parts
 * the query never mentioned (issue #239).
 *
 * #41 combined query- and candidate-coverage via their harmonic mean (F1).
 * That is symmetric by construction, which is what it needed to be to stop an
 * unrelated long name scoring a perfect 100 — but it also caps a one-word
 * query at 2·1·(1/n) / (1 + 1/n) against an n-word candidate, regardless of
 * how good the match is: 67 for two words, 50 for three, 40 for four. With
 * DEFAULT_THRESHOLD at 65, surname search worked on two-word names and
 * silently failed on everything longer, and most sanctions records are 3+
 * words. Measured over the real corpora, that lost 88% of "kim", 75% of "ali"
 * and 80% of "mohammed".
 *
 * This replaces the harmonic mean with query coverage scaled by a floored
 * candidate coverage: a match keeps at least this fraction of its query
 * coverage no matter how much unexplained material the candidate carries,
 * and earns the rest back as that material is explained. So a partial match
 * still ranks BELOW a fuller one — the ordering #41 wanted is intact, and a
 * partial match still cannot reach 100 — but it lands above the threshold
 * instead of vanishing from the result set entirely.
 *
 * That is a deliberate reversal of the tradeoff #41 accepted. In sanctions
 * screening a false negative clears someone who is actually listed, while a
 * false positive costs one row of human review. The costs are not symmetric.
 */
const PARTIAL_MATCH_FLOOR = 0.7;

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
 * Symmetric token-set score, 0..1 (issue #41 — the root fix; optimized in #300).
 *
 * Uses greedy one-to-one bipartite matching without per-candidate object array
 * allocations or Array.sort() overhead by operating directly over flat scratch buffers.
 */
function tokenSetScore(
  queryWordGroups: TokenizedWord[][],
  queryWeights: number[],
  queryTotalWeight: number,
  candidateWordGroups: TokenizedWord[][],
  candidateWeights: number[],
  candidateTotalWeight: number,
): number {
  const qLen = queryWordGroups.length;
  const cLen = candidateWordGroups.length;
  if (qLen === 0 || cLen === 0 || queryTotalWeight === 0 || candidateTotalWeight === 0) return 0;

  ensureScratchCapacity(qLen, cLen);

  let idx = 0;
  for (let qi = 0; qi < qLen; qi++) {
    const qGroup = queryWordGroups[qi];
    for (let ci = 0; ci < cLen; ci++) {
      matrixScores[idx++] = groupPairScore(qGroup, candidateWordGroups[ci]);
    }
  }

  for (let qi = 0; qi < qLen; qi++) {
    usedQueryFlags[qi] = 0;
    queryAssignedScores[qi] = 0;
  }
  for (let ci = 0; ci < cLen; ci++) {
    usedCandidateFlags[ci] = 0;
    candidateAssignedScores[ci] = 0;
  }

  const maxAssignments = Math.min(qLen, cLen);
  for (let step = 0; step < maxAssignments; step++) {
    let bestScore = 0;
    let bestQi = -1;
    let bestCi = -1;

    for (let qi = 0; qi < qLen; qi++) {
      if (usedQueryFlags[qi]) continue;
      const rowOffset = qi * cLen;
      for (let ci = 0; ci < cLen; ci++) {
        if (usedCandidateFlags[ci]) continue;
        const s = matrixScores[rowOffset + ci];
        if (s > bestScore) {
          bestScore = s;
          bestQi = qi;
          bestCi = ci;
        }
      }
    }

    if (bestScore <= 0 || bestQi === -1) break;

    usedQueryFlags[bestQi] = 1;
    usedCandidateFlags[bestCi] = 1;
    queryAssignedScores[bestQi] = bestScore;
    candidateAssignedScores[bestCi] = bestScore;
  }

  let weightedSumQuery = 0;
  for (let qi = 0; qi < qLen; qi++) {
    weightedSumQuery += queryAssignedScores[qi] * queryWeights[qi];
  }
  const queryCoverage = weightedSumQuery / queryTotalWeight;

  let weightedSumCandidate = 0;
  for (let ci = 0; ci < cLen; ci++) {
    weightedSumCandidate += candidateAssignedScores[ci] * candidateWeights[ci];
  }
  const candidateCoverage = weightedSumCandidate / candidateTotalWeight;

  if (queryCoverage === 0 || candidateCoverage === 0) return 0;
  return queryCoverage * (PARTIAL_MATCH_FLOOR + (1 - PARTIAL_MATCH_FLOOR) * candidateCoverage);
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
 * A candidate name's tokenized form, precomputed once (issue #42, #300) so a
 * search doesn't pay tokenizeGrouped/normalizeText/soundex/totalWeight's cost again for
 * every query against a candidate whose name hasn't changed since the last
 * import — none of that work depends on what's being searched for.
 */
export interface TokenizedName {
  name: string;
  wordGroups: TokenizedWord[][];
  weights: number[];
  totalWeight: number;
  normalizedName: string;
}

export function buildTokenizedName(name: string): TokenizedName {
  const wordGroups = annotateWithSoundex(tokenizeGrouped(name));
  const weights = computeWordWeights(wordGroups);
  let totalWeight = 0;
  for (let i = 0; i < weights.length; i++) totalWeight += weights[i];
  return { name, wordGroups, weights, totalWeight, normalizedName: normalizeText(name) };
}

/**
 * The query's own tokenized form, precomputed once per search (issue #42, #300)
 * rather than once per candidate record — the query is identical across
 * every candidate comparison within a single search.
 */
export interface TokenizedQuery {
  wordGroups: TokenizedWord[][];
  weights: number[];
  totalWeight: number;
  normalizedQuery: string;
}

export function buildTokenizedQuery(query: string): TokenizedQuery {
  const wordGroups = annotateWithSoundex(tokenizeGrouped(query));
  const weights = computeWordWeights(wordGroups);
  let totalWeight = 0;
  for (let i = 0; i < weights.length; i++) totalWeight += weights[i];
  return { wordGroups, weights, totalWeight, normalizedQuery: normalizeText(query) };
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
  for (const { name, wordGroups, weights, totalWeight, normalizedName } of candidates) {
    const rawScore = tokenSetScore(
      query.wordGroups,
      query.weights,
      query.totalWeight,
      wordGroups,
      weights,
      totalWeight,
    );
    const isLiteralMatch = query.normalizedQuery === normalizedName;
    const boundedScore = isLiteralMatch ? rawScore : Math.min(rawScore, NON_LITERAL_MATCH_CAP);
    const score = Math.round(boundedScore * 100);
    if (score > best.score) {
      best = { score, matchedName: name };
      if (score === 100) break;
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
