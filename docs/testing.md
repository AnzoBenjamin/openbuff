# Testing

- Prefer dependency injection over module mocking; define contracts in `common/src/types/contracts/`.
- Use `spyOn()` only for globals / legacy seams.
- Avoid `mock.module()` for functions; use `@codebuff/common/testing/mock-modules.ts` helpers for constants only.

## Running per-package scripts with bun

`bun --cwd <pkg> run <script>` does NOT execute the script — it silently prints
the script list of the root package and exits 0, which makes it dangerously
easy to think typecheck/test passed when nothing ran. Use one of these instead:

- `cd <pkg> && bun run <script>` (recommended for ad-hoc / scripted basher use)
- `bun --filter=@codebuff/<pkg> run <script>` (workspace-aware)
- `bun --filter='*' run <script>` (every workspace)

This applies to `typecheck`, `test`, `build`, etc.

CLI hook testing note: React 19 + Bun + RTL `renderHook()` is unreliable; prefer integration tests via components for hook behavior.

## Test-infra notes (bun)

- **Pinned bun for OpenTUI tsx render tests.** Local bun >= 1.3.14 cannot initialize
  the OpenTUI FFI renderer (`Failed to initialize OpenTUI render library: Cannot
  access 'default' before initialization`). bun 1.3.14 is Bun's Rust-rewrite release
  (1.3.13 is the last Zig build) with confirmed FFI/TDZ regressions
  (oven-sh/bun#30651, oven-sh/bun#30717 — the latter confirmed for `@opentui/core`
  and fixed only in 1.4.x). Run tsx suites under the pinned version:

  ```bash
  cd cli && bunx --bun bun@1.3.5 test --isolate $(find . \( -path ./node_modules -o -path ./.git -o -path ./dist \) -prune -o -type f -name '*.test.tsx' -print)
  ```

  CI runs tests under bun 1.3.5 (the `setup-bun` pin in `.github/workflows/ci.yml`).

- **Run the exact CI discovery+invocation before pushing.** `bun test --isolate`
  does NOT give each file its own process — files share a pool of worker processes,
  so which files cohabit a module registry depends on the machine's core count and
  cross-file mock-leak scheduling differs between machines. Local isolated-file or
  small-pair runs cannot prove CI-schedule correctness, so run CI's own discovery
  and invocation locally first:

  ```bash
  cd cli && TEST_FILES=$(find . \( -path ./node_modules -o -path ./.git -o -path ./dist \) -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) ! -name '*.integration.test.ts' -print 2>/dev/null | sort | tr '\n' ' ') && bunx --bun bun@1.3.5 test --isolate $TEST_FILES
  ```

  Or run `cd cli && bunx --bun bun@1.3.5 run test`, which is the same discovery
  plus the empty-list guard described below.

  This matches the test discovery command in `.github/workflows/ci.yml` exactly
  (it collects both `*.test.ts` and `*.test.tsx`, excluding
  `*.integration.test.ts`).

  Keep per-package `test` scripts on documented `bun test` options only:
  `cli`'s script is `bun run scripts/run-cli-tests.ts`, which reproduces this CI
  discovery exactly (`--isolate` over the same `*.test.ts`/`*.test.tsx` set,
  excluding `*.integration.test.ts`) and then runs `bun test` over that list, so
  `bun run test` at the repo root cannot diverge from the schedule documented
  here. `packages/indexer` adds just `--isolate`.

  Discovery lives in that bun-run TypeScript script rather than a
  `find | sort | tr` pipeline because `engines` declares bun only: the package
  test entry point must not require an undeclared POSIX userland that nothing
  pins or locks. It walks the tree with `node:fs` and fails loudly instead of
  silently degrading:

  - an empty discovery throws `No test files found in cli ...` and exits 1,
    matching CI's empty-glob policy, instead of expanding to nothing and
    degenerating into bare `bun test` (the stalled invocation described below);
  - an unreadable directory throws naming the path, so a partial list can never
    report a vacuous green;
  - the sorted file list and the `--isolate` invocation are pinned by
    `cli/src/__tests__/run-cli-tests.test.ts`.

  The `*.integration.test.ts` exclusion is load-bearing, not cosmetic, but it is
  **not** the cause of the stall described below: those suites drive a real tmux
  server, so with one installed but no server running they fail rather than
  skip (measured: 18 failures when they are included). Any other package adding
  a custom `test` script owes the same empty-list guard and fail-loud discovery.

  A bare `cd cli && bun test` is **not** equivalent and reliably stalls. The
  cause is cross-file cohabitation in bun's default (non-isolated) mode, not the
  integration suites — `--isolate` is what fixes it, and the integration
  exclusion is independent of the stall. Measured on a 12-core box, stopping at
  a hard kill and recording where each run died:

  | invocation | result |
  | --- | --- |
  | bare `bun test` | stalled, killed at 300s (no summary) |
  | all suites, integration excluded, no `--isolate` | stalled, killed at 200s |
  | all 39 `*.test.tsx` suites alone, no `--isolate` | **pass**, 477 tests, 2.8s |
  | one `.tsx` suite alone (`single-block-markdown`) | **pass**, 3 tests, 1.3s |
  | all suites + integration, `--isolate` | completes, 100s (18 integration failures) |

  Each stalled run died inside the same `src/components/__tests__/*.test.tsx`
  section, and every `.tsx` file passes alone and as a group. So the deadlock
  needs the tsx render suites to be loaded into a registry that non-tsx suites
  have already populated with module mocks — the OpenTUI FFI renderer cannot
  then initialise and its progress bar keeps the process alive forever without
  ever printing a summary. Consequences worth keeping in mind:

  - Do not "fix" a stall by deleting or excluding tsx suites: they are all
    green in isolation. Add `--isolate` instead.
  - A stall is an **absence** of output, not a failure message, so it is easy
    to mistake for a slow suite. Run suspicious invocations under a hard
    `timeout` and treat a missing `Ran N tests` line as a stall.
  - Wrapping a stalled run in `timeout` does not kill the `bun` child by itself;
    kill the process group (`setsid`, or `pkill -f 'bun test'`) or an orphaned
    runner will keep burning a core and make every later measurement look worse.

  `--parallel=<n>` does exist (`bun test --help`, bun >= 1.3.14) and implies
  `--isolate`, but do not adopt it for a package script: it pins the worker
  count to the local core count, which is precisely what decides cross-file
  `mock.module` leakage (see below), so a local green would stop being
  readable against CI's schedule.

- **`mock.module` hygiene.** Prefer `spyOn(ns, 'fn')` + `mock.restore()` over
  `mock.module`. If `mock.module` is required:

  - Capture the real module BEFORE registering, as a plain-object snapshot:
    `const real = { ...(await import('spec')) }` — the module namespace is a live
    binding that `mock.module` patches in place, so a static namespace import is
    not a safe capture.
  - Spread the captured exports in the factory, and make every override
    delegate-unless-armed (armed flag set in `beforeEach`, cleared in `afterAll`).
    A registry-wide override that replaces exports unconditionally leaks into
    sibling suites.
  - Never capture the real module via `createRequire` — it bridges the CJS/ESM
    registries and can busy-spin sibling suites.

  The shared helpers `mockModule()` / `clearMockedModules()` from
  `@codebuff/common/testing/mock-modules` have a sharp resolution contract:
  `modulePath` is resolved relative to `common/src/testing/mock-modules.ts`
  ITSELF, not the calling test file, so caller-relative paths throw 'Cannot
  find module'. Only use them for specifiers resolvable from common/src/testing
  (existing consumers use bare package names).

  `createRequire` captures have one sanctioned exception: when a workspace
  package's ESM `import` condition resolves to a build artifact that may be
  stale or broken under `bun test` (e.g. `@openbuff/sdk` resolves to the sdk
  package's dist bundle output, not its source),
  capture the real exports via `createRequire` (the `require` condition),
  spread them EAGERLY into the factory, and never read the capture lazily —
  lazy delegation through a require-captured binding is the CJS/ESM bridge
  trap itself (the guard's first check).

  Restore factories must also spread:
  `mock.module(spec, () => ({ ...realSnapshot }))` — a factory returning the
  snapshot directly contains no spread and is flagged as a full replacement.
  Before pushing, run `bun --cwd=scripts run guard:mock-module` (wired into
  check:ci-local Step F); it flags lazy live-binding delegation and first-party
  full-replacement factories (exempt with a `mock-module-guard: intentional
  full replacement` comment).

- **OAuth callback tests use per-test ports.** `setChatGptOAuthRedirectUriForTests()`
  (`cli/src/utils/chatgpt-oauth.ts`) redirects the callback server to a unique
  per-test port; production keeps the provider-registered fixed port (1455). Do
  not re-add fixed-port bind assumptions in new OAuth tests.

## Coding harness experiments

- `bun run --cwd scripts harness:lsp -- <diagnostic-command> <file...>` runs an
  explicitly selected repository-local language-server/diagnostic adapter.
- `bun run --cwd scripts harness:repro -- <name> <command> [file...]` creates a
  reproduction manifest under `.agents/repros/<name>/`.
- `bun run --cwd scripts harness:mutation -- <mutation-command> [arg...]` runs
  an opt-in mutation framework with `OPENBUFF_MUTATION_GATE=1`.
- `bun run --cwd evals harness:ablation -- <runs.json>` aggregates controlled
  harness variants.
- `bun run --cwd evals harness:cross-model -- <experiment.json>` expands a
  configured model/phase matrix without inventing providers.

Retrieval runs can append local-only JSONL metrics under
`.agents/analytics/retrieval.jsonl`.

## CLI tmux Testing

For testing CLI behavior via tmux, use the helper scripts in `scripts/tmux/`. These handle bracketed paste mode and session logging automatically. Session data is saved to `debug/tmux-sessions/` in YAML format and can be viewed with `bun scripts/tmux/tmux-viewer/index.tsx` (the @cli-tester capture harness — not the user-facing run viewer). To inspect an agent RUN's journaled steps, use `openbuff dash` (`cli/src/commands/dash-command.ts`), which reads the live P2-T2 run journal; tmux-viewer remains the capture-tooling viewer only. See `scripts/tmux/README.md` for details.

Useful workflow for agents:

```bash
# Start the dev CLI in a detached tmux session.
SESSION=$(./scripts/tmux/tmux-cli.sh start --name cli-check -w 160 -h 40 --wait 6)

# Capture the initial screen. Captures are written to debug/tmux-sessions/$SESSION/.
./scripts/tmux/tmux-cli.sh capture "$SESSION" --label initial

# Send a prompt. The helper uses bracketed paste so text is not dropped.
./scripts/tmux/tmux-cli.sh send "$SESSION" "Search for getAgentBaseName and report what you find" --wait-idle 4

# Capture after the run, then inspect the saved capture text.
./scripts/tmux/tmux-cli.sh capture "$SESSION" --label after-search --wait 2

# Clean up when finished.
./scripts/tmux/tmux-cli.sh stop "$SESSION"
```

If a change can be verified with a small local harness instead of a live model-backed CLI run, run that harness inside tmux too. This still checks terminal rendering and produces a capture:

```bash
SESSION=$(./scripts/tmux/tmux-cli.sh start \
  --name render-check \
  -w 160 -h 20 \
  --wait 1 \
  --command "bun .context/my-render-check.tsx")

./scripts/tmux/tmux-cli.sh capture "$SESSION" --label rendered
./scripts/tmux/tmux-cli.sh stop "$SESSION"
```

When verifying UI output, prefer checking the saved capture file for concrete strings that should and should not appear. For example, after expanding a file-picker agent, check that the capture shows the search summary but not raw structured payload keys like `results:` or `stdout:`.

## Deterministic lifecycle E2E coverage

Gate and reviewer-spawn lifecycle behavior is covered by generator-boundary
E2E tests in the agents package:

- `agents/e2e/gate-lifecycle.e2e.test.ts` — exercises the pending gate
  files set, validation hooks, durable pass freshness against
  `sha256:<hash>:<byteLength>` markers, and the structured `<gate-state>`
  user-visible contract.
- `agents/e2e/reviewer-spawn-conditions.e2e.test.ts` — exercises the
  conditions under which the reviewer gate spawns or is skipped.

Both tests drive the agent generator with synthetic tool results rather
than live providers, so they run deterministically without API keys or
network access.

## Diagnosing long test output

For broad test suites or failures with long output, preserve the complete log first and extract a focused failure view second. Do not rely only on the terminal tool's truncated summary or on `tail`, which can hide the first failing assertion.

```bash
cd packages/agent-runtime
set -o pipefail
bun test 2>&1 | tee /tmp/openbuff-agent-runtime-test.log >/dev/null
status=${PIPESTATUS[0]}
grep -n -E "\\(fail\\)|error:|Expected|Received|panic|Unhandled" /tmp/openbuff-agent-runtime-test.log | head -120
exit "$status"
```

Then inspect the saved log around the reported line numbers with `sed -n '<start>,<end>p' /tmp/openbuff-agent-runtime-test.log`. This keeps the real exit status while making failures diagnosable even when command output is truncated.

## Rebuilt CLI and context telemetry smoke tests

After rebuilding the packaged CLI with `cd cli && bun run build:binary`, run a direct binary smoke test before assuming the new bundle is active:

```bash
cd cli
./bin/openbuff --version
./bin/openbuff --help | sed -n '1,40p'
```

For a live model-backed smoke test from the repository root, use a short non-mutating prompt and capture the terminal output:

```bash
cli/bin/openbuff --agent base2 "Say READY and stop."
```

Expected output includes the Openbuff banner, the prompt text, and `READY`. The CLI may still run read-only checks such as `git_status` before answering.

To exercise message-trimming context telemetry without a live model, run a small Bun harness that imports `trimMessagesToFitTokenLimit`, creates an over-limit synthetic history with user/assistant messages, todos, file reads, subagent output, and terminal output, and passes a logger that records `debug()` calls. The debug payload should include `contextCategoryTelemetry.before` and `.after` with category token/message counts.
