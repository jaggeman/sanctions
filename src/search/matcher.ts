import { normalizeText } from '../importer/uploader';

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

/** Best similarity (0..1) between one query token and any candidate token. */
function tokenBestMatch(token: string, candidateTokens: string[]): number {
  let best = 0;
  for (const candidate of candidateTokens) {
    if (token === candidate) return 1;
    const phoneticScore = soundex(token) === soundex(candidate) && soundex(token) !== ''
      ? PHONETIC_MATCH_SCORE
      : 0;
    const minLen = Math.min(token.length, candidate.length);
    let editScore = 0;
    if (minLen >= MIN_LENGTH_FOR_EDIT_DISTANCE) {
      const jw = jaroWinkler(token, candidate);
      editScore = jw >= EDIT_DISTANCE_MATCH_THRESHOLD ? jw : 0;
    }
    best = Math.max(best, phoneticScore, editScore);
  }
  return best;
}

/**
 * Order-independent token-set score, 0..1: every query token is matched
 * against its single best-scoring candidate token. Extra candidate tokens
 * (e.g. a middle name the query omitted) are never penalised, and word order
 * doesn't matter, per issue #11's scope.
 */
function tokenSetScore(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;
  const perToken = queryTokens.map((t) => tokenBestMatch(t, candidateTokens));
  return perToken.reduce((sum, s) => sum + s, 0) / perToken.length;
}

export interface NameMatch {
  score: number; // 0..100
  matchedName: string;
}

/**
 * Scores a query against a list of candidate names (primary name + aliases),
 * returning the best-matching one and its 0..100 score. Reuses normalizeText
 * verbatim so query-side and index-side normalisation always agree.
 */
export function scoreNameMatch(query: string, candidateNames: string[]): NameMatch {
  const queryTokens = normalizeText(query).split(' ').filter(Boolean);
  if (queryTokens.length === 0 || candidateNames.length === 0) {
    return { score: 0, matchedName: '' };
  }

  let best: NameMatch = { score: 0, matchedName: '' };
  for (const name of candidateNames) {
    const candidateTokens = normalizeText(name).split(' ').filter(Boolean);
    const score = Math.round(tokenSetScore(queryTokens, candidateTokens) * 100);
    if (score > best.score) {
      best = { score, matchedName: name };
    }
  }
  return best;
}
