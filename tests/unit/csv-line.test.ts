import { describe, it, expect } from 'vitest';
import { parseCSVLine } from '../../src/importer/parsers/csv';

describe('parseCSVLine', () => {
  it('splits on the default comma separator', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('splits on an explicit separator', () => {
    expect(parseCSVLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a separator that sits inside quotes', () => {
    expect(parseCSVLine('"Storgatan 12; Stockholm";SE', ';'))
      .toEqual(['Storgatan 12; Stockholm', 'SE']);
  });

  it('unescapes a doubled quote into a single literal quote', () => {
    expect(parseCSVLine('"say ""hi""";next', ';')).toEqual(['say "hi"', 'next']);
  });

  it('preserves empty fields between separators', () => {
    expect(parseCSVLine('a;;c', ';')).toEqual(['a', '', 'c']);
  });

  it('emits a trailing empty field when the line ends on a separator', () => {
    expect(parseCSVLine('a;b;', ';')).toEqual(['a', 'b', '']);
  });

  it('returns a single empty field for an empty line', () => {
    expect(parseCSVLine('', ';')).toEqual(['']);
  });

  it('trims surrounding whitespace from each field', () => {
    expect(parseCSVLine('  a ;  b  ;c ', ';')).toEqual(['a', 'b', 'c']);
  });

  it('does not treat the other common separator as special', () => {
    // Parsing a comma-separated line with a semicolon separator yields one field.
    expect(parseCSVLine('a,b,c', ';')).toEqual(['a,b,c']);
  });

  // --- Characterisation: trimming is applied after quote handling. ---
  // A quoted field whose value is deliberately padded loses that padding. This
  // is almost always what you want for names, but it means the parser cannot
  // round-trip a value with significant leading/trailing spaces.
  it('KNOWN BEHAVIOUR: strips padding even inside quotes', () => {
    expect(parseCSVLine('"  padded  ";b', ';')).toEqual(['padded', 'b']);
  });
});
