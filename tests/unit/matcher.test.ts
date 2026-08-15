import { describe, it, expect } from 'vitest';
import { soundex, jaroWinkler, scoreNameMatch } from '../../src/search/matcher';

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

  it('KEY CASE (issue #11): "Qusay" finds the French transliteration "Qoussaï" via phonetics', () => {
    const { score } = scoreNameMatch('Qusay', ['Qoussaï Saddam Hussein Al-Tikriti']);
    expect(score).toBeGreaterThanOrEqual(65);
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
