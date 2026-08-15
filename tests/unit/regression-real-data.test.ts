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
});

describe('benchmark: full-corpus scan timing (issue #11 acceptance criterion)', () => {
  it('records p50/p95 latency and peak heap over repeated full-corpus searches', () => {
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
