# Audit findings: resolutions-M4-S6-tooling-ci-docs

- Subsystems: scripts, .github, docs, root-manifests-and-test-bootstrap, packages/code-map
- Features: feat-ci-workflow, feat-nightly-e2e-workflow, feat-ci-local-check, feat-memory-drift-guard, feat-tool-registration-check, feat-gate-helpers-generator, feat-pruner-budgets-generator, feat-mutation-gate-runner, feat-openbuff-example-config, getting-started-docs, project-knowledge-file, agents-tools-docs, config-docs-and-examples, request-flow-docs, testing-docs, local-mode-docs, root-package-scripts, test-bootstrap-scm-loader
- Files covered: 27

## [HIGH] test-coverage — .github/workflows/ci.yml:196 — ALREADY-RESOLVED: CI test job never runs scripts/ tests (find src blind spot)
- **Risk:** ALREADY-RESOLVED (M4-T3): the test matrix now runs `find . ( -path ./node_modules -o -path ./.git -o -path ./dist ) -prune -o -type f -name '*.test.ts' ! -name '*.integration.test.ts' -print` across the whole package, and an empty TEST_FILES result exits 1 with a diagnostic instead of echoing 'No tests found' and passing.
- **Fix:** None required.
- **Evidence:** ci.yml:196-260 test step searches the whole package (M1-T6 comment) with 'exit 1' on empty discovery; scripts/__tests__/ci-workflow.test.ts:32-82 pins the glob, proves it enumerates scripts/__tests__, and asserts a broken scripts test fails the job

## [HIGH] dependency-hygiene — .github/workflows/ci.yml:27 — ALREADY-RESOLVED: third-party CI actions pinned by mutable tags
- **Risk:** ALREADY-RESOLVED (M1-T6): every third-party action in ci.yml is now pinned to a full commit SHA with a version comment (setup-bun, cache, retry, upload-artifact); the TODO markers are gone.
- **Fix:** None required in ci.yml.
- **Evidence:** ci.yml:24/126/222/300 actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0; :27/:130/:228 oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2; :31/:134/:230 actions/cache@caa296126883cff596d87d8935842f9db880ef25 # v5; :196/:317 nick-fields/retry@ce71cc2ab81d554ebbe88c79ab5975992d79ba08 # v3; :252 actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4; no 'TODO: pin to SHA' remains

## [HIGH] security — .github/workflows/nightly-e2e.yml:42 — ALREADY-RESOLVED: toJSON(secrets) materialized every secret into one step
- **Risk:** ALREADY-RESOLVED (M1-T6): the toJSON(secrets) dump is gone; the workflow now declares each secret explicitly in the step env block and persists only the required-and-present subset via generate-ci-env.ts.
- **Fix:** None required.
- **Evidence:** nightly-e2e.yml:42-62 lists every secret by name in the step env block with the M1-T6 comment 'no toJSON(secrets) dump'; no SECRETS_CONTEXT anywhere

## [MEDIUM] security — .github/workflows/nightly-e2e.yml:14 — ALREADY-RESOLVED: nightly-e2e workflow had no permissions block
- **Risk:** ALREADY-RESOLVED (M1-T6): nightly-e2e.yml now declares top-level `permissions: contents: read`.
- **Fix:** None required.
- **Evidence:** nightly-e2e.yml:14-16 'permissions:\n  contents: read' with the M1-T6 comment

## [MEDIUM] security — .github/workflows/ci.yml:79 — ESCALATED: CODEBUFF_GITHUB_TOKEN still written to GITHUB_ENV in ci.yml
- **Risk:** STILL PRESENT: all three jobs (build-and-check :79, test :188, test-integration :339) still persist CODEBUFF_GITHUB_TOKEN into GITHUB_ENV, so every later step — including the retry action and test runs — inherits the token even though no ci.yml step needs it.
- **Fix:** Remove the three `echo "CODEBUFF_GITHUB_TOKEN=$CODEBUFF_GITHUB_TOKEN" >> $GITHUB_ENV` lines from ci.yml; if a step genuinely calls GitHub APIs (none in ci.yml does today), give that step a scoped `env: CODEBUFF_GITHUB_TOKEN: ${{ secrets.OPENBUFF_GITHUB_TOKEN }}` block instead of a job-wide export. Keep the secret defined only in the step-env block that feeds the export loop.
- **Evidence:** ci.yml:79 'echo "CODEBUFF_GITHUB_TOKEN=$CODEBUFF_GITHUB_TOKEN" >> $GITHUB_ENV'; identical at :188 and :339; cli-release-build.yml:178/:578 and buffbench.yml:44 / nightly-evals.yml:47 write the same token into GITHUB_ENV (outside this sweep's editable workflows are still referenced for consistency)

## [MEDIUM] error-handling — scripts/check-ci-local.ts:249 — ALREADY-RESOLVED: step timeout defaulted to 0 (disabled)
- **Risk:** ALREADY-RESOLVED (M3-T1): the per-step cap is ON by default (DEFAULT_CI_LOCAL_STEP_TIMEOUT_MS = 300_000), a positive OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS override wins, an explicit 0 disables it, and invalid values keep the documented default.
- **Fix:** None required.
- **Evidence:** check-ci-local.ts:249 'export const DEFAULT_CI_LOCAL_STEP_TIMEOUT_MS = 300_000'; :257-268 ciLocalStepTimeoutMs() default-on; :340 'timeout: timeoutMs > 0 ? timeoutMs : undefined'; :307-313 timeout-kill hint gated on the cap being armed

## [MEDIUM] state-mutation — scripts/check-ci-local.ts:80 — ALREADY-RESOLVED: check-ci-local force-ignored all of .openbuff/ contradicting memory-drift-guard
- **Risk:** ALREADY-RESOLVED (M4-T3): ensureLockDirIgnored now writes OPENBUFF_DIR_GITIGNORE_CONTENT = '/ci-local.lock\n/.gitignore\n' — scoped to the transient lock and the ignore file itself, deliberately NOT an ignore-all `*` — so a tracked .openbuff/memory/task-memory.json stays `git add`-able and memory-drift-guard's tracked-record path remains reachable.
- **Fix:** None required.
- **Evidence:** check-ci-local.ts:71-80 OPENBUFF_DIR_GITIGNORE_CONTENT = '/ci-local.lock\n/.gitignore\n' with the shared-state contract comment; memory-drift-guard.ts checkTaskMemory doc comment (:1036-1040) cross-references it as the single source for those rules

## [MEDIUM] state-mutation — scripts/run-mutation-gate.ts:8 — ESCALATED: run-mutation-gate does not forward signals; child runs on as an orphan
- **Risk:** STILL PRESENT: the wrapper (19 lines) handles only 'exit' and 'error'. A SIGINT/SIGTERM/SIGHUP to the wrapper kills it without forwarding, orphaning the child (a full gated test/agent run) with OPENBUFF_MUTATION_GATE=1 still set — the run continues after the developer believes it ended and its result is never observed.
- **Fix:** In run-mutation-gate.ts, forward termination signals: `for (const sig of ['SIGINT','SIGTERM','SIGHUP'] as const) process.on(sig, () => child.kill(sig))`, and set the wrapper's exit code from the child's exit/signal in the existing 'exit' handler. Add scripts/__tests__/run-mutation-gate.test.ts covering env propagation (child exits 0 only when OPENBUFF_MUTATION_GATE==='1'), exit-code propagation, and spawn-error exit 1 — the same test file closes the zero-coverage finding below.
- **Evidence:** run-mutation-gate.ts:8-18 registers only 'exit' and 'error' listeners; no SIGINT/SIGTERM/SIGHUP handling; `bun scripts/run-mutation-gate.ts sleep 30` then SIGINT leaves the sleep child running with OPENBUFF_MUTATION_GATE=1

## [MEDIUM] correctness — scripts/check-tool-registration.ts:53 — ALREADY-RESOLVED: handler-registration check used a raw substring that matched longer tool names
- **Risk:** ALREADY-RESOLVED (M4-T3): the runtime-handler layer now uses sourceRegistersHandlerKey(), a word-boundary property-key regex `(^|[\s{,(])<tool>\s*:` applied per line after stripping `//` comments, instead of the raw `${tool}:` substring that matched longer sibling keys like `overwrite:`.
- **Fix:** None required.
- **Evidence:** check-tool-registration.ts:53-67 sourceRegistersHandlerKey (comment documents the overwrite: false-positive it prevents); checkTool uses it for the handlers/list.ts layer at :73-81 while sibling layers keep exact quoted forms; scripts/__tests__/check-tool-registration.test.ts covers it

## [MEDIUM] performance — scripts/memory-drift-guard.ts:104 — ALREADY-RESOLVED: 12 checkers each re-walked the repo and re-read every markdown file
- **Risk:** ALREADY-RESOLVED (M3-T2): runMemoryDriftGuard builds ONE shared MarkdownSnapshot (one walk + one read per file) and hands it to every checker; direct checker calls without a snapshot keep their own walk for backward compatibility.
- **Fix:** None required.
- **Evidence:** memory-drift-guard.ts:104-132 buildMarkdownSnapshot + snapshotFiles; runMemoryDriftGuard (:1096-1110) walks once and passes the snapshot to every checker; the doc comment documents the before/after and backward compatibility

## [MEDIUM] performance — scripts/memory-drift-guard.ts:453 — ACCEPTED: batchLastCommitEpochs still spawns one git log per pathspec
- **Risk:** PARTIALLY IMPROVED, accepted with rationale: batchLastCommitEpochs still spawns one `git log -1` per distinct pathspec (the dedupe collapses repeats), and checkStaleness calls lastCommitEpochForTopic once per distinct (src, topic) key. The dominant waste — one git status per knowledge.md — was already removed by batchDirtySet (single `git status --porcelain` for all paths).
- **Fix:** Accepted: the dominant cost (a spawn per knowledge.md for dirty-state, plus un-deduped timestamp lookups) was already removed by the M3-T2 batchDirtySet refactor and pathspec dedupe. The remaining `git log -1` spawns scale with the count of DISTINCT knowledge.md-with-src dirs (single digits in this repo) and are cheap relative to the guarded suites in the same gate. A single `git log --format=%ct --name-only` reduce would save milliseconds per pre-push; revisit only if the gate is ever measured slow.
- **Evidence:** memory-drift-guard.ts:453-460 batchLastCommitEpochs still loops lastCommitEpoch (:500-521 one execFileSync per pathspec); checkStaleness (:406-421) dedupes pathspecs before calling it and batchDirtySet (:462+) is a single git status

## [MEDIUM] test-coverage — .github/workflows/ci.yml:248 — ALREADY-RESOLVED: retry@v3 masked real failures with no flake tracking
- **Risk:** ALREADY-RESOLVED (M4-T3): the retry action's total_attempts output is now persisted per-suite into scripts/flake-ledger.json (sanitizing matrix slashes for artifact names) and uploaded as an artifact on every run, so absorbed retries are tracked instead of silently discarded.
- **Fix:** None required.
- **Evidence:** ci.yml:248-277 'Record test flakiness' step (if: always()) writes ledger[SUITE] = steps.tests.outputs.total_attempts; :278-286 uploads scripts/flake-ledger.json as an artifact; scripts/flake-ledger.json exists and scripts/__tests__/flake-ledger.test.ts validates it

## [MEDIUM] dependency-hygiene — .github/workflows/ci.yml:29 — ESCALATED: CI pins bun 1.3.5 while scripts engines requires 1.3.11
- **Risk:** STILL PRESENT: all three ci.yml jobs install bun-version '1.3.5' while scripts/package.json declares engines.bun '1.3.11' (and knowledge.md pins 1.3.11 via packageManager). Bun-version-dependent behavior (Bun.Glob in check-tool-registration, spawnSync timeout in check-ci-local) is validated on a different runtime than declared.
- **Fix:** Switch the three ci.yml setup-bun steps to `bun-version-file: .bun-version` (the setup-project action's existing pattern) — or align the literal to the engines value — so CI validates the declared runtime; add a one-line guard to scripts/__tests__/ci-workflow.test.ts asserting the workflow no longer pins a literal that diverges from scripts/package.json engines.bun.
- **Evidence:** ci.yml:29/:132/:236 'bun-version: \'1.3.5\''; scripts/package.json:28-30 '"engines": { "bun": "1.3.11" }'; .github/actions/setup-project/action.yml:5-16 already inputs bun-version-file with default '.bun-version'; knowledge.md asserts 1.3.11 as the pinned runtime

## [MEDIUM] api-contract — scripts/package.json:1 — ALREADY-RESOLVED: package exports map pointed at nonexistent src/index.ts
- **Risk:** ALREADY-RESOLVED (M4-T3): the `exports` block pointing at the nonexistent ./src/index.ts was removed; the private scripts package is now consumed only as standalone scripts via deep paths.
- **Fix:** None required.
- **Evidence:** scripts/package.json:1-31 has no exports field; tests import via deep relative paths (e.g. agents/__tests__/pruner-budgets-freshness.test.ts from '../../scripts/generate-pruner-budgets')

## [LOW] security — scripts/memory-drift-guard.ts:1067 — ESCALATED: checkTaskMemory joins unvalidated JSON paths to root without containment
- **Risk:** STILL PRESENT: evidence paths from task-memory.json are joined to root with no containment check, so `../../../etc/passwd`-style entries create an existence oracle in CI logs and a crafted committed record can fail the blocking gate on paths no source change can fix.
- **Fix:** In checkTaskMemory: `const abs = resolve(root, item.path); if (abs !== root && !abs.startsWith(root + sep)) continue` (or emit a dedicated 'evidence path escapes the repository root' finding), then existsSync(abs). Add a memory-drift-guard.test.ts case with a '../../../' evidence path asserting it produces no arbitrary-path finding.
- **Evidence:** memory-drift-guard.ts:1067 `if (!existsSync(join(root, item.path)))` with item.path typed unknown and only checked for string/length; checkCommand's cwd validation (:448) uses the root+sep discipline

## [LOW] correctness — scripts/memory-drift-guard.ts:174 — ESCALATED: nearestPackageJsonSubdir uses startsWith(root) as the path boundary
- **Risk:** STILL PRESENT: the walk condition `while (dir.startsWith(root))` treats any sibling sharing the root string as inside the project (root /home/u/repo also matches /home/u/repo-extra/pkg), so checkCommand can adopt a foreign package.json as cwd context and produce wrong script-missing findings.
- **Fix:** Change the loop to `while (dir === root || dir.startsWith(root + sep))`, matching checkCommand's boundary discipline; add a test whose temp root has a same-prefix sibling directory containing a package.json and assert it is never adopted.
- **Evidence:** memory-drift-guard.ts:172-176 'while (dir.startsWith(root))'; checkCommand's own validation (~:448) uses `!subdir.startsWith(root + sep)`

## [LOW] correctness — scripts/memory-drift-guard.ts:569 — ESCALATED: pathHasWorkingTreeChanges is dead code
- **Risk:** STILL PRESENT: pathHasWorkingTreeChanges is defined but never called anywhere; dead git-invoking code invites drift from batchDirtySet (the real behavior) and inflates untested surface.
- **Fix:** Delete the function (preferred; checkStaleness's batchDirtySet covers the need).
- **Evidence:** memory-drift-guard.ts:569-584 definition only; repo-wide search for pathHasWorkingTreeChanges matches nothing else

## [LOW] error-handling — scripts/memory-drift-guard.ts:443 — ESCALATED: checkStaleness swallows all git failures and reports a clean run
- **Risk:** STILL PRESENT: checkStaleness wraps its whole body in a catch that console.debugs and returns [], and batchDirtySet/lastCommitEpoch each swallow errors too; on a git-less machine the gate reports '0 findings across 12 checkers' while staleness never actually ran.
- **Fix:** Add `skipped?: string` to CheckerResult, set it from checkStaleness's catch (and propagate a git-unavailable signal from batchDirtySet/lastCommitEpoch), and have formatMemoryDriftReport append 'checkers skipped: <names+reasons>' so a clean run is never reported for a checker that did not execute.
- **Evidence:** memory-drift-guard.ts:443-450 catch returns []; batchDirtySet :486-488 and lastCommitEpoch :512-514 degrade silently; formatMemoryDriftReport :1112-1130 prints only the findings count

## [LOW] correctness — scripts/memory-drift-guard.ts:54 — ESCALATED: BROKEN_LINK_REGEX flags mailto:/tel:/empty targets as broken links
- **Risk:** STILL PRESENT: BROKEN_LINK_REGEX targets are only exempted for http://, https:// and '#'; mailto:, tel:, and reference-style leftovers resolve to nonexistent local paths and are reported as broken links, training maintainers to ignore the checker.
- **Fix:** Skip any target matching `^[a-z][a-z0-9+.\-]*:` (URI scheme) and empty/whitespace-only targets before resolve(); add mailto:/tel: cases to the broken-link test so real path regressions stay visible.
- **Evidence:** memory-drift-guard.ts:54 regex; :1002-1008 only http://, https://, '#' are exempted before resolve+existsSync

## [LOW] correctness — scripts/generate-pruner-budgets.ts:153 — ESCALATED: generate-pruner-budgets projectRootFromMeta breaks on Windows (URL.pathname)
- **Risk:** STILL PRESENT: projectRootFromMeta derives the root from URL.pathname, yielding /C:/repo-style paths (and mangling URL-encoded characters) on Windows; the correct fileURLToPath implementation already exists in check-ci-local.ts.
- **Fix:** Use `path.resolve(path.dirname(fileURLToPath(metaUrl)), '..')` (import { fileURLToPath } from 'node:url'), mirroring check-ci-local.ts; agents/__tests__/pruner-budgets-freshness.test.ts already exercises projectRootFromMeta so no new test wiring is needed beyond a Windows-shaped-input case if practical.
- **Evidence:** generate-pruner-budgets.ts:153-155 `return path.resolve(path.dirname(new URL(metaUrl).pathname), '..')`; the correct pattern is scripts/check-ci-local.ts:33-35 `resolve(dirname(fileURLToPath(metaUrl)), '..')`

## [LOW] api-contract — scripts/generate-gate-helpers.ts:164 — ESCALATED: generate-gate-helpers extractRegion slices from mid-line marker text
- **Risk:** STILL PRESENT: extractRegion slices from text.indexOf(OPEN_MARKER) (mid-line), keeping later lines' indentation while generateBlock emits unindented body lines; any future re-indentation of the base2.ts marker region makes --check report a whitespace-only STALE diff with no actionable cause. The pruner generator already fixed the mirror-image of this bug.
- **Fix:** Port the pruner semantics into generate-gate-helpers.ts: `const lineStart = text.lastIndexOf('\n', OPEN_MARKER...) + 1` and slice from lineStart (and splice from lineStart in runWrite for byte-preservation symmetry). Since generateBlock emits unindented bodies and base2.ts's region is currently unindented, the tracked region stays byte-identical — re-run the ci-workflow --check test after the change to confirm.
- **Evidence:** generate-gate-helpers.ts:164-170 `text.slice(start, closeStart + CLOSE_MARKER.length)` with no lineStart anchor; scripts/generate-pruner-budgets.ts:229-238 extractRegion slices from `text.lastIndexOf('\n', markerIndex) + 1` with the explanatory comment; ci-workflow.test.ts:93-105 keeps --check green for the tracked region today

## [LOW] api-contract — .github/workflows/ci.yml:117 — ALREADY-RESOLVED: --check mode had no caller anywhere
- **Risk:** ALREADY-RESOLVED (M4-T3): generate-gate-helpers --check is now wired into ci.yml build-and-check as its own gate step ('Check generated gate helpers are current'), so region drift fails CI instead of surfacing as an unexplained base2.ts diff from a prebuild --write.
- **Fix:** None required.
- **Evidence:** ci.yml:117-119 'Check generated gate helpers are current' step runs the --check mode; scripts/__tests__/ci-workflow.test.ts:85-105 asserts the command is wired and that --check exits 0 for the tracked region

## [LOW] test-coverage — scripts/generate-gate-helpers.ts:1 — ESCALATED: generate-gate-helpers internals are not directly unit-tested
- **Risk:** STILL PRESENT: generate-gate-helpers.ts exports nothing; its internals (stripExportModifier with leading comments, extractRegion, runWrite's missing-marker refusal) are only exercised end-to-end as byte comparisons via the agents freshness test, unlike the pruner generator whose helpers are exported and unit-tested including failure modes.
- **Fix:** Export stripExportModifier/extractRegion/normalizeTrailingWhitespace/splice-equivalents from generate-gate-helpers.ts and add scripts/__tests__/generate-gate-helpers.test.ts asserting: JSDoc-preceded export stripping, deterministic output, runWrite refusing missing markers (error path), and regionIsFresh-style round-trip stability — mirroring the pruner test's shape.
- **Evidence:** scripts/__tests__/ contains flake-ledger, check-tool-registration, placeholder, init-worktree, release-workflow, memory-drift-guard, ci-workflow, check-ci-local, check-doc-citations, check-env-architecture, byok-wording-guard, sync-agent-config tests; generate-gate-helpers.ts exports nothing (no `export` keyword) while generate-pruner-budgets.ts exports its full core for agents/__tests__/pruner-budgets-freshness.test.ts

## [LOW] test-coverage — scripts/run-mutation-gate.ts:1 — ESCALATED: run-mutation-gate has zero test coverage
- **Risk:** STILL PRESENT: nothing asserts the wrapper's contract — that OPENBUFF_MUTATION_GATE=1 reaches the child (the entire reason the wrapper exists), that child exit codes propagate, or that spawn errors exit 1; a regression dropping the env var would silently disable mutation gating while every invocation still exits 0.
- **Fix:** Same test file as the signal-forwarding fix above: spawn the wrapper with `bun -e 'process.exit(process.env.OPENBUFF_MUTATION_GATE === "1" ? 0 : 7)'` and assert exit 0 + env propagation; a failing-child case asserting the child's exit code propagates; a nonexistent-command case asserting exit 1.
- **Evidence:** run-mutation-gate.ts is 19 lines with the env var only in its own spawn options; the only repo references are scripts/package.json harness:mutation and a docs/testing.md prose mention; no *.test.ts importer

## [LOW] api-contract — openbuff.d.example/providers.json:152 — ESCALATED (out-of-scope): near-duplicate providers agentrouter and AGENT_ROUTER in the example config
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE (openbuff.d.example/** is not in M4-S6's editable scope): near-duplicate providers `agentrouter` and `AGENT_ROUTER` share baseURL and apiKeyEnv but list divergent model sets, and the uppercase id breaks the lowercase convention every other provider follows.
- **Fix:** Merge into one lowercase `agentrouter` entry with the union of models (or give the second entry a distinct endpoint), and state the provider-id naming rule (lowercase, stable) in an openbuff.d.example README.
- **Evidence:** openbuff.d.example/providers.json:123-151 'agentrouter' (glm-5.2, gpt-5.5, gpt-5.4, claude-opus-4-6, deepseek-v4-pro, deepseek-v4-flash) and :152-164 'AGENT_ROUTER' (glm-5.1, deepseek-v4-pro, deepseek-v4-flash), same baseURL https://agentrouter.org/v1 and apiKeyEnv AGENT_ROUTER_TOKEN

## [LOW] api-contract — openbuff.d.example/providers.json:280 — ESCALATED (out-of-scope): two undocumented shapes for models in the example config
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE: the example mixes array and object-map shapes for `models` without documenting which is valid where, nor which sibling fields are required vs optional; users cannot distinguish 'optional' from 'forgotten'.
- **Fix:** Add openbuff.d.example/README.md (or a JSON Schema validated in CI) documenting models array-vs-map semantics, required fields, and optional-capability defaults; normalize the example to one models shape.
- **Evidence:** openbuff.d.example/providers.json:280-286 'agent-platform' declares "models": { "gemini-3.5-flash": "google/gemini-3.5-flash", ... } (object) while e.g. :8-19 'opencode-go' declares an array; defaultCapabilities absent for codex (:32-57), cavoti (:565-578), navyai, babel, anyrouter, hapuppy, futureppo, iamhc

## [LOW] security — openbuff.d.example/providers.json:276 — ESCALATED (out-of-scope): concrete-looking GCP project id in the example baseURL
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE: the agent-platform baseURL embeds a concrete-looking GCP project/endpoint id that reads as a real Vertex identifier; example files get copied verbatim into real configs.
- **Fix:** Replace with an obvious placeholder (projects/YOUR_PROJECT_ID/...) and add a one-line example-README note that every id/env name must be substituted.
- **Evidence:** openbuff.d.example/providers.json:276-279 agent-platform baseURL 'https://aiplatform.googleapis.com/v1/projects/project-7a6f8b41-2520-4c35-a45/locations/global/endpoints/openapi'

## [LOW] dependency-hygiene — .github/workflows/nightly-e2e.yml:24 — ESCALATED: nightly-e2e and the setup-project composite action use unpinned actions
- **Risk:** STILL PRESENT: nightly-e2e.yml runs `actions/checkout@v6` by mutable tag (the same workflow that handles the provider secrets), and the shared composite action .github/actions/setup-project itself uses unpinned setup-bun@v2 / cache@v5 — so the SHA-pinning policy ci.yml follows is not applied here and diverges per-file by hand.
- **Fix:** Pin nightly-e2e.yml's checkout to `actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0` (the same SHA ci.yml uses), and pin the composite action's setup-bun/cache to the same SHAs ci.yml uses (oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2, actions/cache@caa296126883cff596d87d8935842f9db880ef25 # v5). Do not weaken the existing permissions block or add secrets.
- **Evidence:** nightly-e2e.yml:24-25 'uses: actions/checkout@v6' and :27 'uses: ./.github/actions/setup-project'; .github/actions/setup-project/action.yml:14 'oven-sh/setup-bun@v2' and :19 'actions/cache@v5' (unpinned)

## [MEDIUM] test-coverage — package.json:30 — ESCALATED (out-of-scope): root test script omits @codebuff/code-map and @codebuff/internal
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE (root package.json is not in M4-S6's editable scope): the root `test` filter runs 8 workspaces but omits @codebuff/code-map and @codebuff/internal, both of which ship runnable test scripts, so tree-sitter grammar/symbol extraction and provider-wrapper tests are silently skipped on every root-level run.
- **Fix:** Add `@codebuff/code-map` and `@codebuff/internal` to the filter list at package.json:30 (or switch to `bun --filter='*' run test` and let test-less workspaces no-op), then document the authoritative suite scope in docs/testing.md (in scope).
- **Evidence:** package.json:30 test filter = {@codebuff/common,@codebuff/agents,@codebuff/agent-runtime,@codebuff/indexer,@openbuff/sdk,@codebuff/cli,@codebuff/evals,@codebuff/scripts}; packages/code-map/package.json:22 and packages/internal/package.json:36 both have "test": "bun test"; neither appears in the filter

## [MEDIUM] test-coverage — packages/code-map/bunfig.toml:1 — ESCALATED: .scm loader not preloaded in packages/code-map (no bunfig.toml)
- **Risk:** STILL PRESENT: packages/code-map has NO bunfig.toml, so `cd packages/code-map && bun test` runs without the .scm text loader; code-map tests mask loader regressions by re-reading .scm files from disk.
- **Fix:** Create packages/code-map/bunfig.toml with `[test]\npreload = ["../../test/setup-scm-loader.ts", "../../sdk/test/setup-env.ts"]` (same pattern as packages/agent-runtime/bunfig.toml, including the explanatory comment), then run `cd packages/code-map && bun test` to confirm the suite stays green with the loader active.
- **Evidence:** glob **/bunfig.toml -> {bunfig.toml, sdk/bunfig.toml, packages/agent-runtime/bunfig.toml} only; packages/agent-runtime/bunfig.toml:2 preloads '../../test/setup-scm-loader.ts'; packages/code-map/package.json:22 "test": "bun test"; packages/code-map/__tests__/languages.test.ts re-reads .scm from disk with a Bun-quirk workaround comment

## [MEDIUM] api-contract — docs/configuration.md:33 — ALREADY-RESOLVED: config docs cited this repo's openbuff.d/ fragments that do not exist
- **Risk:** ALREADY-RESOLVED (M5-T9): the fragment-layout passage now presents openbuff.json.example + openbuff.d.example/ as a copyable example set ('copy them to openbuff.json and openbuff.d/ to adopt it'), and the windowTokens passage cites 'The shipped example openbuff.d.example/providers.json' rather than a nonexistent in-repo openbuff.d/.
- **Fix:** None required.
- **Evidence:** docs/configuration.md:33-41 'This repo ships a copyable example of this pattern (openbuff.json.example plus openbuff.d.example/); copy them to openbuff.json and openbuff.d/ to adopt it'; :239 'The shipped example openbuff.d.example/providers.json sets defaultCapabilities.context.windowTokens: 500000' (claim verified against openbuff.d.example/providers.json); scripts/check-doc-citations.ts exists and scripts/__tests__/check-doc-citations.test.ts covers it

## [MEDIUM] api-contract — openbuff.json.example:2 — ESCALATED (out-of-scope): openbuff.json.example includes point at nonexistent openbuff.d/ fragments
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE (openbuff.json.example is not in M4-S6's editable scope): the example's `includes` reference openbuff.d/providers.json, routes.json and indexing.json which are absent from the repo (only openbuff.d.example/ ships), so a user copying it verbatim gets includes that resolve to nothing; hooks.json is also omitted although docs list it in the same fragment set.
- **Fix:** Point `includes` at the copyable example paths with an explicit copy step (e.g. a _comment field: 'copy openbuff.d.example/ to openbuff.d/ first; hooks.json is optional — include openbuff.d.example/hooks.json only if you use file-change hooks'), or inline a minimal providers/routes block so the example is self-contained.
- **Evidence:** openbuff.json.example:2-6 includes openbuff.d/providers.json, openbuff.d/routes.json, openbuff.d/indexing.json; openbuff.d does not exist (only openbuff.d.example/ ships); hooks.json is absent from the includes list while docs/configuration.md's fragment set mentions it

## [LOW] api-contract — openbuff.json.example:7 — ESCALATED (out-of-scope): example comment cites the wrong file for resolveConfiguredAgentModelConfig
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE: the example's comment cites sdk/src/impl/model-provider.ts:resolveConfiguredAgentModelConfig, but the function is defined and exported in sdk/src/provider-config.ts and only imported by model-provider.ts — a debugger following the comment lands in the wrong module.
- **Fix:** Change the citation to `sdk/src/provider-config.ts:resolveConfiguredAgentModelConfig` (noting it is imported by sdk/src/impl/model-provider.ts).
- **Evidence:** openbuff.json.example:7 'sdk/src/impl/model-provider.ts:resolveConfiguredAgentModelConfig hard-errors'; code_search shows `export function resolveConfiguredAgentModelConfig` in sdk/src/provider-config.ts with only an import at sdk/src/impl/model-provider.ts:31

## [LOW] api-contract — docs/agents-and-tools.md:117 — ALREADY-RESOLVED: docs instructed registering pattern agents in nonexistent openbuff.d/routes.json
- **Risk:** ALREADY-RESOLVED (M5-T9 sweep-adjacent): the pattern-specific-agent instruction now points at the shipped template — 'copy the shipped openbuff.d.example/routes.json into your project's openbuff.d/routes.json and register it there' — which is actionable and consistent with the configuration docs' copy-the-example wording.
- **Fix:** None required.
- **Evidence:** docs/agents-and-tools.md:117 'follow the same convention: copy the shipped openbuff.d.example/routes.json into your project's openbuff.d/routes.json and register it there'; openbuff.d.example/routes.json exists

## [LOW] api-contract — docs/agents-and-tools.md:1978 — ALREADY-RESOLVED: slash-command table omitted /plans and /plan-use
- **Risk:** ALREADY-RESOLVED (M5-T9): the Durable plans row now includes `plans` (`plan-ls`) and `plan-use` (`plan-active`, `use-plan`), matching command-registry.ts and the command-args regression tests.
- **Fix:** None required.
- **Evidence:** docs/agents-and-tools.md:1978 '| Durable plans | interview, resume-plan (rp), update-plan (up), plan-status (ps), lessons (lesson), plans (plan-ls), plan-use (plan-active, use-plan) |'; cli/src/commands/command-registry.ts:354-382 implements both with those aliases; command-args.test.ts:246-254 asserts registration

## [LOW] api-contract — README.md:76 — ESCALATED: README agent examples present model: as if it routes the agent
- **Risk:** STILL PRESENT: the git-committer example (:76) and the SDK custom-agent example (:125) present `model:` as the agent's model selection with no caveat, while docs/configuration.md states the field is documentation of intent only and is never read at runtime; users copying the examples expect per-agent models to take effect and get silent routing to defaultModel.
- **Fix:** Add one sentence directly after each example code block: 'Note: `model` on an agent definition is intent-documentation only — it is never read at runtime. Actual routing is resolved from openbuff.json (modes/agents/defaultModel); see docs/configuration.md.' Keep the local-first BYOK wording (no hosted-backend claims) per the repo's wording guard.
- **Evidence:** README.md:76 and :125 set `model: 'openai/...'` inside agent-definition examples with no caveat; docs/configuration.md:94-97 'The model: field on agent templates is documentation of intent only — it is never read at runtime'; sdk/src/provider-config.ts:1710-1783 resolves models exclusively from loadedConfig (modes -> agents -> defaultModel -> explicit param)

## [LOW] api-contract — README.md:198 — ALREADY-RESOLVED: Running Tests told contributors cd cli && bun test runs the suite
- **Risk:** ALREADY-RESOLVED (M5-T9): Running Tests now leads with the repo-root `bun run test` (all workspaces) and presents `cd cli && bun test` as the fast per-package loop, matching docs/testing.md.
- **Fix:** None required.
- **Evidence:** README.md:198-211 'To run the test suite from the repository root: bun run test' with 'cd cli && bun test' as the fast per-package loop; package.json:30 defines the root test filter; docs/testing.md carries the same guidance

## [LOW] state-mutation — package.json:26 — ESCALATED (root manifest out-of-scope): smoke:openbuff sets OPENBUFF_LOCAL_MODE=true as a dead toggle
- **Risk:** PARTIALLY OUT OF EDITABLE SCOPE: package.json:26 and cli/package.json:18 still set OPENBUFF_LOCAL_MODE=true although no code reads it as a toggle (it is only forwarded through env plumbing) and docs/local-mode.md says no cloud-mode toggle exists.
- **Fix:** Docs half is in scope: add one sentence to docs/local-mode.md stating OPENBUFF_LOCAL_MODE is vestigial (forwarded for legacy compatibility only; local/BYOK is unconditional and setting it false changes nothing). Removing the env assignment from package.json/cli/package.json is out of M4-S6's editable scope — flag for a root-manifest task.
- **Evidence:** package.json:26 "smoke:openbuff": "OPENBUFF_LOCAL_MODE=true bun scripts/openbuff-smoke.ts"; cli/package.json:18 dev script sets the same; docs/local-mode.md:19 'Openbuff is always local/BYOK — there is no cloud-mode toggle'; common/src/constants/local-mode.ts exports only LOCAL_MODE_USER_ID/LOCAL_MODE_EMAIL; common/src/env-process.ts:36 and common/src/types/contracts/env.ts:77 only forward the value

## [LOW] correctness — docs/agents-and-tools.md:1247 — ALREADY-RESOLVED: truncated sentence in the create_plan / update_plan_status section
- **Risk:** ALREADY-RESOLVED (M5-T9): the truncated fragment is restored to a full sentence — '`update_plan_status` is the right tool for incremental status or lesson updates.' — so the tool-choice distinction reads correctly.
- **Fix:** None required.
- **Evidence:** docs/agents-and-tools.md:1245-1248 heading '### `create_plan` and `update_plan_status`' followed by the complete sentence '`update_plan_status` is the right tool for incremental status or lesson updates.'; phrasing matches docs/local-mode.md's 'prefer update_plan_status for incremental STATUS.md and lesson-note edits'

## [LOW] correctness — docs/request-flow.md:185 — ALREADY-RESOLVED: prose paragraph trapped inside the Tool Call Lifecycle code fence
- **Risk:** ALREADY-RESOLVED (M5-T9): the prose paragraph now sits above the fence — the Tool Call Lifecycle section reads 'Tool calls always execute on the user's machine:' as prose, and the code block contains only the ASCII lifecycle diagram; the fence/paragraph corruption is gone.
- **Fix:** None required.
- **Evidence:** docs/request-flow.md:185-200: '## Tool Call Lifecycle' heading, prose paragraph 'Tool calls always execute on the user's machine:' at :187, then the opening ``` at :189 with only the ASCII lifecycle diagram inside the fence; no prose inside the block

## [LOW] correctness — README.md:227 — ALREADY-RESOLVED: README link text cli/src/**tests**/README.md rendered as broken bold markdown
- **Risk:** ALREADY-RESOLVED: the link text is now properly backticked — [`cli/src/__tests__/README.md`](cli/src/__tests__/README.md) — so it renders as a path instead of broken bold emphasis.
- **Fix:** None required.
- **Evidence:** README.md:227 'See [`cli/src/__tests__/README.md`](cli/src/__tests__/README.md) for comprehensive testing documentation.' — link text is backticked and matches the real path; cli/src/__tests__/README.md exists (no check-doc-citations violation)

## [LOW] correctness — knowledge.md:1 — ALREADY-RESOLVED: repo-root knowledge.md was an unfilled scaffold
- **Risk:** ALREADY-RESOLVED (M5-T9): root knowledge.md is fully filled with this repo's real commands, architecture, and conventions (bun install/dev/test, typecheck, check:ci-local, key directories, CLI→SDK→agent-runtime data flow, Prettier/DI conventions) and follows the existing style without mentioning unimplemented OPENBUFF_* env aliases.
- **Fix:** None required.
- **Evidence:** knowledge.md:1-24 filled Quickstart (setup/dev/test incl. the bun --cwd pitfall), Architecture (key dirs + local/BYOK data flow), Conventions (format/typecheck/gates, DI-over-mocking, retrieval-led context, ErrorOr, no force-push main, no unimplemented OPENBUFF_* aliases); defers to AGENTS.md and docs/development.md; scripts/byok-wording-guard.ts passes over it

## [LOW] error-handling — test/setup-scm-loader.ts:8 — ESCALATED (out-of-scope): readFile failure in the .scm onLoad handler surfaces as a raw fs error
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE (root test/ is not in M4-S6's editable scope): the .scm onLoad handler awaits readFile bare, so a missing/unreadable query file surfaces as an opaque ENOENT/EACCES stack naming no importer or query file.
- **Fix:** Wrap the readFile in try/catch and rethrow a descriptive error naming args.path and the loader (`scm-text-loader: failed to read query file <path>: <cause>`), preserving the original as `cause`.
- **Evidence:** test/setup-scm-loader.ts:7-13 'const text = await readFile(args.path, \'utf8\'); return { exports: { default: text }, loader: \'object\' }' — no catch, no context enrichment

## [LOW] state-mutation — bunfig.toml:10 — ESCALATED (out-of-scope): preload order of setup-scm-loader vs setup-env differs across bunfig.toml files
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE (root and sdk bunfig.toml are not in M4-S6's editable scope): the root bunfig preloads setup-scm-loader before sdk setup-env while sdk/bunfig.toml preloads setup-env first, so plugin/env initialization order differs per workspace — an init-order hazard invisible until it produces a workspace-only failure.
- **Fix:** Standardize one order in all three bunfig.toml files (env setup first, then the scm loader) with a comment noting the invariant. Root and sdk bunfig.toml are outside M4-S6's editable scope — bundle with the root-manifest task.
- **Evidence:** bunfig.toml:10 preload = ["./test/setup-scm-loader.ts", "./sdk/test/setup-env.ts"]; sdk/bunfig.toml:9 preload = ["./test/setup-env.ts", "../test/setup-scm-loader.ts"]; packages/agent-runtime/bunfig.toml:2 matches root

## [LOW] dependency-hygiene — package.json:38 — ESCALATED (out-of-scope): canvas + gif-encoder-2 in root production dependencies
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE (root package.json is not in M4-S6's editable scope): canvas (native build) and gif-encoder-2 are consumed only by the tmux-viewer debug helper yet sit in root production dependencies, so every workspace install pays native-build cost and supply-chain surface for a dev tool.
- **Fix:** Move both to devDependencies (root or the scripts workspace) leaving root dependencies for genuinely shared runtime packages; bundle with the root-manifest task that also owns the test-filter fix.
- **Evidence:** package.json:38-39 "canvas": "^3.2.0", "gif-encoder-2": "^1.0.5" under root dependencies; sole importer scripts/tmux/tmux-viewer/gif-exporter.ts:9-15; root dependencies otherwise carry genuinely shared runtime packages

## [LOW] dependency-hygiene — package.json:60 — ESCALATED (out-of-scope): duplicated major-mismatched TypeScript ESLint stacks; eslint undeclared
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE: root devDependencies carry both @typescript-eslint/eslint-plugin@^6 and typescript-eslint@^7 (two incompatible major lines) while eslint itself is undeclared and arrives only transitively; a hoisting change can break eslint resolution with no direct dependency to pin.
- **Fix:** Keep one stack (typescript-eslint v7), delete @typescript-eslint/eslint-plugin@^6 (checking eslint-config-prettier/eslint-plugin-* peers), and add eslint as an explicit devDependency pinned to the version the v7 stack supports. Root package.json — outside M4-S6's editable scope; bundle with the root-manifest task.
- **Evidence:** package.json:60 "@typescript-eslint/eslint-plugin": "^6.17" vs "typescript-eslint": "^7.17.0" in the same devDependencies; no "eslint" entry despite root eslint.config.js; devDeps also list eslint-config-prettier/eslint-plugin-import/eslint-plugin-unused-imports

## [LOW] performance — package.json:28 — ESCALATED (out-of-scope): clean-ts scans the whole tree including node_modules before deleting it
- **Risk:** STILL PRESENT, OUT OF EDITABLE SCOPE: clean-ts scans the entire tree (including the node_modules it is about to delete) twice before removing it — minutes of wasted I/O on large checkouts.
- **Fix:** Reorder to delete node_modules first, then run the tsbuildinfo/.next sweeps (or add -not -path '*/node_modules/*' to the first two finds). Root package.json — outside M4-S6's editable scope; bundle with the root-manifest task.
- **Evidence:** package.json:28 clean-ts runs `find . -name '*.tsbuildinfo' -type f -delete && find . -name '.next' -type d -exec rm -rf {} + ... && find . -name 'node_modules' -type d -exec rm -rf {} + ... && bun install` — the first two finds traverse node_modules before it is removed

## [LOW] security — README.md:37 — ESCALATED: README getting-started guidance tells users to export API keys inline
- **Risk:** STILL PRESENT: the Configure-a-provider paragraph and the Provider configuration block both instruct inline `export <API_KEY>="..."`, which persists plaintext provider keys to shell history and scrollback — a needless secret-leak vector for a local-first BYOK tool whose security model is local key custody.
- **Fix:** In README.md, add a one-line secret-custody note next to both commands — e.g. 'Tip: inline `export` persists the key to shell history; prefer `read -s VAR && export VAR`, a gitignored .env, or `/provider status`-driven entry (credentials.json is written 0600 — see docs/configuration.md).' Keep BYOK local-first wording throughout.
- **Evidence:** README.md:37 'Then export the API key env var named by your provider's apiKeyEnv (e.g. `export OPENAI_API_KEY="..."`)'; :165 'export OPENCODE_GO_API_KEY="your_key"'; docs/configuration.md:20-31 documents the safer 0600 credentials.json path; scripts/byok-wording-guard.ts passes today and any edit must keep local-first BYOK wording (no hosted-backend/subscription claims)

## Coverage receipt

### Subsystems
- scripts
- .github
- docs
- root-manifests-and-test-bootstrap
- packages/code-map

### Features
- feat-ci-workflow
- feat-nightly-e2e-workflow
- feat-ci-local-check
- feat-memory-drift-guard
- feat-tool-registration-check
- feat-gate-helpers-generator
- feat-pruner-budgets-generator
- feat-mutation-gate-runner
- feat-openbuff-example-config
- getting-started-docs
- project-knowledge-file
- agents-tools-docs
- config-docs-and-examples
- request-flow-docs
- testing-docs
- local-mode-docs
- root-package-scripts
- test-bootstrap-scm-loader

### Files
- .github/workflows/ci.yml
- .github/workflows/nightly-e2e.yml
- .github/actions/setup-project/action.yml
- scripts/check-ci-local.ts
- scripts/memory-drift-guard.ts
- scripts/check-tool-registration.ts
- scripts/run-mutation-gate.ts
- scripts/generate-gate-helpers.ts
- scripts/generate-pruner-budgets.ts
- scripts/package.json
- scripts/generate-ci-env.ts
- openbuff.d.example/providers.json
- README.md
- knowledge.md
- docs/configuration.md
- docs/agents-and-tools.md
- docs/request-flow.md
- docs/local-mode.md
- docs/testing.md
- openbuff.json.example
- package.json
- bunfig.toml
- test/setup-scm-loader.ts
- packages/code-map/bunfig.toml
- common/src/constants/local-mode.ts
- cli/src/commands/command-registry.ts
- scripts/__tests__/ci-workflow.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
