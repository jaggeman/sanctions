import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { scoreNameMatch, scoreTokenizedNameMatch, buildTokenizedName, buildTokenizedQuery, TokenizedName } from '../../src/search/matcher';

/**
 * Regression + benchmark layer for issue #11's acceptance criteria:
 *   - "A regression set of known name pairs (variant -> expected entity)"
 *   - "Benchmark on the full real dataset ... p50/p95 latency and memory"
 *
 * The corpus (tests/fixtures/real-eu-names-corpus.json, 6234 entries) was
 * extracted directly from the real EU FSD v1.1 export at
 * lists/20260805-FULL-1_1(xsd).xml via fast-xml-parser (see
 * scripts/extract-eu-names-fixture.ts), bypassing src/importer/parsers/eu.ts
 * on purpose — that parser has known field-mapping bugs tracked separately in
 * issue #4 (in flight on another branch) that currently make most EU
 * primaryNames come out as "Unknown Name". This suite tests the MATCHER
 * against real name data, independent of whether that parser bug is fixed.
 */

interface CorpusEntry {
  id: string;
  primaryName: string;
  aliases: string[];
}

interface FixtureCase {
  query: string;
  expectedId: string;
  note: string;
}

let corpus: CorpusEntry[];
let fixtures: FixtureCase[];

beforeAll(async () => {
  corpus = await fs.readJson(path.join(__dirname, '../fixtures/real-eu-names-corpus.json'));
  fixtures = await fs.readJson(path.join(__dirname, '../fixtures/name-variants.json'));
});

/** Scans the whole corpus for one query and returns the single best-scoring entry. */
function bestMatchInCorpus(query: string, entries: CorpusEntry[]): { entry: CorpusEntry; score: number } | null {
  let best: { entry: CorpusEntry; score: number } | null = null;
  for (const entry of entries) {
    const { score } = scoreNameMatch(query, [entry.primaryName, ...entry.aliases]);
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

describe('regression: known name-variant pairs against the real EU corpus', () => {
  it('loaded a real corpus of several thousand entries', () => {
    expect(corpus.length).toBeGreaterThan(5000);
  });

  it('every fixture case finds its expected entity as the top match', () => {
    for (const { query, expectedId, note } of fixtures) {
      const best = bestMatchInCorpus(query, corpus);
      expect(best, note).not.toBeNull();
      expect(best!.entry.id, `"${query}" — ${note}`).toBe(expectedId);
    }
  });

  // This case has been the suite's bellwether for the recall/precision
  // tradeoff from the start, and it has now moved twice:
  //
  //   #11  This was the suite's very FIRST fixture: a bare "Qusay" reliably
  //        out-ranked all 6,234 other entries and landed on EU-20, the
  //        "Qoussaï Saddam Hussein Al-Tikriti" entity.
  //   #41  Fixing asymmetric coverage necessarily weakened a one-word query
  //        against a 4-part name, so the fixture was REMOVED from
  //        name-variants.json and this test written in its place, to
  //        document the true entity's score collapsing below threshold —
  //        a conscious, user-approved tradeoff at the time.
  //   #239 Measuring against the full UN + US SDN corpora showed what that
  //        cost across the board: 88% of "kim", 75% of "ali" and 80% of
  //        "mohammed" disappeared from results entirely. A screening tool
  //        that hides listed people when you search one part of their name
  //        is not doing its job, so the tradeoff was reversed.
  //
  // This therefore asserts the #11 behaviour again — findable by a bare
  // first name — while the property #41 genuinely needed (a partial match
  // must not masquerade as an exact one) is asserted here as the ranking
  // check below, and more fully in tests/unit/matcher.test.ts. #104's
  // specific coincidental cross-match stays fixed in the next test.
  it('RESTORED (issue #239): a bare first name finds its entity again', () => {
    const trueEntity = corpus.find((c) => c.id === 'EU-20')!;
    const { score: trueScore } = scoreNameMatch('Qusay', [trueEntity.primaryName, ...trueEntity.aliases]);
    const { score: fullScore } = scoreNameMatch(trueEntity.primaryName, [trueEntity.primaryName]);
    const best = bestMatchInCorpus('Qusay', corpus);

    // The true entity clears the threshold, so it reaches the result set...
    expect(trueScore).toBeGreaterThanOrEqual(65);
    // ...but still ranks below the full name it was drawn from, which is the
    // property #41 actually had to protect.
    expect(trueScore).toBeLessThan(fullScore);
    expect(best).not.toBeNull();
  });

  // issue #104's actual fix, pinned against the real corpus rather than just
  // the two words in isolation: "Musa" (a genuine alias of EU-121867, "SEKA
  // BALUKU" — completely unrelated to EU-20/Qusay) no longer scores high
  // enough via coincidental edit distance to beat the match threshold, let
  // alone win outright.
  it('issue #104 fix: the specific coincidental "Qusay"/"Musa" cross-match no longer happens', () => {
    const musaEntity = corpus.find((c) => c.id === 'EU-121867')!;
    expect(musaEntity).toBeDefined();
    expect(musaEntity.aliases).toContain('Musa');

    const { score } = scoreNameMatch('Qusay', [musaEntity.primaryName, ...musaEntity.aliases]);
    expect(score).toBe(0);
  });
});

describe('benchmark: full-corpus scan timing (issue #11 acceptance criterion)', () => {
  it('records p50/p95 latency and peak heap over repeated full-corpus searches', { timeout: 60_000 }, () => {
    // issue #300: 25 queries so p95 is calculated over a representative distribution
    const queries = [
      'Qusay', 'Qousaye Saddam Hussein Al-Tikriti', 'Izzat Ibrahim al-Dury',
      'Abed Hamid Mahmud', 'Vladimir Putin', 'Mohammed Al Amin', 'Random Unrelated Name',
      ...corpus.slice(0, 18).map((c) => c.primaryName),
    ];

    const timings: number[] = [];
    const heapBefore = process.memoryUsage().heapUsed;

    for (const q of queries) {
      const start = performance.now();
      bestMatchInCorpus(q, corpus);
      timings.push(performance.now() - start);
    }

    const heapAfter = process.memoryUsage().heapUsed;
    const sorted = [...timings].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] full-corpus (${corpus.length} entries) scan over ${queries.length} queries: ` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms ` +
      `heapDelta=${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)}MB`,
    );

    // Generous bound — this is steady-state (warm) latency, not a strict SLA.
    // Cold start (issue's own "the real risk") is a separate, deploy-time
    // concern this in-process benchmark can't measure.
    expect(p95).toBeLessThan(2000);
  });
});

/**
 * Issue #42, #300: precomputed-index scan timing at ~50k-record scale.
 */
describe('benchmark: full-corpus scan timing at ~50k-record scale via the precomputed index (issue #42)', () => {
  let bigCorpus: CorpusEntry[];
  let tokenizedIndex: Array<{ entry: CorpusEntry; tokens: TokenizedName[] }>;

  beforeAll(() => {
    // Duplicate the real 6,234-entry EU corpus with perturbed ids to reach
    // the scale issue #11 itself projected once UN/US/PEP data lands.
    const COPIES = 8;
    bigCorpus = [];
    for (let copy = 0; copy < COPIES; copy++) {
      for (const entry of corpus) {
        bigCorpus.push({ ...entry, id: `${entry.id}__copy${copy}` });
      }
    }

    // Build the precomputed index ONCE — exactly what getRecords() does at
    // cache-build time in src/search/index.ts, not per query.
    tokenizedIndex = bigCorpus.map((entry) => ({
      entry,
      tokens: [entry.primaryName, ...entry.aliases].map(buildTokenizedName),
    }));
  });

  it('synthesized roughly the scale issue #11 itself projected (~50,000 records)', () => {
    expect(bigCorpus.length).toBeGreaterThan(45_000);
  });

  it('records p50/p95 latency using the precomputed index instead of re-tokenizing candidates per query', { timeout: 60_000 }, () => {
    // issue #300: 25 representative queries
    const queries = [
      'Qusay', 'Izzat Ibrahim', 'Abed Hamid Mahmud',
      'Vladimir Putin', 'Mohammed Al Amin', 'Random Unrelated Name',
      ...corpus.slice(0, 19).map((c) => c.primaryName.split(' ').slice(0, 3).join(' ')),
    ];

    // Warm up the JIT on this exact code path before measuring
    {
      const warmupQuery = buildTokenizedQuery('Vladimir Putin');
      for (const { tokens } of tokenizedIndex.slice(0, 2000)) {
        scoreTokenizedNameMatch(warmupQuery, tokens);
      }
    }

    const timings: number[] = [];
    const heapBefore = process.memoryUsage().heapUsed;

    for (const q of queries) {
      const start = performance.now();

      const tokenizedQuery = buildTokenizedQuery(q);
      let best = { score: 0, matchedName: '' };
      for (const { tokens } of tokenizedIndex) {
        const match = scoreTokenizedNameMatch(tokenizedQuery, tokens);
        if (match.score > best.score) best = match;
      }

      timings.push(performance.now() - start);
    }

    const heapAfter = process.memoryUsage().heapUsed;
    const sorted = [...timings].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] precomputed-index full-corpus (${bigCorpus.length} entries) scan over ${queries.length} queries: ` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms ` +
      `heapDelta=${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)}MB`,
    );

    expect(p95).toBeLessThan(2000);
  });
});
