import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';
import {
  normalizeCountry,
  extractRecordCountries,
  evaluateCountryMatch,
} from '../../src/search/country';

const { fakeDb, state } = vi.hoisted(() => {
  const state = {
    allRecords: [] as SanctionRecord[],
  };
  const fakeDb = {
    collection: vi.fn((name: string) => {
      if (name === 'sanctions') {
        return {
          get: vi.fn(async () => ({
            docs: state.allRecords.map((r) => ({ data: () => r })),
          })),
        };
      }
      if (name === 'overrides') {
        return {
          get: vi.fn(async () => ({ docs: [] })),
        };
      }
      if (name === 'meta') {
        return {
          doc: vi.fn(() => ({
            get: vi.fn(async () => ({
              exists: true,
              data: () => ({ version: 1 }),
            })),
            set: vi.fn(async () => {}),
          })),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }),
  };
  return { fakeDb, state };
});

vi.mock('../../src/shared/firebase', () => ({
  db: fakeDb,
}));

const { runSearch, invalidateSearchIndex } = await import('../../src/search');

describe('Secondary attribute filtering: Nationality & Country matching (#319)', () => {
  describe('normalizeCountry', () => {
    it('normalizes 2-letter ISO codes', () => {
      expect(normalizeCountry('SE')).toBe('SE');
      expect(normalizeCountry('se')).toBe('SE');
      expect(normalizeCountry('RU')).toBe('RU');
      expect(normalizeCountry('SY')).toBe('SY');
      expect(normalizeCountry('US')).toBe('US');
    });

    it('normalizes 3-letter ISO codes', () => {
      expect(normalizeCountry('SWE')).toBe('SE');
      expect(normalizeCountry('RUS')).toBe('RU');
      expect(normalizeCountry('SYR')).toBe('SY');
      expect(normalizeCountry('USA')).toBe('US');
      expect(normalizeCountry('GBR')).toBe('GB');
      expect(normalizeCountry('UKR')).toBe('UA');
    });

    it('normalizes English country names and common aliases', () => {
      expect(normalizeCountry('Sweden')).toBe('SE');
      expect(normalizeCountry('Russia')).toBe('RU');
      expect(normalizeCountry('Russian Federation')).toBe('RU');
      expect(normalizeCountry('Syria')).toBe('SY');
      expect(normalizeCountry('Syrian Arab Republic')).toBe('SY');
      expect(normalizeCountry('United States')).toBe('US');
      expect(normalizeCountry('United States of America')).toBe('US');
      expect(normalizeCountry('United Kingdom')).toBe('GB');
      expect(normalizeCountry('UK')).toBe('GB');
      expect(normalizeCountry('Ukraine')).toBe('UA');
      expect(normalizeCountry('Iran')).toBe('IR');
      expect(normalizeCountry('Iraq')).toBe('IQ');
    });

    it('normalizes demonyms / nationalities', () => {
      expect(normalizeCountry('Swedish')).toBe('SE');
      expect(normalizeCountry('Russian')).toBe('RU');
      expect(normalizeCountry('Syrian')).toBe('SY');
      expect(normalizeCountry('American')).toBe('US');
      expect(normalizeCountry('British')).toBe('GB');
      expect(normalizeCountry('Ukrainian')).toBe('UA');
      expect(normalizeCountry('Iranian')).toBe('IR');
      expect(normalizeCountry('Iraqi')).toBe('IQ');
    });

    it('handles whitespace, punctuation, and case-insensitivity', () => {
      expect(normalizeCountry('  swedish  ')).toBe('SE');
      expect(normalizeCountry('RUSSIAN_FEDERATION')).toBe('RU');
      expect(normalizeCountry('')).toBeNull();
      expect(normalizeCountry(undefined as any)).toBeNull();
    });
  });

  describe('extractRecordCountries', () => {
    it('extracts countries from citizenships, addresses, and identifications', () => {
      const record: SanctionRecord = {
        id: 'UA-100',
        source: 'UA',
        type: 'individual',
        names: [{ wholeName: 'Test Target', strong: true }],
        searchNames: [],
        citizenships: ['Росія', 'Russian Federation'],
        addresses: [{ country: 'Syria', countryIso2: 'SY' }],
        identifications: [{ number: '123', countryIso2: 'RU' }],
        status: 'active',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      };

      const countries = extractRecordCountries(record);
      expect(countries.has('RU')).toBe(true);
      expect(countries.has('SY')).toBe(true);
      expect(countries.has('SE')).toBe(false);
    });

    it('returns empty set if record has no country attributes', () => {
      const record: SanctionRecord = {
        id: 'EU-100',
        source: 'EU',
        type: 'individual',
        names: [{ wholeName: 'Anonymous Person', strong: true }],
        searchNames: [],
        status: 'active',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      };

      const countries = extractRecordCountries(record);
      expect(countries.size).toBe(0);
    });
  });

  describe('evaluateCountryMatch', () => {
    const russianRecord: SanctionRecord = {
      id: 'RU-1',
      source: 'US',
      type: 'individual',
      names: [{ wholeName: 'Vladimir PUTIN', strong: true }],
      searchNames: [],
      citizenships: ['Russia'],
      status: 'active',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };

    const emptyRecord: SanctionRecord = {
      id: 'NO-1',
      source: 'EU',
      type: 'individual',
      names: [{ wholeName: 'Unknown Person', strong: true }],
      searchNames: [],
      status: 'active',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };

    it('returns status no_query when no country or nationality is provided', () => {
      const result = evaluateCountryMatch(undefined, russianRecord);
      expect(result.status).toBe('no_query');
      expect(result.boostApplied).toBe(false);
      expect(result.penaltyApplied).toBe(false);
    });

    it('returns status no_candidate_data when candidate has no country data', () => {
      const result = evaluateCountryMatch('Sweden', emptyRecord);
      expect(result.status).toBe('no_candidate_data');
      expect(result.boostApplied).toBe(false);
      expect(result.penaltyApplied).toBe(false);
    });

    it('returns status match and boostApplied=true when country matches', () => {
      const result = evaluateCountryMatch('Russian Federation', russianRecord);
      expect(result.status).toBe('match');
      expect(result.boostApplied).toBe(true);
      expect(result.penaltyApplied).toBe(false);
      expect(result.queryCountry).toBe('RU');
    });

    it('returns status mismatch and penaltyApplied=true when candidate country conflicts', () => {
      const result = evaluateCountryMatch('Sweden', russianRecord);
      expect(result.status).toBe('mismatch');
      expect(result.boostApplied).toBe(false);
      expect(result.penaltyApplied).toBe(true);
      expect(result.queryCountry).toBe('SE');
      expect(result.candidateCountries).toContain('RU');
    });
  });

  describe('runSearch with nationality/country options', () => {
    beforeEach(async () => {
      state.allRecords = [
        {
          id: 'target-russian',
          source: 'EU',
          type: 'individual',
          names: [{ wholeName: 'Vladimir PUTIN', strong: true }],
          searchNames: [],
          citizenships: ['Russia'],
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'target-no-country',
          source: 'EU',
          type: 'individual',
          names: [{ wholeName: 'Vladimir PUTIN', strong: true }],
          searchNames: [],
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      await invalidateSearchIndex();
    });

    it('applies corroboration bonus (+10) when nationality matches', async () => {
      const baselineRes = await runSearch('putin');
      const baselineScore = baselineRes.results.find((r) => r.id === 'target-russian')?.score || 0;

      const matchedRes = await runSearch('putin', { nationality: 'Russian' });
      const matchedHit = matchedRes.results.find((r) => r.id === 'target-russian');

      expect(matchedHit).toBeDefined();
      expect(matchedHit!.score).toBe(Math.min(100, baselineScore + 10));
      expect(matchedHit!.scoreBreakdown?.countryBoostApplied).toBe(true);
      expect(matchedHit!.scoreBreakdown?.countryPenaltyApplied).toBeUndefined();
    });

    it('applies mismatch penalty (-20) when nationality conflicts with explicit candidate country', async () => {
      const baselineRes = await runSearch('putin');
      const baselineScore = baselineRes.results.find((r) => r.id === 'target-russian')?.score || 0;

      const mismatchRes = await runSearch('putin', { nationality: 'Swedish' });
      const mismatchHit = mismatchRes.results.find((r) => r.id === 'target-russian');

      expect(mismatchHit).toBeDefined();
      expect(mismatchHit!.score).toBe(Math.max(0, baselineScore - 20));
      expect(mismatchHit!.scoreBreakdown?.countryPenaltyApplied).toBe(true);
      expect(mismatchHit!.scoreBreakdown?.countryBoostApplied).toBeUndefined();
      expect(mismatchHit!.scoreBreakdown?.countryMatchDetails?.status).toBe('mismatch');
    });

    it('does not penalize or boost a candidate without country data', async () => {
      const baselineRes = await runSearch('putin');
      const baselineScore = baselineRes.results.find((r) => r.id === 'target-no-country')?.score || 0;

      const res = await runSearch('putin', { nationality: 'Swedish' });
      const hit = res.results.find((r) => r.id === 'target-no-country');

      expect(hit).toBeDefined();
      expect(hit!.score).toBe(baselineScore);
      expect(hit!.scoreBreakdown?.countryBoostApplied).toBeUndefined();
      expect(hit!.scoreBreakdown?.countryPenaltyApplied).toBeUndefined();
    });

    it('supports country parameter as synonym for nationality in SearchOptions', async () => {
      const res = await runSearch('putin', { country: 'SE' });
      const hit = res.results.find((r) => r.id === 'target-russian');
      expect(hit?.scoreBreakdown?.countryPenaltyApplied).toBe(true);
    });
  });
});
