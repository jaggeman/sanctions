import { describe, it, expect } from 'vitest';
import {
  primaryNameOf,
  aliasNamesOf,
  allNamesOf,
  formatBirthDates,
  formatIdentifications,
} from '../../src/shared/types';
import type { NameAlias, BirthDate, Identification } from '../../src/shared/types';

describe('primaryNameOf', () => {
  it('picks whichever entry the parser ordered first, regardless of strong', () => {
    const names: NameAlias[] = [
      { wholeName: 'First Entry', strong: false },
      { wholeName: 'Strong Alias', strong: true },
    ];
    expect(primaryNameOf(names)).toBe('First Entry');
  });

  it('falls back to a placeholder for an empty list', () => {
    expect(primaryNameOf([])).toBe('Unknown Name');
  });
});

describe('aliasNamesOf', () => {
  it('excludes only the first entry, keeps the rest in order', () => {
    const names: NameAlias[] = [
      { wholeName: 'Real Name', strong: true },
      { wholeName: 'Alias A', strong: false },
      { wholeName: 'Alias B', strong: false },
    ];
    expect(aliasNamesOf(names)).toEqual(['Alias A', 'Alias B']);
  });

  it('does not deduplicate an alias that repeats the primary name string', () => {
    const names: NameAlias[] = [
      { wholeName: 'Same Name', strong: true },
      { wholeName: 'Same Name', strong: false },
    ];
    expect(aliasNamesOf(names)).toEqual(['Same Name']);
  });
});

describe('allNamesOf', () => {
  it('returns every wholeName, including the primary', () => {
    const names: NameAlias[] = [
      { wholeName: 'Real Name', strong: true },
      { wholeName: 'Alias A', strong: false },
    ];
    expect(allNamesOf(names)).toEqual(['Real Name', 'Alias A']);
  });
});

describe('formatBirthDates', () => {
  it('prefers the raw string when present', () => {
    const dates: BirthDate[] = [{ raw: '1952-10-07', year: 1952 }];
    expect(formatBirthDates(dates)).toEqual(['1952-10-07']);
  });

  it('formats a year range', () => {
    const dates: BirthDate[] = [{ yearRangeFrom: 1965, yearRangeTo: 1968 }];
    expect(formatBirthDates(dates)).toEqual(['1965-1968']);
  });

  it('formats a year-only value', () => {
    const dates: BirthDate[] = [{ year: 1966 }];
    expect(formatBirthDates(dates)).toEqual(['1966']);
  });

  it('formats a full year-month-day when no raw string is given', () => {
    const dates: BirthDate[] = [{ year: 1966, month: 4, day: 12 }];
    expect(formatBirthDates(dates)).toEqual(['1966-4-12']);
  });

  it('returns an empty array for undefined input', () => {
    expect(formatBirthDates(undefined)).toEqual([]);
  });
});

describe('formatIdentifications', () => {
  it('includes the type description and country when present', () => {
    const ids: Identification[] = [{ number: '12345', typeDescription: 'Passport', countryIso2: 'SE' }];
    expect(formatIdentifications(ids)).toEqual(['Passport 12345 (SE)']);
  });

  it('falls back to the bare number when there is no type or country', () => {
    const ids: Identification[] = [{ number: '12345' }];
    expect(formatIdentifications(ids)).toEqual(['12345']);
  });

  it('carries the source reliability flags through as a visible caveat, never silently', () => {
    const ids: Identification[] = [{ number: '12345', knownFalse: true, revokedByIssuer: true }];
    expect(formatIdentifications(ids)).toEqual(['12345 [known false, revoked]']);
  });

  it('returns an empty array for undefined input', () => {
    expect(formatIdentifications(undefined)).toEqual([]);
  });
});
