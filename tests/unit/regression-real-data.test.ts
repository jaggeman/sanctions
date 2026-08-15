import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { scoreNameMatch } from '../../src/search/matcher';

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

  // Removed from name-variants.json (issue #41): a bare "Qusay" used to
  // reliably out-rank all 6,234 other entries and land on EU-20 (the
  // "Qoussaï Saddam Hussein Al-Tikriti" / "Qusay Saddam Hussein Al-Tikriti"
  // entity) — that was this suite's very first fixture, straight from
  // issue #11. Fixing #41's asymmetric-coverage bug necessarily weakens a
  // single-word query against a 4-part name (see the PR description for
  // why no coverage-ratio formula can tell that apart from the bug this
  // issue exists to fix, without corpus-wide name-frequency data this
  // codebase doesn't have) — a conscious, user-approved trade-off, not an
  // oversight. This test documents what actually happens now, rather than
  // silently dropping the coverage: the true entity's score drops sharply,
  // and at full-corpus scale it can now be out-ranked by an unrelated
  // short alias that happens to cross the edit-distance threshold by pure
  // chance (a pre-existing weakness of EDIT_DISTANCE_MATCH_THRESHOLD on
  // short strings, which this fix didn't create but does make newly
  // decisive) — filed as a separate follow-up issue, not fixed here.
  it('KNOWN TRADE-OFF (issue #41): a bare first name alone no longer reliably out-ranks the whole corpus', () => {
    const trueEntity = corpus.find((c) => c.id === 'EU-20')!;
    const { score: trueScore } = scoreNameMatch('Qusay', [trueEntity.primaryName, ...trueEntity.aliases]);
    const best = bestMatchInCorpus('Qusay', corpus);

    // The true entity's own score dropped well below the match threshold...
    expect(trueScore).toBeLessThan(65);
    // ...and, at full-corpus scale, is no longer guaranteed to be the winner.
    // This assertion exists to make that fact visible in the suite, not to
    // lock in which unrelated entity wins — that's corpus-order-sensitive
    // noise, not a property worth pinning down.
    expect(best).not.toBeNull();
  });
});

describe('benchmark: full-corpus scan timing (issue #11 acceptance criterion)', () => {
  // v8 coverage instrumentation adds real overhead to a hot loop like this
  // one (observed roughly 3x the per-query latency), which both pushes
  // runtime past the default testTimeout AND pushes p95 past its own
  // threshold below — coverage overhead corrupts the very thing this test
  // measures. The timeout is raised here as a courtesy for a plain
  // `vitest run --coverage`, but the p95 assertion will still legitimately
  // fail under instrumentation; `npm run test:coverage` (issue #72) excludes
  // this file entirely rather than loosen the threshold to accommodate it.
  it('records p50/p95 latency and peak heap over repeated full-corpus searches', { timeout: 60_000 }, () => {
    const queries = [
      'Qusay', 'Qousaye Saddam Hussein Al-Tikriti', 'Izzat Ibrahim al-Dury',
      'Abed Hamid Mahmud', 'Vladimir Putin', 'Mohammed Al Amin', 'Random Unrelated Name',
      ...corpus.slice(0, 13).map((c) => c.primaryName), // sample real names as queries too
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
