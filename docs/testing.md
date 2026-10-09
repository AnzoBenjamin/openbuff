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

  This matches the test discovery command in `.github/workflows/ci.yml` exactly
  (it collects both `*.test.ts` and `*.test.tsx`, excluding
  `*.integration.test.ts`).

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
