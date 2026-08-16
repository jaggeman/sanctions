// Global vitest setup (see vitest.config.ts's setupFiles).
//
// Security fix for the hardcoded dev test-login (src/auth/testAccount.ts):
// isTestLoginEnabled() used to be fail-OPEN — enabled by default whenever
// NODE_ENV simply wasn't exactly 'production'. A deployed Cloud Function
// that inherited a misconfigured/missing NODE_ENV (e.g. via a stray root
// .env shipped by Firebase's own env-file deploy mechanism) silently
// activated an unauthenticated admin login in production.
//
// The fix requires an explicit opt-in (ENABLE_TEST_LOGIN=true) in addition
// to NODE_ENV !== 'production', so a misconfigured environment defaults to
// OFF instead of ON. This suite intentionally exercises that login as a
// convenience (dozens of test files authenticate via
// POST /api/auth/verify-otp with the test account), so opt in here, once,
// globally — individual test files should not need to know this flag
// exists at all.
process.env.ENABLE_TEST_LOGIN = 'true';
