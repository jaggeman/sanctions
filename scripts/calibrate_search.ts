/**
 * Search scoring calibration harness (issue #239).
 *
 * WHY THIS EXISTS
 * ---------------
 * The scoring constants in src/search/matcher.ts are coupled: raising the bar
 * to kill a false positive lowers recall, and lowering it to catch a missed
 * record resurrects the false positives that #41, #104 and #152 each fixed in
 * turn. #239 was caused precisely by changing one side without measuring the
 * other — #41 fixed a false-positive bug and silently introduced an 88%
 * false-negative rate on partial-name queries.
 *
 * So: never change a constant in matcher.ts without running this before and
 * after, and record both runs in the PR description (CLAUDE.md §1).
 *
 * This is a measurement tool, not a test. It is deliberately NOT part of
 * `npm test`: it needs the real multi-megabyte source files, which are
 * git-ignored (see .gitignore: downloads/, lists/) and far too slow for the
 * suite. Fixtures are useless here on purpose — a fixture encodes the
 * implementation's own assumptions, and the whole point is to measure against
 * data nobody tuned against.
 *
 * USAGE
 *   npx ts-node --transpile-only scripts/calibrate_search.ts
 *
 * Requires (download via the app's Official Sources tab, or the importer):
 *   downloads/un_sanctions.xml
 *   downloads/us_sdn.xml
 * Optional, included automatically when present:
 *   downloads/uk_sanctions.xml, downloads/ch_sanctions.xml
 *
 * Exit code is 1 if any acceptance criterion from #239 fails, so it can gate
 * a change rather than merely describe one.
 */
import * as fs from 'fs';
import { parseUNList } from '../src/importer/parsers/un';
import { parseUSList } from '../src/importer/parsers/us';
import {
  buildTokenizedName,
  buildTokenizedQuery,
  scoreTokenizedNameMatch,
  scoreNameMatch,
  soundex,
  jaroWinkler,
  TokenizedName,
} from '../src/search/matcher';
import { allNamesOf } from '../src/shared/types';

/** Must track DEFAULT_THRESHOLD in src/search/index.ts. */
const THRESHOLD = 65;

interface Indexed {
  id: string;
  raw: string[];
  names: TokenizedName[];
}

/** A record "literally contains" the query when some name has it as a whole word. */
function containsWholeWord(rec: Indexed, needle: string): boolean {
  return rec.raw.some((n) => n.toLowerCase().split(/[^a-z0-9]+/i).includes(needle));
}

function bestScore(index: Indexed[], query: string): (rec: Indexed) => number {
  const tq = buildTokenizedQuery(query);
  return (rec) => scoreTokenizedNameMatch(tq, rec.names).score;
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(0).padStart(3)}%`;
}

const failures: string[] = [];
function check(ok: boolean, label: string) {
  if (!ok) failures.push(label);
  return ok ? 'PASS' : 'FAIL';
}

async function loadCorpus(): Promise<Indexed[]> {
  const records: { id: string; names: any }[] = [];
  const un = 'downloads/un_sanctions.xml';
  const us = 'downloads/us_sdn.xml';
  if (!fs.existsSync(un) || !fs.existsSync(us)) {
    console.error(`Missing corpus. Expected ${un} and ${us} (git-ignored — download them first).`);
    process.exit(2);
  }
  records.push(...(await parseUNList(un)));
  records.push(...(await parseUSList(us)));
  return records.map((r) => {
    const raw = allNamesOf((r as any).names);
    return { id: r.id, raw, names: raw.map(buildTokenizedName) };
  });
}

async function main() {
  const index = await loadCorpus();
  const totalNames = index.reduce((a, r) => a + r.names.length, 0);
  console.log(`\ncorpus: ${index.length} records, ${totalNames} name/alias strings, threshold ${THRESHOLD}\n`);

  // ---------------------------------------------------------------------
  console.log('=== 1. RECALL — do partial-name queries find their records? ===');
  console.log('   #239 acceptance: >= 90% for each query below.\n');
  console.log('   query      | contains | returned | recall | verdict');
  const RECALL_QUERIES = ['kim', 'ali', 'mohammed', 'ivanov', 'linda', 'wang', 'li'];
  const RECALL_TARGET = 0.9;
  for (const q of RECALL_QUERIES) {
    const scoreOf = bestScore(index, q);
    const needle = q.toLowerCase();
    let contains = 0;
    let found = 0;
    const missed: string[] = [];
    for (const rec of index) {
      if (!containsWholeWord(rec, needle)) continue;
      contains++;
      const s = scoreOf(rec);
      if (s >= THRESHOLD) found++;
      else if (missed.length < 2) missed.push(`${rec.raw[0]} (${s})`);
    }
    const recall = contains === 0 ? 1 : found / contains;
    const verdict = check(recall >= RECALL_TARGET, `recall "${q}" = ${(recall * 100).toFixed(0)}% < 90%`);
    console.log(
      `   ${q.padEnd(10)} | ${String(contains).padStart(8)} | ${String(found).padStart(8)} | ${pct(found, contains)} | ${verdict}` +
        (missed.length ? `   miss: ${missed.join(', ')}` : ''),
    );
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 2. PRECISION — how much of a result set is phonetic noise? ===');
  console.log('   A hit is "soundex-only" when the matched word shares the query\'s');
  console.log('   4-char code but bears NO textual resemblance to it (JW < 0.70).');
  console.log('   #239 acceptance: zero such hits.\n');
  console.log('   query      | hits | soundex-only | borderline | verdict');
  const NO_RESEMBLANCE_JW = 0.7;
  const BORDERLINE_JW = 0.85;
  for (const q of ['musa', 'saif', 'reza', 'linda']) {
    const tq = buildTokenizedQuery(q);
    const qWords = tq.wordGroups.flatMap((g) => g.map((w) => w.text));
    let hits = 0;
    let noise = 0;
    let borderline = 0;
    const samples: string[] = [];
    const borderSamples: string[] = [];
    for (const rec of index) {
      const { score, matchedName } = scoreTokenizedNameMatch(tq, rec.names);
      if (score < THRESHOLD) continue;
      hits++;
      const words = matchedName.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
      // Best textual resemblance between any query word and any matched word.
      let bestJw = 0;
      let sharesCode = false;
      for (const qw of qWords) {
        for (const w of words) {
          bestJw = Math.max(bestJw, jaroWinkler(qw, w));
          if (soundex(qw) === soundex(w) && soundex(qw) !== '') sharesCode = true;
        }
      }
      if (sharesCode && bestJw < NO_RESEMBLANCE_JW) {
        noise++;
        if (samples.length < 5) samples.push(`${matchedName} (${bestJw.toFixed(2)})`);
      } else if (sharesCode && bestJw < BORDERLINE_JW) {
        borderline++;
        if (borderSamples.length < 3) borderSamples.push(`${matchedName} (${bestJw.toFixed(2)})`);
      }
    }
    const verdict = check(noise === 0, `precision "${q}": ${noise} soundex-only hits`);
    console.log(
      `   ${q.padEnd(10)} | ${String(hits).padStart(4)} | ${String(noise).padStart(12)} | ${String(borderline).padStart(10)} | ${verdict}` +
        (samples.length ? `   noise: ${samples.join(', ')}` : ''),
    );
    if (borderSamples.length) console.log(`              borderline (accepted, see below): ${borderSamples.join(', ')}`);
  }
  console.log('\n   NOTE: "borderline" is reported, not failed. Soundex cannot separate');
  console.log('   qusay/qoussai (JW 0.811, a real transliteration) from linda/land');
  console.log('   (JW 0.805, a collision) — they differ by 0.006. Some phonetic noise');
  console.log('   is therefore irreducible; it is kept BELOW textual matches in rank');
  console.log('   rather than eliminated. See #239.');

  // ---------------------------------------------------------------------
  console.log('\n=== 3. RANKING — the reported linda case ===');
  {
    const tq = buildTokenizedQuery('linda');
    const ranked = index
      .map((rec) => ({ rec, ...scoreTokenizedNameMatch(tq, rec.names) }))
      .filter((r) => r.score >= THRESHOLD)
      .sort((a, b) => b.score - a.score);
    ranked.slice(0, 5).forEach((r, i) => console.log(`   ${i + 1}. ${r.score} ${r.rec.raw[0]}`));
    if (!ranked.length) console.log('   (no results at all)');

    const realIdx = ranked.findIndex((r) => /Linda/i.test(r.rec.raw[0]));
    const indaIdx = ranked.findIndex((r) => /^INDA$|^LAMD$/i.test(r.rec.raw[0]));
    console.log(
      `   real Linda rank=${realIdx < 0 ? 'ABSENT' : realIdx + 1}, vessel rank=${indaIdx < 0 ? 'absent' : indaIdx + 1}  ` +
        check(realIdx >= 0 && (indaIdx < 0 || realIdx < indaIdx), 'linda: real person must rank above the vessels'),
    );
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 4. SCORE CURVE — 1-word query vs N-word candidate ===');
  console.log('   This is the mechanism behind #239. A surname must stay findable');
  console.log('   in a long name, so every row here must clear the threshold.\n');
  const CURVE = [
    ['kim', 'KIM'],
    ['kim', 'KIM JONG'],
    ['kim', 'KIM KWANG IL'],
    ['kim', 'KIM KWANG IL SUN'],
    ['kim', 'KIM KWANG IL SUN MYONG'],
  ];
  for (const [q, cand] of CURVE) {
    const { score } = scoreNameMatch(q, [cand]);
    const words = cand.split(' ').length;
    console.log(
      `   "${q}" vs ${String(words)}-word "${cand}"`.padEnd(52) +
        `-> ${String(score).padStart(3)}  ${check(score >= THRESHOLD, `curve: "${q}" vs ${words}-word name scored ${score}`)}`,
    );
  }

  // ---------------------------------------------------------------------
  console.log('\n=== 5. REGRESSION GUARD — the false positives #41/#104/#152 fixed ===');
  console.log('   These must NOT come back while fixing recall.\n');
  const REGRESSIONS: { q: string; cand: string; max: number; issue: string }[] = [
    { q: 'qusay', cand: 'musa', max: THRESHOLD - 1, issue: '#104 coincidental short-word pair' },
    { q: 'ali', cand: 'Abu Bakr al-Baghdadi al-Qurashi', max: 99, issue: '#41 generic-particle overlap must not hit 100' },
    { q: 'linda', cand: 'INDA', max: 92, issue: '#239 dropped-initial must not beat a real match' },
    { q: 'linda', cand: 'LAMD', max: THRESHOLD - 1, issue: '#239 pure soundex collision' },
    { q: 'male', cand: 'Ivan Petrov', max: THRESHOLD - 1, issue: '#152 gender token is not a name match' },
  ];
  for (const r of REGRESSIONS) {
    const { score } = scoreNameMatch(r.q, [r.cand]);
    console.log(
      `   "${r.q}" vs "${r.cand}"`.padEnd(52) +
        `-> ${String(score).padStart(3)} (max ${r.max})  ${check(score <= r.max, `regression ${r.issue}: scored ${score} > ${r.max}`)}`,
    );
  }

  // ---------------------------------------------------------------------
  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log('ALL CRITERIA PASS');
  } else {
    console.log(`${failures.length} CRITERIA FAILING:`);
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('='.repeat(70) + '\n');
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
