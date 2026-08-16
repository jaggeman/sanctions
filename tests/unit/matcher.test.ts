import { describe, it, expect } from 'vitest';
import {
  soundex,
  jaroWinkler,
  scoreNameMatch,
  scoreTokenizedNameMatch,
  buildTokenizedName,
  buildTokenizedQuery,
} from '../../src/search/matcher';

/**
 * This is genuinely new code (issue #11), so this is real TDD: these tests
 * were written before src/search/matcher.ts existed, including reference
 * values pulled from published sources rather than derived from the
 * implementation, so a broken implementation fails for the right reason.
 */

describe('soundex', () => {
  it('matches the textbook Robert/Rupert example', () => {
    expect(soundex('Robert')).toBe('R163');
    expect(soundex('Rupert')).toBe('R163');
  });

  it('unifies the four spellings the issue explicitly calls out', () => {
    const codes = new Set([
      soundex('Mohammed'),
      soundex('Muhammad'),
      soundex('Mohamed'),
      soundex('Muhammed'),
    ]);
    expect(codes.size).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(soundex('robert')).toBe(soundex('ROBERT'));
  });

  it('returns an empty string for empty input', () => {
    expect(soundex('')).toBe('');
  });

  it('produces different codes for genuinely different names', () => {
    expect(soundex('Putin')).not.toBe(soundex('Zelensky'));
  });

  // issue #40 requirement: soundex must never run meaningfully on raw
  // non-Latin input — it's a Latin-alphabet algorithm by construction, and a
  // coincidental code from garbage input would look like a real phonetic
  // match. It should keep safely no-op'ing (empty string), not be "fixed" to
  // produce a code from Cyrillic — that fix belongs in transliteration
  // upstream, not here.
  it('issue #40: still safely no-ops on raw Cyrillic rather than producing a meaningless code', () => {
    expect(soundex('Абу Нидал')).toBe('');
  });

  it('issue #40: still safely no-ops on raw Greek', () => {
    expect(soundex('Μαύρος')).toBe('');
  });
});

describe('jaroWinkler', () => {
  // Reference values from Winkler's own published test vectors (also the
  // values commonly cited on Wikipedia's Jaro-Winkler article) — not derived
  // from this implementation.
  it('matches the published MARTHA/MARHTA reference value', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 2);
  });

  it('matches the published DWAYNE/DUANE reference value', () => {
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
  });

  it('matches the published DIXON/DICKSONX reference value', () => {
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.813, 2);
  });

  it('returns 1 for identical strings', () => {
    expect(jaroWinkler('putin', 'putin')).toBe(1);
  });

  it('returns 0 for a comparison against an empty string', () => {
    expect(jaroWinkler('putin', '')).toBe(0);
    expect(jaroWinkler('', '')).toBe(0);
  });

  it('is symmetric', () => {
    expect(jaroWinkler('putin', 'zelensky')).toBeCloseTo(jaroWinkler('zelensky', 'putin'), 10);
  });
});

describe('scoreNameMatch', () => {
  it('gives a perfect score for an exact match', () => {
    const { score, matchedName } = scoreNameMatch('Vladimir Putin', ['Vladimir Putin']);
    expect(score).toBe(100);
    expect(matchedName).toBe('Vladimir Putin');
  });

  it('RECALIBRATED (issue #41): a single-word query against a much longer name no longer clears the match threshold', () => {
    // Was a "KEY CASE (issue #11)" asserting >= 65 (a perfect-sounding phonetic
    // hit on ONE word of a four-word name was treated as a likely match).
    // Fixing issue #41's asymmetric-scoring bug means candidate coverage now
    // counts for real: this query only explains ~1 of 4 real name parts, which
    // is structurally the same shape as the bug case below ("Al Hassan" also
    // covers only a fraction of its candidate). No coverage-ratio formula can
    // tell "legitimate first-name-only search" apart from "coincidental partial
    // overlap" without name-frequency data this codebase doesn't have — see
    // the PR description for the full tradeoff. Explicitly accepted: a bare
    // first name against a full multi-part name is now a weak signal, not a
    // confident match. It must still clearly beat a truly unrelated name.
    const { score } = scoreNameMatch('Qusay', ['Qoussaï Saddam Hussein Al-Tikriti']);
    const { score: unrelated } = scoreNameMatch('Qusay', ['Kim Jong Un']);
    expect(score).toBeLessThan(65);
    expect(score).toBeGreaterThan(unrelated);
  });

  it('KEY CASE (issue #11): "Mohammed" finds "Muhammad"-spelled records', () => {
    const { score } = scoreNameMatch('Mohammed Al-Amin', ['Muhammad Al-Amin']);
    expect(score).toBeGreaterThanOrEqual(65);
  });

  it('is insensitive to word order (token-set matching)', () => {
    const forward = scoreNameMatch('Saddam Hussein Al-Tikriti', ['Saddam Hussein Al-Tikriti']).score;
    const reordered = scoreNameMatch('Hussein Al-Tikriti, Saddam', ['Saddam Hussein Al-Tikriti']).score;
    expect(reordered).toBeGreaterThanOrEqual(forward - 5);
  });

  it('does not penalize a missing middle name', () => {
    const { score } = scoreNameMatch('Saddam Tikriti', ['Saddam Hussein Al-Tikriti']);
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('picks the best-matching alias, not just the primary name, and reports which one matched', () => {
    const { score, matchedName } = scoreNameMatch('Vova Putin', [
      'Vladimir Vladimirovich Putin',
      'Vova Putin',
    ]);
    expect(matchedName).toBe('Vova Putin');
    expect(score).toBe(100);
  });

  it('scores an unrelated name low', () => {
    const { score } = scoreNameMatch('Angela Merkel', ['Kim Jong Un']);
    expect(score).toBeLessThan(40);
  });

  it('handles an empty candidate list without throwing', () => {
    expect(scoreNameMatch('Anyone', [])).toEqual({ score: 0, matchedName: '' });
  });

  it('handles typos via edit distance, not just exact/phonetic', () => {
    const { score } = scoreNameMatch('Vladimir Putin', ['Vladmir Putin']); // missing an 'i'
    expect(score).toBeGreaterThanOrEqual(80);
  });
});

describe('scoreNameMatch — asymmetric token-set scoring bug (issue #41)', () => {
  it('BUG CASE: a short query fully contained in an unrelated long candidate no longer scores a perfect 100', () => {
    // Root cause: the old tokenSetScore only measured query->candidate
    // coverage. Every query word (even the generic particle "al") happened
    // to appear somewhere in this unrelated candidate, so it scored 100 —
    // indistinguishable from an exact match, and above DEFAULT_THRESHOLD (65).
    const { score } = scoreNameMatch('Al Hassan', ['Al-Tikriti Hassan Omar']);
    expect(score).toBeLessThan(65);
  });

  it('a candidate token cannot be consumed by more than one query word', () => {
    // Old tokenBestMatch never marked a candidate token "used", so both
    // query words independently matched the single candidate token at full
    // score, averaging to a perfect 100.
    const { score } = scoreNameMatch('Ali Ali', ['Ali']);
    expect(score).not.toBe(100);
  });

  it('a generic particle overlap alone does not manufacture a match', () => {
    const { score } = scoreNameMatch('Al Bin Omar', ['Al Rashid Bin Laden Al-Sayed']);
    expect(score).toBeLessThan(65);
  });

  it('same two name parts in reverse order score high but not a perfect 100 (order-blind, but not literally identical)', () => {
    const { score } = scoreNameMatch('Ali Hassan', ['Hassan Ali']);
    expect(score).toBeGreaterThanOrEqual(80);
    expect(score).toBeLessThan(100);
  });

  it('a genuine exact match still scores a perfect 100', () => {
    const { score } = scoreNameMatch('Vladimir Putin', ['Vladimir Putin']);
    expect(score).toBe(100);
  });

  it('an all-particle name is still searchable (particles are down-weighted, never stripped to empty)', () => {
    const { score } = scoreNameMatch('Abu Ali', ['Abu Ali']);
    expect(score).toBe(100);
  });
});

describe('scoreNameMatch — non-Latin script (issue #40)', () => {
  // Real strings from lists/20260805-FULL-1_1(xsd).xml, logicalId=201 (the
  // "Abu Nidal Organisation" entity, which the real EU export aliases across
  // dozens of languages/scripts) and logicalId=514 (a real Arabic alias).

  it('acceptance criterion: a Cyrillic query against an identical Cyrillic record scores ~100, not 0', () => {
    const { score } = scoreNameMatch('Абу Нидал', ['Абу Нидал']);
    expect(score).toBeGreaterThanOrEqual(95);
  });

  it('acceptance criterion: same for Greek', () => {
    const { score } = scoreNameMatch('Μαύρος Σεπτέμβρης', ['Μαύρος Σεπτέμβρης']);
    expect(score).toBeGreaterThanOrEqual(95);
  });

  it('acceptance criterion: same for Arabic', () => {
    const name = 'عبد المنان آغا';
    const { score } = scoreNameMatch(name, [name]);
    expect(score).toBeGreaterThanOrEqual(95);
  });

  it('acceptance criterion: a Latin query finds a record stored in Cyrillic (decision c, cross-script)', () => {
    const { score } = scoreNameMatch('Abu Nidal', ['Организация „Абу Нидал”']);
    expect(score).toBeGreaterThanOrEqual(65);
  });

  it('acceptance criterion: and the reverse — a Cyrillic query finds a record stored in Latin', () => {
    const { score } = scoreNameMatch('Абу Нидал', ['Abu Nidal Organisation']);
    expect(score).toBeGreaterThanOrEqual(65);
  });

  it('a Cyrillic query does not spuriously match an unrelated Latin name', () => {
    const { score } = scoreNameMatch('Абу Нидал', ['Kim Jong Un']);
    expect(score).toBeLessThan(40);
  });
});

// Issue #42: runSearch precomputes each candidate's tokenized form once at
// index-build time instead of re-tokenizing on every query. This is a "when
// is it computed" change, not a "what does it compute" change — this suite
// proves scoreTokenizedNameMatch over precomputed tokens returns exactly the
// same result as scoreNameMatch over raw strings for every case above that
// actually exercises the interesting behavior (transliteration, particle
// weighting, reversed order, typos), so the refactor can't have silently
// changed matching behavior.
describe('scoreTokenizedNameMatch — precomputed-index equivalence (issue #42)', () => {
  const cases: Array<[string, string[]]> = [
    ['Vladimir Putin', ['Vladimir Putin']],
    ['Qusay', ['Qoussaï Saddam Hussein Al-Tikriti']],
    ['Mohammed Al-Amin', ['Muhammad Al-Amin']],
    ['Saddam Hussein Al-Tikriti', ['Saddam Hussein Al-Tikriti']],
    ['Hussein Al-Tikriti, Saddam', ['Saddam Hussein Al-Tikriti']],
    ['Saddam Tikriti', ['Saddam Hussein Al-Tikriti']],
    ['Vova Putin', ['Vladimir Vladimirovich Putin', 'Vova Putin']],
    ['Angela Merkel', ['Kim Jong Un']],
    ['Anyone', []],
    ['Vladimir Putin', ['Vladmir Putin']],
    ['Al Hassan', ['Al-Tikriti Hassan Omar']],
    ['Ali Ali', ['Ali']],
    ['Al Bin Omar', ['Al Rashid Bin Laden Al-Sayed']],
    ['Ali Hassan', ['Hassan Ali']],
    ['Abu Ali', ['Abu Ali']],
    ['Абу Нидал', ['Абу Нидал']],
    ['Μαύρος Σεπτέμβρης', ['Μαύρος Σεπτέμβρης']],
    ['Abu Nidal', ['Организация „Абу Нидал”']],
    ['Абу Нидал', ['Abu Nidal Organisation']],
    ['Абу Нидал', ['Kim Jong Un']],
  ];

  it('produces byte-identical results to scoreNameMatch when candidates are pre-tokenized', () => {
    for (const [query, candidateNames] of cases) {
      const direct = scoreNameMatch(query, candidateNames);

      const tokenizedQuery = buildTokenizedQuery(query);
      const tokenizedCandidates = candidateNames.map(buildTokenizedName);
      const viaPrecomputedIndex = scoreTokenizedNameMatch(tokenizedQuery, tokenizedCandidates);

      expect(viaPrecomputedIndex, `query="${query}" candidates=${JSON.stringify(candidateNames)}`).toEqual(direct);
    }
  });
});

describe('short-word edit-distance false positives (issue #104)', () => {
  // The concrete case from the issue: jaroWinkler('qusay','musa') = 0.7833,
  // well above the old flat EDIT_DISTANCE_MATCH_THRESHOLD (0.75), despite
  // the two words being phonetically unrelated (soundex 'Q200' vs 'M200')
  // and semantically unrelated real aliases in the corpus. A raw JW score
  // on short words is coincidental far more often than the old flat
  // threshold accounted for — see the real-corpus calibration in this PR's
  // description for the fuller picture (many other short pairs coincide in
  // the 0.75-0.88 range with no phonetic or substring relationship at all).
  it('no longer matches "Qusay" against the unrelated alias "Musa"', () => {
    const { score } = scoreNameMatch('Qusay', ['Musa']);
    expect(score).toBe(0);
  });

  it('still rejects other short coincidental pairs with no phonetic backing', () => {
    expect(scoreNameMatch('Omar', ['Oman']).score).toBe(0);
    expect(scoreNameMatch('Angela', ['Jong']).score).toBe(0);
  });

  // Genuine short-name spelling variants must keep matching — this fix
  // tightens the threshold, it doesn't replace edit-distance matching with
  // phonetic-only matching (that would reject these too, since several of
  // them disagree on soundex despite being real variants).
  it('still matches genuine short-name spelling variants', () => {
    expect(scoreNameMatch('Ahmed', ['Ahmad']).score).toBeGreaterThan(0);
    expect(scoreNameMatch('Nasser', ['Nassar']).score).toBeGreaterThan(0);
    expect(scoreNameMatch('Hana', ['Hanan']).score).toBeGreaterThan(0);
    expect(scoreNameMatch('Musa', ['Musab']).score).toBeGreaterThan(0);
    expect(scoreNameMatch('Musa', ['Mousa']).score).toBeGreaterThan(0);
    expect(scoreNameMatch('Mahmoud', ['Mahmud']).score).toBeGreaterThan(0);
  });

  // DWAYNE/DUANE (the published JW reference pair, 0.84) stays a match even
  // though it's short — its soundex agrees (D500/D500), so it matches via
  // the phonetic path regardless of the stricter short-word JW bar.
  it('keeps matching a short pair whose JW score is below the new bar but whose soundex agrees', () => {
    expect(scoreNameMatch('Dwayne', ['Duane']).score).toBeGreaterThan(0);
  });
});
