import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SanctionRecord } from '../../src/shared/types';
import {
  buildTokenizedQuery,
  buildTokenizedName,
  explainTokenizedNameMatch,
} from '../../src/search/matcher';

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

describe('Search score breakdown & explanation (issue #277)', () => {
  describe('Matcher explanation (explainTokenizedNameMatch)', () => {
    it('explains partial match for 1-word query against 3-word name', () => {
      const q = buildTokenizedQuery('putin');
      const cand = buildTokenizedName('Vladimir Vladimirovich PUTIN');

      const breakdown = explainTokenizedNameMatch(q, cand);

      expect(breakdown.mechanism).toBe('name');
      expect(breakdown.matchedWords).toHaveLength(1);
      expect(breakdown.matchedWords[0].queryWord.toLowerCase()).toBe('putin');
      expect(breakdown.matchedWords[0].candidateWord.toUpperCase()).toBe('PUTIN');
      expect(breakdown.matchedWords[0].score).toBeGreaterThanOrEqual(95);

      expect(breakdown.unmatchedQueryWords).toHaveLength(0);
      expect(breakdown.unmatchedCandidateWords).toHaveLength(2);
      const unmatchedNames = breakdown.unmatchedCandidateWords.map((u) => u.word);
      expect(unmatchedNames).toContain('Vladimir');
      expect(unmatchedNames).toContain('Vladimirovich');

      expect(breakdown.queryCoverage).toBeCloseTo(1.0, 2);
      expect(breakdown.candidateCoverage).toBeCloseTo(0.33, 1);
    });

    it('marks generic particles as isParticle in unmatchedCandidateWords', () => {
      const q = buildTokenizedQuery('osama laden');
      const cand = buildTokenizedName('Osama bin Muhammad bin LADEN');

      const breakdown = explainTokenizedNameMatch(q, cand);

      expect(breakdown.matchedWords).toHaveLength(2);
      const binParticle = breakdown.unmatchedCandidateWords.find((w) => w.word.toLowerCase() === 'bin');
      expect(binParticle).toBeDefined();
      expect(binParticle?.isParticle).toBe(true);

      const muhammad = breakdown.unmatchedCandidateWords.find((w) => w.word.toLowerCase() === 'muhammad');
      expect(muhammad).toBeDefined();
      expect(muhammad?.isParticle).toBe(false);
    });

    it('does not duplicate candidate words for cross-script transliterated names', () => {
      const q = buildTokenizedQuery('putin');
      const cand = buildTokenizedName('Владимир Владимирович ПУТИН');

      const breakdown = explainTokenizedNameMatch(q, cand);

      // Should have exactly 2 unmatched original word groups, not 4 (no duplicate transliterations)
      expect(breakdown.unmatchedCandidateWords).toHaveLength(2);
      expect(breakdown.matchedWords).toHaveLength(1);
    });

    it('identifies unmatched query words when query has extra terms', () => {
      const q = buildTokenizedQuery('vladimir putin president');
      const cand = buildTokenizedName('Vladimir PUTIN');

      const breakdown = explainTokenizedNameMatch(q, cand);

      expect(breakdown.matchedWords).toHaveLength(2);
      expect(breakdown.unmatchedQueryWords).toContain('president');
    });
  });

  describe('Search service integration (runSearch)', () => {
    beforeEach(async () => {
      state.allRecords = [
        {
          id: 'rec-1',
          source: 'EU',
          type: 'individual',
          names: [{ wholeName: 'Vladimir Vladimirovich PUTIN', strong: true }],
          searchNames: [],
          birthDates: [{ year: 1952, month: 10, day: 7 }],
          identifications: [{ type: 'passport', number: 'RU123456' }],
          status: 'active',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ];
      await invalidateSearchIndex();
    });

    it('attaches scoreBreakdown to search results', async () => {
      const res = await runSearch('putin');
      expect(res.results.length).toBeGreaterThan(0);
      const hit = res.results[0];
      expect(hit.scoreBreakdown).toBeDefined();
      expect(hit.scoreBreakdown?.mechanism).toBe('name');
      expect(hit.scoreBreakdown?.matchedWords).toHaveLength(1);
    });

    it('flags dobBoostApplied when DOB booster increases score', async () => {
      const res = await runSearch('putin', { dob: '1952' });
      expect(res.results.length).toBeGreaterThan(0);
      const hit = res.results[0];
      expect(hit.scoreBreakdown?.dobBoostApplied).toBe(true);
    });

    it('attaches mechanism passport_id without misleading word breakdown for passport matches', async () => {
      const res = await runSearch('RU123456');
      expect(res.results.length).toBeGreaterThan(0);
      const hit = res.results[0];
      expect(hit.matchedAlias).toBe('Passport/ID match');
      expect(hit.scoreBreakdown?.mechanism).toBe('passport_id');
      expect(hit.scoreBreakdown?.matchedWords).toHaveLength(0);
    });
  });
});
