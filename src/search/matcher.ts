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
 * A first-letter transliteration SUBSTITUTION (issue #252): "osama"/"usama"
 * (O250/U250), "wagner"/"vagner" (W256/V256) share identical Soundex DIGITS
 * — the code minus its verbatim first letter — yet never agree on the full
 * code, since classic Soundex keeps the first letter as-is. JW alone can't
 * safely carry this either: it already takes the #239 first-char-mismatch
 * penalty above, which pushes it below #104's short-word bar (0.9). Both
 * mechanisms miss the same case together.
 *
 * A plain "digits agree + JW >= 0.85, any differing first letter" rule (the
 * issue's own literal proposal) was measured against the real UN + US SDN
 * corpus before landing this (throwaway calibration script, not committed,
 * per CLAUDE.md §1): across ~31,000 distinct real corpus words, 3,938
 * same-length/digit-agreeing/differing-first-letter pairs cleared JW >= 0.85
 * — the overwhelming majority pure coincidence with no linguistic
 * relationship at all (e.g. "perez"/"jerez", "jorge"/"norge", "daras"/
 * "arash"), scoring identically to the four genuine reported pairs (JW
 * 0.8667-0.8889 for both). A JW floor cannot separate them — this is
 * exactly #104's original short-word problem, relocated to a new signal.
 *
 * Restricting to the issue's own suggested alternative — a first-letter
 * EQUIVALENCE CLASS table, only firing within a documented
 * romanization-confusion group — cut that to 350 (91% reduction), and a full
 * manual read of all 350 found them overwhelmingly plausible real variants
 * (jamal/gamal, omari/umari, ghazali/khazali, wakil/vakil, geremias/
 * jeremias...). Both the class restriction AND the JW floor are kept: the
 * class narrows WHICH letter swaps are even considered, the floor still
 * separates a genuine variant from a same-class coincidence within it (this
 * is what keeps "gaddafi"/"khadafy" — G/K, a real class member, JW 0.7143 —
 * correctly unmatched and out of scope, per the issue).
 *
 * Scored below a full phonetic match (PHONETIC_MATCH_SCORE): a first-letter
 * divergence is genuinely weaker evidence than full phonetic agreement.
 *
 * Digit + class agreement alone can't tell this from a DROPPED first letter
 * (issue #239's "linda"/"inda": L530/I530 also agree on digits, JW 0.9333,
 * and L/I isn't even in a class together here anyway — but must stay
 * rejected regardless) — only requiring equal word length reliably does,
 * since every real substitution case here keeps the word the same length
 * while a deletion necessarily doesn't. See `pairScore`'s length check.
 */
const FIRST_LETTER_VARIANT_MIN_JW = 0.85;
const PHONETIC_MATCH_SCORE_FIRST_LETTER_VARIANT = 0.8;

// Documented romanization-confusion groups for a sanctions-relevant name's
// FIRST letter only — not a general transliteration table. Kept narrow and
// literal to the issue's own examples plus what the corpus calibration above
// actually confirmed as real, rather than a broad phonetic-similarity guess.
// Lowercase throughout: `pairScore` only ever sees already-normalized (see
// `normalizeText`), already-lowercased token text, so there is nothing to
// case-fold here at match time.
const FIRST_LETTER_EQUIVALENCE_CLASSES: string[][] = [
  ['o', 'u'], ['v', 'w'], ['y', 'j', 'i'], ['g', 'j'], ['g', 'q', 'k'], ['c', 'k', 's'], ['f', 'p'],
];

/**
 * Flattened once, at module load, into a Set of sorted 2-letter keys for an
 * O(1) lookup instead of `.some()` scanning up to 7 small arrays with
 * `.includes()` on every single query-word × candidate-word pair across an
 * entire search — this runs inside `pairScore`, the hottest loop in the
 * matcher (issue #252's initial version regressed issue #42's own p95
 * latency benchmark from ~1.5s to ~2.46s at 50k-record scale; the array scan
 * was the measured cause).
 */
const FIRST_LETTER_EQUIVALENCE_PAIRS: Set<string> = new Set();
for (const cls of FIRST_LETTER_EQUIVALENCE_CLASSES) {
  for (let i = 0; i < cls.length; i++) {
    for (let j = i + 1; j < cls.length; j++) {
      const [a, b] = [cls[i], cls[j]].sort();
      FIRST_LETTER_EQUIVALENCE_PAIRS.add(a + b);
    }
  }
}

function firstLettersInSameClass(a: string, b: string): boolean {
  return FIRST_LETTER_EQUIVALENCE_PAIRS.has(a < b ? a + b : b + a);
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
  const firstCharMatches = token.text[0] === candidate.text[0];

  // issue #252: same Soundex DIGITS with a differing first letter, on words
  // of EQUAL length — the equal-length requirement is what stops this from
  // also catching issue #239's "linda"/"inda" (a dropped first letter, not a
  // substituted one), which shares the same digit agreement but a different
  // length. Ordered cheapest-first: this is the hottest loop in the matcher,
  // run for every query-word × candidate-word pair across the whole index on
  // every search, so a pair with a different length (the common case) or a
  // first letter outside any equivalence class never reaches the Set lookup
  // or the string .slice() allocation at the end.
  const digitsAgree =
    !soundexAgrees &&
    !firstCharMatches &&
    token.text.length === candidate.text.length &&
    token.soundex.length === 4 &&
    candidate.soundex.length === 4 &&
    firstLettersInSameClass(token.text[0], candidate.text[0]) &&
    token.soundex.slice(1) === candidate.soundex.slice(1);

  // With no phonetic, first-letter-variant, or edit-distance path open there
  // is no way to score at all, so skip Jaro-Winkler entirely. This function
  // runs for every query-word × candidate-word pair across the whole index
  // on every search, and JW is by far the most expensive part of it.
  if (!soundexAgrees && !digitsAgree && !canUseEditDistance) return 0;

  const rawJw = jaroWinkler(token.text, candidate.text);
  // The first-character penalty applies before every threshold comparison
  // below, not after, so a name that only resembles the query once its initial
  // is ignored fails the bar outright rather than landing just under it as a
  // weak partial signal (issue #239).
  const jw = rawJw * (firstCharMatches ? 1 : FIRST_CHAR_MISMATCH_PENALTY);

  const phoneticScore = soundexAgrees
    ? (jw >= PHONETIC_CORROBORATION_MIN_JW ? PHONETIC_MATCH_SCORE : PHONETIC_MATCH_SCORE_UNCORROBORATED)
    // digitsAgree is judged against the RAW (unpenalized) JW: the #239
    // penalty above exists to catch a dropped/added character riding JW's
    // no-penalty-for-a-differing-prefix blind spot, which is a different
    // failure mode from this signal's own digit-agreement + length check.
    : (digitsAgree && rawJw >= FIRST_LETTER_VARIANT_MIN_JW ? PHONETIC_MATCH_SCORE_FIRST_LETTER_VARIANT : 0);

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
