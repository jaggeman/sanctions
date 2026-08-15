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

import { normalizeText, generateSearchTokens } from '../../src/importer/uploader';

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

  // --- Characterisation of a real limitation, not an endorsement of it. ---
  // The [^a-z0-9\s] filter erases every non-Latin script. Any Cyrillic, Greek,
  // Arabic or CJK name normalises to the empty string, which means it can never
  // be indexed or searched. Tracked as a known gap, see the issue referenced in
  // the PR — this test exists so the day someone fixes it, it fails loudly and
  // tells them to update the expectation.
  it('KNOWN GAP: erases non-Latin scripts entirely', () => {
    expect(normalizeText('Путин')).toBe('');
    expect(normalizeText('习近平')).toBe('');
    expect(normalizeText('محمد')).toBe('');
  });

  it('KNOWN GAP: a mixed-script name keeps only its Latin part', () => {
    expect(normalizeText('Владимир Putin')).toBe('putin');
  });
});

describe('generateSearchTokens', () => {
  it('splits a primary name into word tokens', () => {
    expect(generateSearchTokens('Vladimir Putin')).toEqual(['vladimir', 'putin']);
  });

  it('includes alias tokens alongside the primary name', () => {
    const tokens = generateSearchTokens('Vladimir Putin', ['Vova Putin']);
    expect(tokens).toContain('vladimir');
    expect(tokens).toContain('putin');
    expect(tokens).toContain('vova');
  });

  it('de-duplicates tokens shared between the name and its aliases', () => {
    const tokens = generateSearchTokens('Vladimir Putin', ['Vladimir Putin', 'V. Putin']);
    expect(tokens.filter((t) => t === 'putin')).toHaveLength(1);
    expect(tokens.filter((t) => t === 'vladimir')).toHaveLength(1);
  });

  it('defaults to no aliases when the argument is omitted', () => {
    expect(() => generateSearchTokens('Solo Name')).not.toThrow();
    expect(generateSearchTokens('Solo Name')).toEqual(['solo', 'name']);
  });

  it('normalises tokens, so an accented alias is findable by plain spelling', () => {
    expect(generateSearchTokens('José Aznar')).toEqual(['jose', 'aznar']);
  });

  it('drops single-character tokens', () => {
    // "V. Putin" → "v putin" → the initial "v" is below the 2-char index floor.
    expect(generateSearchTokens('V. Putin')).toEqual(['putin']);
  });

  // --- Characterisation of a real limitation. ---
  // The 2-character floor combined with the Latin-only filter means some real
  // names produce NO tokens whatsoever, making the record permanently
  // unsearchable by name.
  it('KNOWN GAP: yields no tokens at all for a short or non-Latin name', () => {
    expect(generateSearchTokens('Xi')).toEqual(['xi']); // 2 chars — just makes it
    expect(generateSearchTokens('Y Z')).toEqual([]);    // every token too short
    expect(generateSearchTokens('习近平')).toEqual([]);   // non-Latin, erased
  });

  it('handles an empty primary name without throwing', () => {
    expect(generateSearchTokens('')).toEqual([]);
  });
});
