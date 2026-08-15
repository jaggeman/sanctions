# Multi-Agent Workflow & Project Conventions

1. Testing policy — TDD, red → green → refactor
Every new feature, endpoint, or behaviour change ships with tests. Every bug fix includes a test that fails before the fix. No exceptions.

Start with the test cases. Before writing implementation, write the tests that capture the intended behaviour — happy path, edge cases, error/permission-denied paths, and (for a bug fix) a test that reproduces the bug.
Watch them fail (red). Run the test suite and confirm the new tests fail for the right reason — proves the test actually exercises the code.
Implement to green. Write the minimum code to pass, then rerun.
Refactor with the tests as a safety net, keeping them green.
The only case where a test may legitimately follow the code is a spike/throwaway exploration — and that spike doesn't get committed without its tests.

Match the test to the right layer — a test that would pass without the feature isn't a real test:

- Pure/offline unit tests — logic, validation, calculations with mocked dependencies. Fast, no external services. `npm run test:unit`
- Contract/rules tests — anything gating access/permissions/schema (e.g. DB security rules, API contracts). `npm run test:rules`
- Integration/emulator tests — anything the mocks can't see: a real database/SDK, transactions, the actual write path. Offline mocks stub the real client, so they cannot catch runtime-only bugs (passes mocks, fails in production). `npm run test:integration`

Fixtures must be derived from real source data, never invented from reading the implementation. A fixture written by studying the parser encodes that parser's assumptions, so it goes green against the exact bugs it was supposed to catch — it can only ever confirm the implementation back to itself. Carve a small sample verbatim out of a genuine source file (a handful of records covering the interesting shapes), note its provenance in a comment at the top, and keep the full-size file out of git. A real incident in this repo: an XML fixture hand-written from the parser declared element and attribute names that do not occur in the real format at all; seven tests passed green while the parser turned a valid 25 MB export into 6 234 unusable records.

Formats that fail silently need aggregate assertions, not only field assertions. Reading a missing XML attribute, JSON key or CSV column yields `undefined` rather than throwing, so a wrong field name produces a plausible-looking record instead of an error, and per-field tests on a hand-made fixture will not notice. Alongside "this field has this value", assert invariants across the whole parse: every record has a name, the type split is not 100% one value, the number of extracted identifiers is in the right ballpark against the source. Those are the assertions that catch a systemic mapping error rather than a typo.

Run a new parser/importer against the full real source file once, before calling it correct. The fixture only proves the shapes you thought of; the real file is what tells you the type split is 4 462/1 772 and not 6 234/0. Print aggregate counts and compare them against the source (`grep -c` on the raw file is usually enough). Keep this a throwaway script rather than a committed test — the real file is too large to commit and too slow for the suite — but record the resulting numbers in the PR description.

Selective/partial runs for fast local iteration — don't run the whole suite on every small change:

- `npm test -- path/to/one.test.ts`     # just that file
- `npm test -- --changed`                # only tests matching changed source files (fast pre-check, not a substitute for the full suite before pushing)
Run the whole suite before committing/opening a PR — that's the real gate.

Invoke the suite through the project's own script, not the underlying runner. The script usually wraps the runner in scaffolding the tests require: here `npm test` is `firebase emulators:exec --only firestore "vitest run"`, so reaching past it to `npx vitest run` starts no emulator and reports the integration and rules layers as failures that have nothing to do with your change. If you find yourself explaining away failures in a layer you didn't touch, check how you invoked the suite before you start diagnosing the code.

Know your platform's test-runner limitations before fighting them. If a test layer (e.g. a bundled emulator) simply can't run on your OS due to a known sandboxing/networking limitation, that's an environment fact to document and route around (e.g. run it in a VM/container/CI only), not a bug to chase for hours. Write down the exact error signature once you've diagnosed it so the next session doesn't re-diagnose it.

Check first whether local execution is possible before reaching for CI — shared CI minutes are a metered resource, not a free safety net. If you have a way to run the full suite locally, do that and treat a genuine local green run as satisfying the merge gate on its own (see §3).

Test isolation gotcha (if tests share a mocked singleton): a new test file must reuse an already-installed mock rather than unconditionally reinstalling it (`try { x = getMock() } catch {}; if (!x) install()`), or whichever test file loads first (alphabetically, in most runners) wins and starves every other file that expected the mock to already exist.

2. Multi-agent / multi-session coordination
If more than one agent/session/developer may edit the same working directory concurrently, uncoordinated edits overwrite each other. Fix:

A file-based "claim" board — a directory (e.g. `.agents/active/`, git-ignored) where each in-progress task drops a small markdown file listing which files/areas it owns. Visible on disk to every session instantly, no external service needed.

At the start of every task:

- `git fetch origin main` and branch off (or rebase onto) latest — never build on a checkout more than a few commits behind. A stale branch that gets pushed later can silently revert already-merged work — always diff against the target before pushing (`git diff origin/main <branch> --stat`), don't just trust "no conflicts."
- Read every active claim file + `git status` — know what's in flight.
- Create your own claim file listing files/areas you'll touch.
- If a file you need is already claimed, don't edit it — pick other work or ask to coordinate.
- While working: keep your claim's file list current. On merge: delete your claim file. Remove stale claims whose files no longer appear in git status.

Branch names are a shared resource too
Two sessions pushing to the identical remote branch name at the same time is worse than a file collision — git gives zero warning, one push silently becomes the tip, and the other session's own merge can report "success" while actually shipping the wrong content.

- Claim the branch name in your claim file, not just the files.
- Never push to a branch you didn't create. Branching off someone else's in-flight work needs a distinctly-named branch of your own.
- After every merge, verify the ACTUAL merged content — don't trust the "merged" status alone:
  `git fetch origin`
  `git merge-base --is-ancestor <your-commit-sha> origin/main && echo OK || echo LOST`
  If your commit isn't an ancestor, the branch was clobbered before merge — it's recoverable from your local reflog, not gone.

Default to an isolated worktree per task
Every collision this pattern is meant to prevent has come from working directly in a shared checkout; isolated worktrees have had zero. Default to `git worktree add <path> origin/main` for any task, not only when explicitly parallelizing a batch — including a single, seemingly-quick edit. A shared checkout sitting checked out on main itself (rather than a feature branch or detached HEAD) is a red flag — stop and branch/worktree first.

Never run ANY git command in a shared checkout you don't own — including read-only-seeming ones like `checkout`, `switch`, `restore`, `reset`, or `pull`, even "just to look." If you need to inspect another state, use `git show <ref>:<path>`, `git log <ref>`, `git diff <ref>` from your own worktree, or spin up a fresh disposable worktree for the investigation. A real incident: an agent ran `git checkout main -- .` in a shared checkout "just to see what main looked like" and silently overwrote another session's uncommitted branch.

Delegation depth
A dispatched agent/subagent does the work itself — it does not spawn its own child agent to do the "hard part." If a task is genuinely too big for one agent, that's the dispatcher's call to split it into separate dispatches, never the worker's call to spawn a child.

3. PR + CI as standing practice
- No direct pushes to the main branch (unless truly emergency/solo work and stated as such). Push your branch, open a PR, wait for CI to actually complete (poll for a real result, don't assume a background watcher reports back), merge (squash) once green.
- Rebase onto the latest main and re-push if it's moved since you branched — don't force-push over someone else's work.
- Stacking on someone else's in-flight branch is legitimate when their PR carries scaffolding you need (a test harness, a shared type) or owns files you must change — it beats guaranteeing a conflict by branching off main. Say so in your claim file and at the top of your PR, and target their branch as the base.
- Expect a base branch to vanish mid-task. If the PR you stacked on squash-merges while you work, its branch is deleted, your history no longer matches main's single squashed commit, and the PR API rejects your base as `invalid`. Recover with `git rebase --onto origin/main <old-base-sha> <your-branch>`, re-run the suite, then verify with `git diff origin/main HEAD --stat` — it must list only the files you actually touched. If it lists files from the branch you were stacked on, you are about to revert someone's merged work.
- A genuinely-verified local green full-suite run satisfies the merge gate on its own, not only as an emergency fallback — this is the preferred path to conserve shared/metered CI minutes when local execution is possible. Still open the PR as the review/history record.
- Once verified locally, skip scheduling CI for that push: most CI providers honor a `[skip ci]`/`[ci skip]` tag in the commit message on pull-request-triggered pipelines. Always say explicitly when you're doing this so it's a visible decision, not a silent shortcut.
- Pre-commit hook: print active claims as a reminder (not enforcement), and block a commit that changes a versioned/generated asset without its required regeneration step run first (e.g. a build/hash step whose output wasn't committed alongside the source change).
- Pre-push hook: run the fast local suite before every push and block on failure — so a failing change never reaches CI and never burns a run on "push → fail → fix → push again." Skip gracefully if dependencies aren't installed; keep any environment-restricted suites (e.g. emulator-only tests) CI-only.
- Not enforced by branch-protection ⇒ still a hard rule, just process-discipline instead of platform-enforced. If the hosting platform's plan doesn't support branch protection on a private repo, note that explicitly and treat a direct push to main as a mistake to flag/fix, not expected behaviour. Turn on real protection the moment the plan supports it.
- Merge/deploy centralization: designate a single "merge/deploy" role — whoever holds it is the only one that merges to main, syncs any shared local checkout, and runs deploys; every other agent/session's job stops at "PR opened." This isn't tied to one persistent process — any session can hold the role for a given round, as long as only one does at a time. This closes the exact race where two sessions merging/pushing the same branch name at once causes a silent clobber with no error.
- Merge to main often — keep feature branches short-lived. A branch that accumulates many commits/features before merging becomes a giant, risky, hard-to-review merge and is where sessions collide on shared hot-spot files. Merge as soon as a coherent, green slice is done.
- Before every commit, do a critical self code-review of the diff — look specifically for security issues (unescaped input, missing authorization/tenancy checks, client-supplied identity), refactor need (duplicated logic, oversized functions), and whether a destructive UI action confirms before firing. Fix what you find or log it as a known follow-up — don't commit past a known issue.
- Green ⇒ push. Once the suite is green and work is committed, always push — never leave committed, passing work unpushed.

4. Issue tracking — outstanding work lives in the tracker, not in chat
Anything left to do — a follow-up, a known gap, a "we should build X later," a blocked/manual step, a bug noticed but not fixed — gets a tracked issue (GitHub Issues, Jira, Linear, whatever the project uses), never left only in chat or a code TODO comment. Chat scrolls away and TODOs get lost; a tracked issue is the durable place to find "what's left."

- Search existing/recently-closed issues before filing a duplicate.
- Write for hand-off, not for yourself in the moment. A different agent or teammate — possibly with no memory of the conversation that created the issue — needs to pick it up cold. Include: summary, context/why, scope, explicitly out-of-scope, exact file paths/function names to start from, acceptance criteria, and any known gotchas. Naming exact starting points is the single highest-leverage section — the difference between someone executing correctly and burning their whole budget just finding where to start.
- Treat the issue template as a living document. If an issue you filed turned out to be missing something the picking-up agent needed, update the template in the same session so the next issue doesn't repeat the gap.
- An issue written from reading the code is a hypothesis, and it should be labelled as one until something measures it. When the work starts and reality contradicts the write-up, correct the issue in place rather than only mentioning it in the PR — whoever plans around the backlog reads the issue, not the diff. A real case: an issue described a parser bug as "primary name is picked arbitrarily" when in fact no names were being extracted at all, which changed it from a cosmetic defect to a total data loss.
- When you finish work, close the loop: tick the tracker item / close the issue, referencing the PR that did it.

5. Deploy/release safety (if the project has a deploy step)
- Batch large deploys with a cooldown rather than pushing every unit of work at once, if the target infra has any kind of per-project rate/quota ceiling that many simultaneous updates could transiently exceed — small batches with a pause between them keep concurrent in-flight changes below the ceiling even when steady-state usage is low.
- Prefer incremental "what changed since last deploy" over full redeploys for day-to-day changes — walk the real dependency graph from changed files to find what's actually affected, rather than "changed file == redeploy everything" or a naive one-to-one mapping. Reserve full redeploys for infrequent large batches, and use a literal-diff-since-a-known-baseline approach (not a dependency-graph walk) when catching up a large batch of already-merged work at once — a graph walk from many disparate changes can fan out through a shared "hub" module to nearly everything, which a literal-baseline-diff avoids.
- Track deploy state OUTSIDE any single git worktree/checkout — a shared, per-machine (or per-environment) state file, not something inside a worktree that gets recreated fresh per task and would otherwise always look like "never deployed."
- Guard against a suspiciously-large diff being silently treated as normal — if the computed affected-set is close to 100% of everything, refuse and require an explicit override flag, mirroring the sanity check a human would do by hand before trusting an automated tool with it.
- Pre-flight check for concurrent deploys before starting your own — check audit logs / a lock file for another in-flight deploy to the same target, and wait rather than risk a collision.
- Deploy state is a fact about the remote target, not about your local checkout — if multiple worktrees/checkouts exist on one machine, they should share one deploy-state record per environment, or a fresh worktree will wrongly think it's never deployed and trigger an unnecessary full deploy.
- A transient quota/capacity failure across a deploy batch is often just that — retry the identical command. Distinguish it from a hard configuration block (e.g. a missing secret/credential) by trying a single, minimal deploy in isolation: if that alone fails with the same error, it's a real config problem, not a transient capacity issue — no amount of retrying or smaller batching fixes a missing credential.

6. Secure coding checklist (generic, re-check on every PR)
- Escape/sanitize before rendering user-supplied strings as markup — prefer a safe text-insertion API (e.g. textContent) over raw HTML injection; if HTML injection is unavoidable, escape first.
- No inline event handlers or inline scripts if your CSP (or equivalent) disallows them — use attribute-driven wiring + event delegation instead, and add a guard test that fails the build if one reappears.
- Never build handlers/queries by string-interpolating untrusted data — injection risk, and breaks on legitimate values containing quotes/special characters.
- Cryptographically secure randomness for anything security-sensitive (tokens, one-time codes, session IDs) — never a non-cryptographic PRNG.
- Validate any user-supplied value before using it as a storage key/path segment/identifier — reject path separators and other structural characters via an explicit allow-list pattern. "User-supplied" covers anything read out of an uploaded or downloaded file, not just request parameters: an ID lifted from an XML attribute and concatenated into a document path is exactly as untrusted as a query string, and it arrives without the scrutiny a request parameter usually gets.
- Turn off automatic type coercion in parsers that carry identifiers. A generic XML/CSV/JSON parser set to "helpfully" convert values will rewrite a passport number `007123` as `7123` and a reference `1.10` as `1.1`, silently corrupting the highest-precision matching keys you have. Read identifiers as text and convert explicitly at the points that genuinely need a number.
- Keep the source's own reliability flags attached to the data. When an upstream record marks a document expired, revoked or known-false, dropping that flag on import presents bad data as good — carry it through to whatever the user finally sees.
- Least privilege at the data layer: every new collection/table gets access rules scoped to who should actually read/write it, plus a test for those rules, in the same change. A permissive "anyone can create" rule is a smell if the real write path is meant to go through validated server-side logic — lock the client-side rule down and route writes through the validated path instead.
- Authorization is more than "is the caller privileged in general" — every operation addressed by a client-supplied ID (user id, resource id, tenant id …) must verify that resource actually belongs to the caller's own tenant/scope before acting on it. A privilege check that only counts "does the caller's own tenant still have an admin left" does not protect a victim in a different tenant.
- A sensitive/elevated role should never be self-assignable from the app. If a "god mode"/cross-tenant role exists, guard every role-write path so a regular privileged user cannot grant it to themselves.
- Guards should re-verify current state from the source of truth, not trust a cached claim/token that could be stale after a permission change — a revoked/demoted user often keeps a live, auto-refreshing session token for a while; re-check the authoritative record on every sensitive call.
- Never log secrets or PII unconditionally — gate any verbose/debug logging behind a non-production environment check, and redact identifying fields (e.g. log a domain, not a full email) even then.
- Every module that uses a shared symbol must import it explicitly — an implicit "it happens to be in scope" dependency breaks the moment code is split into separate modules; a static import-scan test catches this class of bug cheaply.

7. Cache-busting / static asset versioning (if serving assets with long-lived cache headers)
- Version query strings (or filename hashes) must be derived automatically from the asset's own content hash, never hand-picked or manually bumped.
- A guard test that recomputes the hash straight from the file and fails the build if the reference is stale (asset changed, version reference wasn't regenerated) — this is the single check that prevents "I fixed it but the browser/client is still serving the old cached copy."
- The entry document (e.g. index.html) must never itself be long-cached — otherwise clients never learn about the new version reference in the first place, no matter how correctly it was bumped.
- A brand-new asset reference must start with some version placeholder from its very first commit — an automatic bump mechanism typically only rewrites an existing version marker, it can't retroactively add one to a bare, unversioned reference. A bare reference is invisible to the whole mechanism and, once cached by a real client, can stay stale forever with no future deploy or normal reload able to fix it.
