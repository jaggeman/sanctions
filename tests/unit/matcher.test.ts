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

  it('RE-RECALIBRATED (issue #239): a single-word query against a much longer name clears the threshold again, but weakly', () => {
    // History, because this one assertion has now flipped twice:
    //   #11  asserted >= 65 — a first-name search should find the person.
    //   #41  flipped it to < 65 while fixing asymmetric scoring, reasoning
    //        that no coverage ratio can tell "legitimate first-name-only
    //        search" from "coincidental partial overlap" without name-
    //        frequency data, and explicitly accepting a bare first name as a
    //        weak signal rather than a confident match.
    //   #239 flips it back, because measuring against the real corpora showed
    //        what that cost: 88% of "kim", 75% of "ali" and 80% of
    //        "mohammed" vanished from results entirely. In sanctions
    //        screening a false negative clears someone who IS listed; a false
    //        positive costs one row of human review. Not symmetric.
    //
    // #41's reasoning was right that the two cases are structurally alike.
    // The resolution isn't to tell them apart — it's to stop treating "weak"
    // as "invisible". A partial match now surfaces, ranked well below a full
    // one, rather than being filtered out of the result set altogether.
    const { score } = scoreNameMatch('Qusay', ['Qoussaï Saddam Hussein Al-Tikriti']);
    const { score: unrelated } = scoreNameMatch('Qusay', ['Kim Jong Un']);
    const { score: full } = scoreNameMatch('Qoussaï Saddam Hussein Al-Tikriti', ['Qoussaï Saddam Hussein Al-Tikriti']);

    expect(score).toBeGreaterThanOrEqual(65);
    expect(score).toBeGreaterThan(unrelated);
    expect(score).toBeLessThan(full);
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
    //
    // issue #239 narrowed this assertion from "< 65" (filtered out entirely)
    // to "clearly below a full match". The defect here was never that the
    // record surfaced — "Hassan" genuinely IS one of its name parts, and a
    // screening tool should show that — it was that a partial overlap was
    // indistinguishable from an exact hit. That property is what this test
    // guards now. The case where the overlap is ONLY generic particles, with
    // no real name part behind it, must still be filtered out, and is
    // asserted separately below.
    const { score } = scoreNameMatch('Al Hassan', ['Al-Tikriti Hassan Omar']);
    const { score: full } = scoreNameMatch('Al-Tikriti Hassan Omar', ['Al-Tikriti Hassan Omar']);

    expect(full).toBe(100);
    expect(score).toBeLessThan(90);
    expect(full - score).toBeGreaterThanOrEqual(15);
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

/**
 * Partial-name recall (issue #239).
 *
 * Measured against the real UN + US SDN corpora, a single-name query missed
 * up to 88% of the records that literally contain that name: "kim" returned
 * 20 of 80, "ali" 110 of 423. `ALI HASSAN AL-MAJID AL-TIKRITI` scored 36 for
 * the query "ali", and searching "linda" returned two vessels while hiding
 * `Linda Elizabeth CAMPOS TIRADO` (40).
 *
 * The cause was arithmetic, not tuning. #41 made tokenSetScore symmetric via
 * the harmonic mean (F1) of query- and candidate-coverage, which caps a
 * one-word query at 2·1·(1/n) / (1 + 1/n) against an n-word name — 50 for
 * three words, 40 for four — regardless of how good the match actually is.
 * DEFAULT_THRESHOLD (65) sat in the gap between the 2-word case (67) and the
 * 3-word case (50), so surname search worked on two-word names and silently
 * failed on everything longer. Most sanctions records are 3+ words.
 *
 * This deliberately REVERSES the tradeoff #41 accepted ("a bare first name
 * against a full multi-part name is now a weak signal"). In sanctions
 * screening a false negative means clearing someone who is actually listed;
 * a false positive means one extra row for a human to dismiss. Those are not
 * symmetric costs. What #41 actually had to prevent — a partial overlap being
 * indistinguishable from an exact match at 100 — is still prevented, and is
 * asserted below: partial matches surface, but always rank beneath a full one.
 */
describe('partial-name recall (issue #239)', () => {
  // The exact curve that produced the bug. Every row must clear the 65
  // threshold, so that a surname stays findable no matter how many given
  // names, patronymics or honorifics the record happens to carry.
  it('a one-word query stays above threshold against a candidate of any length', () => {
    const candidates = [
      'KIM',
      'KIM JONG',
      'KIM KWANG IL',
      'KIM KWANG IL SUN',
      'KIM KWANG IL SUN MYONG',
    ];
    for (const candidate of candidates) {
      const { score } = scoreNameMatch('Kim', [candidate]);
      expect(
        score,
        `"Kim" vs ${candidate.split(' ').length}-word "${candidate}" scored ${score}`,
      ).toBeGreaterThanOrEqual(65);
    }
  });

  it('score still decreases as the candidate carries more unexplained name parts', () => {
    // Recall must not come at the cost of ranking: a fuller match outranks a
    // thinner one, even though both now clear the threshold.
    const one = scoreNameMatch('Kim', ['KIM']).score;
    const three = scoreNameMatch('Kim', ['KIM KWANG IL']).score;
    const five = scoreNameMatch('Kim', ['KIM KWANG IL SUN MYONG']).score;
    expect(one).toBeGreaterThan(three);
    expect(three).toBeGreaterThan(five);
  });

  it('a partial match never reaches the score of a full match on the same record', () => {
    // This is the property #41 genuinely needed: "Al Hassan" must not be
    // indistinguishable from an exact hit. It may surface; it may not tie.
    const partial = scoreNameMatch('Al Hassan', ['Al-Tikriti Hassan Omar']).score;
    const full = scoreNameMatch('Al-Tikriti Hassan Omar', ['Al-Tikriti Hassan Omar']).score;
    expect(full).toBe(100);
    expect(partial).toBeLessThan(full);
    expect(partial).toBeLessThan(90);
  });

  it('the reported case: "linda" finds the real Linda and ranks her above the vessels', () => {
    const real = scoreNameMatch('linda', ['Linda Elizabeth CAMPOS TIRADO']).score;
    const droppedInitial = scoreNameMatch('linda', ['INDA']).score;
    const soundexOnly = scoreNameMatch('linda', ['LAMD']).score;

    expect(real).toBeGreaterThanOrEqual(65);
    expect(real).toBeGreaterThan(droppedInitial);
    expect(real).toBeGreaterThan(soundexOnly);
  });

  it('a first-name-only query finds the person (reverses the tradeoff #41 accepted)', () => {
    const { score } = scoreNameMatch('Qusay', ['Qoussaï Saddam Hussein Al-Tikriti']);
    expect(score).toBeGreaterThanOrEqual(65);
  });

  it('a genuinely unrelated name still scores far below any partial match', () => {
    const partial = scoreNameMatch('Kim', ['KIM KWANG IL SUN MYONG']).score;
    const unrelated = scoreNameMatch('Kim', ['Vladimir Vladimirovich Putin']).score;
    expect(unrelated).toBeLessThan(65);
    expect(partial).toBeGreaterThan(unrelated + 20);
  });
});

/**
 * Phonetic-only matches must not outrank textual ones (issue #239).
 *
 * PHONETIC_MATCH_SCORE was 0.85 — above DEFAULT_THRESHOLD (65) — so every
 * Soundex collision was guaranteed to surface as a hit, in the UI's orange
 * "warning" band. Soundex is a 4-character code and collides densely: over
 * the real corpus, M200 covers 174 distinct spellings (musa, mzee, mihigo,
 * mwissa…), A134 covers 159. Searching "musa" returned 23 results whose only
 * relationship to the query was the shared code: 3MG, MAK, MIKE, MYC.
 *
 * No threshold a user could set removed that noise without also removing
 * every genuine fuzzy match, because the noise was pinned ABOVE the real
 * variants. Soundex is now a corroborating signal, not a decisive one.
 */
describe('phonetic matching is corroborating, not decisive (issue #239)', () => {
  it('a shared soundex code alone does not clear the threshold', () => {
    // linda/lamd, musa/mzee: same code, no textual similarity whatsoever.
    expect(scoreNameMatch('linda', ['LAMD']).score).toBeLessThan(65);
    expect(scoreNameMatch('musa', ['MZEE']).score).toBeLessThan(65);
    expect(scoreNameMatch('saif', ['SPP']).score).toBeLessThan(65);
  });

  it('but genuine phonetic spelling variants still match', () => {
    // These agree phonetically AND are textually close, which is what
    // separates a real variant from a code collision.
    expect(scoreNameMatch('Mohammed Al-Amin', ['Muhammad Al-Amin']).score).toBeGreaterThanOrEqual(65);
    expect(scoreNameMatch('Ahmed', ['Ahmad']).score).toBeGreaterThan(0);
    expect(scoreNameMatch('Dwayne', ['Duane']).score).toBeGreaterThan(0);
  });
});

/**
 * A differing first character is strong evidence of a different name
 * (issue #239). Jaro-Winkler only ever REWARDS a shared prefix; it has no
 * penalty for a differing one, so "linda"/"inda" scored 0.9333 — above the
 * short-word bar from #104 — purely by dropping the most identifying
 * character in the string.
 */
describe('first-character disagreement (issue #239)', () => {
  it('a dropped or changed initial no longer scores as a near-identical name', () => {
    expect(scoreNameMatch('linda', ['INDA']).score).toBeLessThan(90);
  });

  it('does not disturb names that agree on their first character', () => {
    expect(scoreNameMatch('Vladimir Putin', ['Vladmir Putin']).score).toBeGreaterThanOrEqual(80);
    expect(scoreNameMatch('Nasser', ['Nassar']).score).toBeGreaterThan(0);
  });
});

/**
 * First-letter transliteration variants (issue #252).
 *
 * A single-character difference in the FIRST letter scored 0 — not low, zero
 * — because both mechanisms share that blind spot and so failed together
 * instead of covering for each other: Soundex retains the first letter
 * verbatim (Russell Soundex is defined that way), and a first-char change
 * costs a short name ~0.11 of Jaro-Winkler while also forfeiting the Winkler
 * prefix bonus, landing it just under #104's 0.9 short-word bar.
 *
 * This is the dominant transliteration axis in sanctions data (O/U, V/W,
 * Y/J, G/J), and these are real list entries, not hypothetical spellings:
 * `CHVK VAGNER` and `CHASTNAYA VOENNAYA KOMPANIYA 'VAGNER'` are alias
 * records on the OFAC SDN list, so a user screening "Wagner" missed them.
 *
 * The rule: a first-character difference is a transliteration variant when
 * the Soundex DIGITS agree (i.e. the phonetic body is identical, only the
 * retained initial differs) AND either the tail after the initial is
 * identical, or Jaro-Winkler is very high. That deliberately does NOT
 * readmit linda/inda from #239 — dropping an initial leaves a tail that
 * does not match ("inda" vs "nda") and JW 0.9333 is below the bar.
 */
describe('first-letter transliteration variants (issue #252)', () => {
  it('matches the real OFAC/UN spellings a screening user would miss', () => {
    // Every pair here is a real listed spelling vs. the common rendering.
    expect(scoreNameMatch('Osama bin Laden', ['USAMA BIN LADEN']).score).toBeGreaterThanOrEqual(65);
    expect(scoreNameMatch('Wagner Group', ['Vagner Group']).score).toBeGreaterThanOrEqual(65);
    expect(scoreNameMatch('Yusuf Ahmed', ['Jusuf Ahmed']).score).toBeGreaterThanOrEqual(65);
    expect(scoreNameMatch('Osama', ['USAMA']).score).toBeGreaterThanOrEqual(65);
  });

  it('does not regress the control cases that already worked', () => {
    expect(scoreNameMatch('Usama bin Laden', ['USAMA BIN LADEN']).score).toBe(100);
    // This one scored 98 before #239 and must not be collateral damage of
    // the first-character penalty that issue introduced.
    expect(scoreNameMatch('Yevgeny Prigozhin', ['Evgeny PRIGOZHIN']).score).toBeGreaterThanOrEqual(65);
  });

  it('still rejects a dropped initial whose tail does not survive (issue #239)', () => {
    // The distinction that makes both issues satisfiable at once: a
    // SUBSTITUTED initial leaves the rest of the word intact, a DROPPED one
    // does not. linda/inda must stay out; it is why "linda" returned a
    // vessel instead of a person.
    expect(scoreNameMatch('linda', ['INDA']).score).toBeLessThan(65);
    expect(scoreNameMatch('linda', ['LAMD']).score).toBeLessThan(65);
  });

  it('does not manufacture matches from a shared soundex body alone', () => {
    // Same soundex digits, first char differs, but neither tail nor JW
    // supports it — must stay rejected.
    expect(scoreNameMatch('Qusay', ['Musa']).score).toBe(0);
    expect(scoreNameMatch('musa', ['MZEE']).score).toBeLessThan(65);
  });
});
