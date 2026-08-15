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
  },
});
