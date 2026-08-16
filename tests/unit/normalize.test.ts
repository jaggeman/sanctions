import { describe, it, expect, vi } from 'vitest';

// uploader.ts imports `db` from ../shared/firebase, which calls
// admin.initializeApp() at module load. The pure functions under test here need
// no database at all, so stub the module out — this keeps the unit layer truly
// offline (CLAUDE.md §1).
vi.mock('../../src/shared/firebase', () => ({
  db: {
    collection: () => ({ doc: () => ({}) }),
    batch: () => ({ set: () => {}, commit: async () => {} }),
    settings: () => {},
  },
}));

import { normalizeText, generateSearchTokens, transliterate } from '../../src/importer/uploader';

describe('normalizeText', () => {
  it('lowercases', () => {
    expect(normalizeText('VLADIMIR PUTIN')).toBe('vladimir putin');
  });

  it('strips diacritics so Swedish names match their unaccented spelling', () => {
    expect(normalizeText('Öland Ängström')).toBe('oland angstrom');
    expect(normalizeText('José Aznar')).toBe('jose aznar');
  });

  it('replaces punctuation with spaces rather than deleting it', () => {
    // "O'Brien" must not collapse to "obrien" — the apostrophe becomes a
    // separator, giving two tokens.
    expect(normalizeText("O'Brien")).toBe('o brien');
    expect(normalizeText('Smith-Jones')).toBe('smith jones');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(normalizeText('  Ivan   Ivanov  ')).toBe('ivan ivanov');
  });

  it('keeps digits', () => {
    expect(normalizeText('Boeing 747')).toBe('boeing 747');
  });

  it('returns empty string for empty / nullish input', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText(undefined as unknown as string)).toBe('');
    expect(normalizeText(null as unknown as string)).toBe('');
  });

  // --- issue #40: was erasing every non-Latin script to '', now preserves ---
  // any script's own letters (Unicode-aware \p{L}, not an ASCII a-z allowlist).
  // Real strings, not invented ones — sourced from lists/20260805-FULL-1_1(xsd).xml
  // (logicalId=201, the "Abu Nidal Organisation" entity, aliased across many
  // languages) and a real Arabic alias (logicalId=514).
  it('preserves Cyrillic script instead of erasing it (issue #40)', () => {
    expect(normalizeText('Абу Нидал')).not.toBe('');
    expect(normalizeText('Абу Нидал')).toBe('абу нидал');
  });

  it('preserves Greek script instead of erasing it (issue #40)', () => {
    expect(normalizeText('Μαύρος Σεπτέμβρης')).not.toBe('');
  });

  it('preserves Arabic script instead of erasing it (issue #40)', () => {
    expect(normalizeText('عبد المنان آغا')).not.toBe('');
  });

  it('preserves CJK script instead of erasing it (issue #40)', () => {
    expect(normalizeText('习近平')).not.toBe('');
    expect(normalizeText('习近平')).toBe('习近平');
  });

  it('a mixed-script name preserves both scripts, not just the Latin part (issue #40)', () => {
    const result = normalizeText('Владимир Putin');
    expect(result).toContain('putin');
    expect(result).toContain('владимир');
  });

  it('an exact self-comparison is identical regardless of script (the actual issue #40 bug)', () => {
    // This is the literal failure mode: querying a name against itself must
    // never silently become '' === '' by both sides collapsing to empty.
    const cyrillic = normalizeText('Организация „Абу Нидал”');
    expect(cyrillic).not.toBe('');
    expect(normalizeText('Организация „Абу Нидал”')).toBe(cyrillic);
  });
});

describe('transliterate — Cyrillic/Greek cross-script matching (issue #40, decision c)', () => {
  it('transliterates a real Cyrillic alias to a Latin-readable form', () => {
    // From logicalId=201 — "Абу Нидал" (Abu Nidal) embedded in a Bulgarian alias.
    expect(transliterate('Абу Нидал')).toBe('abu nidal');
  });

  it('transliterates only the non-Latin part of a mixed-script string', () => {
    expect(transliterate('Abu Нидал')).toBe('abu nidal');
  });

  it('transliterates Greek text to a Latin-readable form', () => {
    const result = transliterate('Μαύρος Σεπτέμβρης');
    expect(result).not.toBeNull();
    expect(result).toMatch(/^[a-z\s]+$/);
  });

  it('returns null for pure-Latin text — nothing to add to the token set', () => {
    expect(transliterate('Vladimir Putin')).toBeNull();
  });

  it('returns null for Arabic — explicitly out of scope for this pass (documented in the PR)', () => {
    expect(transliterate('عبد المنان آغا')).toBeNull();
  });

  it('returns null for CJK — explicitly out of scope for this pass', () => {
    expect(transliterate('习近平')).toBeNull();
  });

  it('handles empty input without throwing', () => {
    expect(transliterate('')).toBeNull();
  });
});

// issue #46: generateSearchTokens now takes the record's structured `names`
// (NameAlias[]) directly rather than a separate (primaryName, aliases) pair
// — every wholeName contributes tokens the same way, so this just builds the
// array these tests need.
function names(...wholeNames: string[]): { wholeName: string; strong: boolean }[] {
  return wholeNames.map((wholeName, i) => ({ wholeName, strong: i === 0 }));
}

describe('generateSearchTokens', () => {
  it('splits a primary name into word tokens', () => {
    expect(generateSearchTokens(names('Vladimir Putin'))).toEqual(['vladimir', 'putin']);
  });

  it('includes alias tokens alongside the primary name', () => {
    const tokens = generateSearchTokens(names('Vladimir Putin', 'Vova Putin'));
    expect(tokens).toContain('vladimir');
    expect(tokens).toContain('putin');
    expect(tokens).toContain('vova');
  });

  it('de-duplicates tokens shared between the name and its aliases', () => {
    const tokens = generateSearchTokens(names('Vladimir Putin', 'Vladimir Putin', 'V. Putin'));
    expect(tokens.filter((t) => t === 'putin')).toHaveLength(1);
    expect(tokens.filter((t) => t === 'vladimir')).toHaveLength(1);
  });

  it('handles a single-entry names array', () => {
    expect(() => generateSearchTokens(names('Solo Name'))).not.toThrow();
    expect(generateSearchTokens(names('Solo Name'))).toEqual(['solo', 'name']);
  });

  it('normalises tokens, so an accented alias is findable by plain spelling', () => {
    expect(generateSearchTokens(names('José Aznar'))).toEqual(['jose', 'aznar']);
  });

  it('drops single-character tokens', () => {
    // "V. Putin" → "v putin" → the initial "v" is below the 2-char index floor.
    expect(generateSearchTokens(names('V. Putin'))).toEqual(['putin']);
  });

  it('KNOWN LIMITATION (unrelated to issue #40): the 2-character floor still applies', () => {
    expect(generateSearchTokens(names('Xi'))).toEqual(['xi']); // 2 chars — just makes it
    expect(generateSearchTokens(names('Y Z'))).toEqual([]);    // every token too short
  });

  it('issue #40: a CJK name now yields its own token instead of none', () => {
    expect(generateSearchTokens(names('习近平'))).toEqual(['习近平']);
  });

  it('issue #40: a Cyrillic name yields both its own token and a transliterated one', () => {
    const tokens = generateSearchTokens(names('Абу Нидал'));
    expect(tokens).toContain('абу');
    expect(tokens).toContain('нидал');
    expect(tokens).toContain('abu');
    expect(tokens).toContain('nidal');
  });

  it('handles an empty names array without throwing', () => {
    expect(generateSearchTokens([])).toEqual([]);
  });
});
