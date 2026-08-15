import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // Emulator-backed suites (tests/rules, tests/integration) talk to a real
    // Firestore emulator over the network, so they need more headroom than the
    // pure unit layer. See CLAUDE.md §1 for the three-layer split.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // The importers log progress on every call, which buries the actual test
    // output. Keep it for failures, drop it for passes.
    silent: 'passed-only',
    // tests/integration and tests/rules share ONE live Firestore emulator
    // across files. Vitest's default per-file parallelism means two
    // integration files clearing the same `sanctions` collection in their
    // own beforeEach race each other — surfaced by adding a second
    // integration test file (issue #8's diff.integration.test.ts alongside
    // issue #9's uploader.integration.test.ts): both suites started failing
    // with wrong write/document counts, not because either suite's code was
    // wrong, but because they were deleting each other's fixtures mid-run.
    // The unit layer has no shared external state, so serial execution here
    // costs it nothing.
    fileParallelism: false,
  },
});
