# AUDIT REPORT — Uncommitted changes on `feat/polyglot-reaudit-roadmap` (2026-10-23)

Synthesized from `findings/shard-1` … `findings/shard-7` + validation results in
`STATUS.md` (two picker sweeps folded in via STATUS). Working tree was the source of
truth throughout; no raw source was re-read for this synthesis. Two orchestrator
late-breaking facts are folded in and marked **[late]**.

---

## 1. Verdict

The changeset is **coherent in direction and largely non-breaking, but NOT safe to
commit as-is: CI is guaranteed red on this commit.** The bulk of the work is sound —
root typecheck passes across 12 workspaces, all 141 sdk changed-file tests pass, the
manifest/lodash restructuring reconciles 12/13 lockfile members, frozen-lockfile
install passes, every in-repo caller of the sync→async conversions was found and
updated, and the audit itself mutated nothing. **Must fix before commit (CI-red):**
(1) the new types-declaration guard (CRITICAL) — it exits 1 on the working tree (61
violations, including every self-typed package like `zod`/`ai`/`commander`) and fails
CI three ways plus the pre-push hook; (2) the 3 deterministic text-layout test
failures — one real production bug (NEL/`U+0085` misclassified as `\s` whitespace at
`text-layout.ts:182`) plus one mutually-unsatisfiable test and one stale-expectation
test; (3) the `run-terminal-command` quoted-path parser bypass (HIGH security) whose
new multi-byte test is green only via the author's `core.quotePath=false` gitconfig
and will fail on default-config CI runners. **Safe to commit once those are fixed:**
the rest of the changeset (cli input wiring, concurrency gate, harness-intelligence
async twins, file-change-hooks caching, provenance guard, run-cli-tests wrapper,
docs) has no CI-red item — nothing needs reverting. **Should fix but not blocking:**
the silent deletion of Go workspace inference, the originator-abort poisoning of the
shared tools cache (60s of fabricated "all tools unavailable"), the no-op provenance
"reviewed commit" CI step (false security anchor), the parallel hook-inference abort
poisoning, stale height estimates for `help`/`homeDir` modes, the stale `bun.lock`
scripts entry, the `.bun-version` 1.3.11 release-toolchain split, and the LOW
hygiene items. The 4th cli-suite failure (`yield-gate throughput … cold index
throughput` in opentui-syntax-style.test.ts) passes in isolation — **[late]** a
load-induced flake, not a regression, and not a commit blocker. The types-guard
"invocation-form differential" also did not reproduce — **[late]** the guard is
cwd-independent and the earlier smaller flagged set matched a mid-edit manifest
state, so the guard failure is deterministic guard-logic red, not an environmental
sensitivity.

## 2. Top 10 (highest-leverage fixes, ordered)

1. **CRITICAL** `scripts/types-declaration-guard.ts:368-388` (+ `.github/workflows/ci.yml:109-110`, smoke test `scripts/__tests__/types-declaration-guard.test.ts:439-450`) — guard ships red (61 violations, never green even at HEAD); fix the guard logic (node_modules self-type resolution or a populated `NO_TYPES_PACKAGE`) before commit.
2. **HIGH** `cli/src/utils/text-layout.ts:182` — NEL (U+0085) is not in ECMAScript `\s`; delete the `0x85` whitespace case (and fix the comments at :139-175) to kill the per-character fallback and make test 2 pass.
3. **HIGH** `cli/src/utils/__tests__/text-layout.test.ts:1350-1367` and `:604-648` — after fix #2, repair the mutually-unsatisfiable NEL test 3 and the stale span/char-budget expectations of test 1 (the other two red cli-suite tests).
4. **HIGH** `sdk/src/tools/run-terminal-command.ts:284-299` — sensitive-name check silently bypassed for git C-quoted staged paths under default `core.quotePath=true`; accept `"a/`-prefixed headers, unescape `\nnn` octal, and fail closed on unparseable `diff --git` headers.
5. **MEDIUM** `sdk/src/__tests__/run-terminal-command.test.ts:726-753` — the new multi-byte test passes only via the author's git config and is red on default-config CI runners; make it config-independent (fix #4 first, or set repo-local `core.quotePath` in `initTempGitRepo`).
6. **HIGH** `sdk/src/services/harness-intelligence.ts:335-383` — the `go.mod` branch of `inferWorkspace` was silently deleted; Go repos now report `unknown` ecosystem and `workspace.manager === 'go'` branches at :1769/:2071 are dead code — restore it.
7. **HIGH** `sdk/src/services/harness-intelligence.ts:714-748` — first caller's abort poisons the shared 14-probe tools cache, publishing "all tools unavailable" for 60s to every subsequent caller; don't thread the starter's signal into `refreshToolProbes` / skip the cache publish on abort-settle.
8. **HIGH** `.github/workflows/ci.yml:106-107` — the provenance "independent anchor" diffs the post-checkout working tree against HEAD and is always empty (no-op); diff against the base branch (`FETCH_HEAD...HEAD`) so a bundled record+code swap actually fails.
9. **MEDIUM** `sdk/src/tools/file-change-hooks.ts:328-340` — originator abort rejects the shared in-flight hook-inference snapshot and fails non-cancelled joiners; run the shared work un-signalled and let all callers `raceAbort` individually.
10. **MEDIUM** `cli/src/hooks/use-chat-input.ts:46-59` (+ `chat-input-bar.tsx:505-518`, `input-modes.ts`) — box height now trusts hand-maintained width estimates that are wrong for `help`/`homeDir` modes and two stale `widthAdjustment` entries, undersizing the box; gate the estimate on the real render condition and fix the table.

## 3. De-duplication applied

- **sdk public-API sync→async breaks**: shard-4 Finding 4 (`inspectHarnessEnvironment`), shard-5 Finding 4 (`inspectEnvironment` / `getAffectedTests` / `getBuildTargets`), and the picker-consumers sweep's "2 public-API breaks" are ONE issue — 4 root-level `@codebuff/sdk` exports flipped from sync to async. Merged under API/ABI, severity LOW (as assigned).
- **types-declaration failure**: shard-6's CRITICAL and the STATUS validation row (`scripts suite 341/342`, `guard:types-declaration FAIL`) are ONE issue. **[late]** The invocation-form differential between the two runs did not reproduce (both forms byte-identical; guard cwd-independent via `projectRoot()` at `types-declaration-guard.ts:215-217`); the earlier smaller set matched a mid-edit manifest state — folded into the single CRITICAL finding.
- **text-layout failing tests**: shard-1 Findings 1-3, shard-2's cross-shard note, and the STATUS cli-suite row are ONE cluster, reported once under shard-1's findings. The 4th cli failure is the opentui flake (**[late]** passes in isolation), not part of this cluster.
- **Wall-clock gate flakiness**: shard-1 Finding 5 (text-layout ratio gates) and the opentui `yield-gate` flake share one pattern — see Cross-cutting C.
- **Version-pin drift**: shard-7 Findings 2 and 5 plus shard-6's verified bun-toolchain alignment test — see Cross-cutting D.

## 4. Findings by domain

Severity order CRITICAL > HIGH > MEDIUM > LOW within each group. Severities are as
assigned by the shards.

### Correctness

- **CRITICAL** `scripts/types-declaration-guard.ts:368-388` (ci.yml:109-110; smoke test :439-450; `check-ci-local.ts:492-506`) — Risk: the manifest-only guard flags 61 deps (every self-typed package; `NO_TYPES_PACKAGE` has one entry, `bun`) and has never been green (HEAD: 63), so CI's guard step, the scripts smoke test, `check:ci-local` Step J, and the pre-push hook all fail on this commit. Fix: resolve installed `node_modules/<name>/package.json` `types`/`typings`/`exports` fields as self-type proof (CI runs `bun install` first) and require the `@types` sibling only as fallback — or fully populate `NO_TYPES_PACKAGE` and fix the one genuine defect (`common/package.json` orphaned `@types/parse-path`); the invocation-form differential is resolved as non-existent **[late]**.
- **HIGH** `cli/src/utils/text-layout.ts:182` — Risk: NEL (U+0085) is classified as whitespace but is not in ECMAScript `\s`, so NEL-leading segments fall into the per-character fallback (the allocation the rewrite exists to remove) and break the documented `split(/(\s+)/)` span parity. Fix: delete the `0x85` case and correct the comments at :139-175.
- **HIGH** `sdk/src/services/harness-intelligence.ts:335-383` — Risk: the deleted `go.mod` branch silently downgrades Go repos to `ecosystem: unknown`, drops Go build targets and test-impact commands, and strands `manager === 'go'` branches at :1769/:2071 as dead code (verified by runtime repro; no Go test fixture exists to catch it). Fix: restore the branch (with a fixture), or if intentional, remove `go.mod`/`go.sum` from discovery lists and the dead branches, and document it.
- **HIGH** `sdk/src/services/harness-intelligence.ts:714-748` — Risk: the group-starting caller's abort signal is baked into the shared 14-probe group, so its cancellation settles `{available: false}` for every tool and publishes that fabricated record into the 60s TTL cache for all later callers (runtime-reproduced); the docblock at :721-723 claims the opposite. Fix: don't thread the starter's signal into `refreshToolProbes` (bound by `toolVersionTimeoutMs` alone), or mirror the discovery cache's waiter-count controller, and skip/delete the cache publish when the group settled via abort.
- **MEDIUM** `cli/src/utils/text-layout.ts:287` — Risk: the ASCII fast-path predicate `length === segmentWidth` is also true for all-astral wide runs, hard-wrapping inside surrogate pairs and overcounting rows at cols ≤ 3; both test references mirror the bug. Fix: gate on `ASCII_PRINTABLE_REGEX.test(segment)` and add an astral corpus entry.
- **MEDIUM** `cli/src/hooks/use-chat-input.ts:46-59` (+ `chat-input-bar.tsx:505-518`) — Risk: box height trusts width estimates that ignore the AgentModeToggle for `help`/`homeDir` modes and carry two stale `widthAdjustment` entries (`openbuff:provider` 12 vs 14, `openbuff:models` 10 vs ~11), undersizing the box for those modes. Fix: gate `estimatedToggleWidth` on the render condition (`modeConfig.showAgentModeToggle && !isNarrowWidth && !isCompactHeight`), correct the two entries, and reconcile against `lineInfo` when it exceeds the forwarded count.
- **MEDIUM** `cli/src/components/multiline-input.tsx:1279-1288` (+ `text-layout.ts:782-785`) — Risk: the `measurementKey` staleness guard compares the consumer's key against itself — always true — so the documented "wrong content/columns not trusted" protection is unreachable and the `!` assertion trusts counts with no column identity. Fix: have `chat.tsx` forward the producer-side key (or measured columns) and compare producer vs consumer keys; refuse the count when `wrapWidth` is undefined.
- **MEDIUM** `sdk/src/services/harness-intelligence.ts:522` (+ :525, :563-567) — Risk: probe timeout drifted 3s→5s and output-cap semantics changed (truncate-at-64KB-and-report-available vs spawnSync unavailable), contradicting the "identical contract" docblock; test constant `TOOL_PROBE_TIMEOUT_MS = 3_000` is stale/unused. Fix: restore 3s or document 5s deliberately, correct the docblock and the test constant.
- **MEDIUM** `sdk/src/tools/file-change-hooks.ts:328-340` (+ :356-368) — Risk: the pending hook-inference snapshot is bound to the first caller's signal, so an originator abort rejects every non-cancelled joiner's `run_file_change_hooks` call (contradicts `concurrency.ts:26-31`); no test covers originator-abort-with-joiner. Fix: run the shared snapshot un-signalled and let all callers (originator included) observe cancellation via `raceAbort(sharedPending, ownSignal)`.
- **LOW** `cli/src/utils/text-layout.ts:300-308` — Risk: pre-existing — `measureLines` counts a phantom row for unsplittable wide chars at cols=1 (render side guards it at :443-450). Fix: only `emitHardWrap` when `acc > 0` (optional hardening).
- **LOW** `cli/src/components/multiline-input.tsx:334-340`, `:1267-1277`, `:626-629` — Risk: comments misstate mount topology (branches are mutually exclusive), the protection the key provides (see MEDIUM above), and the old scroll-effect deps. Fix: correct the three comments.
- **LOW** `sdk/src/tools/run-terminal-command.ts:695-699` — Risk: stderr decoded per-chunk without a `StringDecoder` can split multi-byte code points into U+FFFD (cosmetic, error text only). Fix: decode stderr through a second `StringDecoder`, flushed at settle.
- **LOW** `sdk/src/services/harness-intelligence.ts:103-130` vs `:175-218` — Risk: sync (DFS) and async (BFS) walks truncate different subsets above the 2000-dir cap, so sync/async twins can disagree on huge trees. Fix: document the divergence or align the trim strategy.
- **LOW** `sdk/src/tools/file-change-hooks.ts:806-808`, `:1093` — Risk: newly added `signal` parameter on the sync walk is never read — implies cancellability a `readdirSync` loop cannot deliver. Fix: drop the parameter from both sync functions.
- **LOW (pre-existing split, but this changeset is the pin authority)** `.bun-version:1` — see Dependency hygiene / Cross-cutting D: `1.3.11` while engines/`packageManager` and all 9 manifests pin 1.3.5.

### Security

- **HIGH** `sdk/src/tools/run-terminal-command.ts:284-299` — Risk: with default `core.quotePath=true`, C-quoted staged headers (`"a/r\303\251sum\303\251.pem"`) defeat `parseStagedDiffHeader`, the name never enters the sensitive-path table, and commits of e.g. `café/.env` are cleared uninspected (empirically verified; carried over from the `--name-only` code, but the new parser was written to handle quoting and doesn't). Fix: accept quoted `"a/` bodies (split on `lastIndexOf('" b/')`), unescape octal/`\\`/`\"` escapes before the `SENSITIVE_STAGED_PATH` test, and treat unparseable `diff --git` headers as inspection failures (fail closed).
- **HIGH** `.github/workflows/ci.yml:106-107` — Risk: the provenance anchor `git diff --exit-code HEAD -- scripts/dependency-provenance.json` runs on a depth-1 checkout where the tree equals HEAD and nothing regenerates the record, so it always passes — one commit can swap code plus its vouching record and stay green (the ci-workflow test enshrines the dead form). Fix: fetch the base ref and diff `FETCH_HEAD...HEAD` (or `origin/main...HEAD` with `fetch-depth: 0`), and update the pinned test string.
- **LOW** `docs/development.md` ("Dependency provenance" section) — Risk: the docs repeat the no-op anchor claim and misstate deprecation handling ("does not fail the gate" vs the real failing `unreviewed-deprecation` finding). Fix: correct both sentences alongside the CI step fix.

### State mutation

- **LOW** `cli/src/components/multiline-input.tsx:1380` — Risk: `stickyScroll` off applies to all ~12 mount sites (pickers/dialogs), so unfocused boxes no longer follow programmatic content growth — deliberate global behavior change, no dependent site found. Fix: none needed; remember this line if a dialog later reports "content doesn't auto-follow".
- **LOW** `sdk/src/tools/concurrency.ts:187-198` — Risk: `__resetFilesystemPhaseStatsForTest` wipes LIVE per-phase counts (contradicting its docblock), so a reset with probes in flight can let a phase exceed its `phaseLimit` in tests. Fix: reset only the high-water marks, leave `filesystemPhaseSlotsInUse` alone.

### Error handling

- **MEDIUM** `sdk/src/tools/run-terminal-command.ts:603-706` (+ :725-745, :1227) — Risk: the two preflight `git diff --cached` spawns have no timeout and never see the abort signal, so a stalled git hangs the tool call forever and an aborted request keeps preflighting. Fix: thread `signal` into `runGitForSafety` and add a wall deadline that resolves `{kind: 'inspectionFailed'}`.
- **MEDIUM** `scripts/types-declaration-guard.ts:224-230` (+ :250-273, :280-300; same shape in `dependency-provenance-guard.ts:332-338`, `:407-411`) — Risk: unparseable member manifests are silently skipped, so a syntactically broken manifest makes its pins/deps vanish from scope and the run is vacuously green (demonstrated: fixture corruption → `violations: 0`). Fix: distinguish "missing" (skip) from "present but unparseable" (finding/non-zero exit) in both guards.
- **LOW** `sdk/src/tools/file-change-hooks.ts:1041-1044` (+ :850-853, cached at :374-379) — Risk: the dotnet-walk `.catch(() => undefined)` also swallows late aborts, publishing a snapshot missing dotnet hooks into the 5s TTL cache. Fix: rethrow when `signal?.aborted` (or check before `storeHookInferenceEntry`).

### Performance

- **LOW** `sdk/src/tools/run-terminal-command.ts:513-536` (+ :576-580) — Risk: `drainAll` can decode+regex up to the 2MB budget in one tick at settle if git outpaces the drain loop — event-loop latency only (memory stays bounded). Fix: loop `scanAvailable(GIT_SAFETY_SCAN_SLICE_CHARS)` with `setImmediate` yields.
- **LOW** `cli/src/utils/__tests__/text-layout.test.ts:671`, `:691` — see Test coverage (wall-clock gate headroom).

### Dependency hygiene (manifests / lockfile / docs accuracy)

- **MEDIUM** `bun.lock:185-190` — Risk: the `scripts` workspace entry still lists `@ai-sdk/openai-compatible` under `dependencies` while the manifest moved it to `devDependencies` — frozen install passes today, but the next unfrozen `bun install` produces a spurious lockfile diff (and a future bun tightening would fail CI). Fix: re-run `bun install` (bun 1.3.5) and commit the rewritten scripts block.
- **MEDIUM** `.bun-version:1` — Risk: release workflows (cli-release-build/prod/staging, sdk-release, nightly-e2e via `setup-project`'s `bun-version-file`) build on bun 1.3.11 while CI/tests/engines pin 1.3.5 — binaries compiled with an untested toolchain. Fix: set `.bun-version` to `1.3.5` (or make the release-path pin explicit and justified).
- **LOW** `sdk/package.json` (`//devDependencies`) — Risk: the comment claims `dist/index.d.ts` references lodash types externally, but dts-bundle-generator inlines them (verified against the built d.ts). Fix: reword to the isolated-install rationale or re-verify after a rebuild.
- **LOW** `scripts/package.json` (`//devDependencies`) — Risk: the comment cites `calibrate-openai-tokens.ts` as the importer of `@ai-sdk/openai-compatible`; the sole importer is `fat-sdk-openrouter-example.ts:6`. Fix: cite the right file.
- **LOW** `docs/testing.md:44` — Risk: the documented find pipeline dropped `2>/dev/null` while keeping the "matches ci.yml exactly" claim. Fix: restore the flag or soften to "collects the same file set".
- **LOW** `knowledge.md:7` — Risk: tracked note still says bun is pinned to 1.3.11. Fix: update to 1.3.5.

### Test coverage

- **HIGH** `cli/src/utils/__tests__/text-layout.test.ts:1350-1367` — Risk: test 3 asserts NEL is a `\s` whitespace run (factually wrong in ECMAScript) and is mutually unsatisfiable with test 2's `/\s/` oracle — the suite stays red whichever production fix is chosen, inviting a bad "fix". Fix: pin the correct property (NEL stays in the word run, 1 span) or re-target at U+2028; also de-dup the overlapping corpus ranges at :1277-1279.
- **HIGH** `cli/src/utils/__tests__/text-layout.test.ts:604-648` — Risk: test 1's expected-span formula and char budget count newline characters the scan never slices (production matches the split reference exactly, 723 = 723); fixing only the first assertion leaves :644 red. Fix: derive the oracle from `split(/(\s+)/)` (non-empty `\n`-parts) and subtract newline count from the char budget; also correct the overclaiming doc at `text-layout.ts:139-152`.
- **MEDIUM** `sdk/src/__tests__/run-terminal-command.test.ts:726-753` — Risk: the multi-byte test inherits the author-machine global gitconfig and is red under default `core.quotePath` (verified: `blocked: false, committed: 0` with pristine config). Fix: fix the parser (Security HIGH above) and pin the quoted-path case; isolate config via repo-local `git config` in `initTempGitRepo` (`getChildProcessEnv()` doesn't forward `GIT_CONFIG_*`).
- **LOW** `cli/src/utils/__tests__/text-layout.test.ts:671`, `:691` — Risk: wall-clock ratio gates have ~18% headroom on loaded machines (observed ratios up to 3.38 vs the 4x tripwire) — flaky, not wrong; the same class as the opentui yield-gate flake **[late]**. Fix: raise the single-reference tripwire to 5-6x or mark the ratio block retry-tolerant if CI proves noisy.
- **LOW** `cli/src/components/__tests__/multiline-input-height.test.ts:688-890` — Risk: the wiring tests are source-text assertions (fs.readFileSync + string match); they fail on textual regression, not behavioral (runner cannot render OpenTUI). Fix: none practical now; convert to render-based assertions if the harness gains an OpenTUI context.
- **LOW** `cli/src/hooks/__tests__/use-chat-input.test.ts:151-165` — Risk: no case pins `Math.max(1, ...)` flooring when `separatorWidth` is tiny and `modeWidthAdjustment` large. Fix: optional one-line case (separator 4, adjustment 4 → inputWidth 1).
- **LOW** `sdk/src/__tests__/run-terminal-command.test.ts` (gaps; vacuous assertion at :710) — Risk: byte-budget kill, long-line window/overlap (the 256-overlap ≥ longest-pattern invariant), ring eviction, and concurrent `validateStagedCommit` are untested (all probe-verified working); `expect(exitCode).not.toBe(0)` is vacuous on structured inspection-failure results. Fix: add the four cases and drop/replace the vacuous assertion.
- **LOW** `sdk/src/__tests__/harness-intelligence.test.ts` (gaps consolidated from shard-4) — Risk: no mid-flight-abort test of a probe group or discovery walk (exactly Finding 2's hole), nothing pins the timeout value or TTL anchoring, and no Go fixture exists anywhere (what let the Go deletion through). Fix: add mid-flight-abort, timeout-kill, TTL-anchor, and Go-fixture tests.
- **LOW** `sdk/src/__tests__/file-change-hooks.test.ts`, `sdk/src/__tests__/concurrency.test.ts` — Risk: the two exact race windows that misbehave (originator-abort-with-joiner; abort after probes settled during walk) are the two interleavings not covered. Fix: add both tests next to the existing dedup/abort cases.
- **LOW** `scripts/__tests__/check-ci-local.test.ts:536-537` (+ :514) — Risk: comments misstate which steps ran in the failing-case tests (assertions are correct). Fix: correct to "Steps A-H ran; Steps I-J and the full suites (Step K) were skipped."

### API/ABI

- **LOW** `sdk/src/index.ts:380` + `:314-316` (de-duplicated: shard-4 F4 + shard-5 F4 + picker-consumers) — Risk: four public `@codebuff/sdk` 0.11.0 exports (`inspectHarnessEnvironment`, `inspectEnvironment`, `getAffectedTests`, `getBuildTargets`) flipped sync→async; every in-repo caller was verified updated, but external consumers using the result synchronously now get a Promise. Fix: intentional per the design — record it in the CHANGELOG as a breaking pre-1.0 change (optionally keep sync-named aliases).
- **LOW** `sdk/src/tools/run-terminal-command.ts:1243-1261` vs `common/src/tools/params/tool/run-terminal-command.ts:56-84` — Risk: `safetyPreflightFailed` (plus pre-existing harness/approval fields) is absent from `terminalCommandOutputSchema`, so consumers parsing through `outputSchema` strip the diff's core new distinction. Fix: declare the fields in the schema's `errorMessage` branch.
- **LOW** `.github/workflows/ci.yml:110` vs `:89-98` — Risk: the types guard uses the direct-path invocation form while every other guard uses `bun --cwd=scripts run guard:<name>` (functionally identical, verified byte-identical; an unnecessary second pinned string). Fix: use the uniform `guard:types-declaration` form.

## 5. Cross-cutting findings (spanning multiple shards)

**A. Sync→async public API pattern.** One deliberate design decision, applied in two
files and independently re-found by the picker-consumers sweep: 4 root SDK exports
flipped to async. All in-repo call sites (run.ts dispatch, tool wrappers, tests) were
grepped and verified awaited with correct arg order — the change is internally
coherent; the residual risk is external consumers only. Action: one CHANGELOG entry,
not four fixes.

**B. Originator-signal poisoning of shared in-flight caches.** Two independent
implementations of "dedupe concurrent callers onto one pending promise" bind the
shared work to the FIRST caller's abort signal (harness-intelligence tools cache
— HIGH, 60s poisoned TTL; file-change-hooks snapshot — MEDIUM, joiners failed), and
both contradict their own docblocks. The repo already contains the correct pattern:
the discovery cache's waiter-count + per-traversal controller
(`registerDiscoveryWaiter`). Fix both by mirroring that design; add the missing
mid-flight-abort regression tests.

**C. "Green locally, red (or flaky) in CI" — local environment masking.** Three
instances where the developer's machine hides what CI will see: (1) the quotePath
test (author's `~/.gitconfig` has `core.quotePath=false`; CI runners default to
true → sdk suite red in CI while green locally); (2) wall-clock gates under load —
text-layout ratio gates have ~18% headroom, and **[late]** the 4th cli-suite failure
(`yield-gate throughput … cold index throughput`, opentui-syntax-style.test.ts)
passes in isolation: a load-induced flake, not a regression; (3) the types-guard
invocation-form differential — **[late]** resolved as a non-issue: it did not
reproduce, the guard is cwd-independent, and the earlier smaller flagged set matched
a mid-edit manifest state. The guard's failure itself is deterministic (red locally
and in CI) and is the CRITICAL. Pattern action: prefer config isolation in test
setup (repo-local git config) and retry-tolerant or work-volume-based gates over
wall-clock tripwires.

**D. Version-pin drift.** The changeset made `package.json` the pin authority
(1.3.5 everywhere, verified by the new ci-workflow alignment test) but left two
artifacts behind: `.bun-version` at 1.3.11 (consumed by all five release workflows —
release binaries built on an untested bun) and `knowledge.md:7` documenting 1.3.11.
Plus the stale `bun.lock` scripts entry. One alignment pass (`.bun-version`,
`knowledge.md`, one `bun install`) closes the theme.

**E. Comments/docblocks overclaiming the new invariants.** Across five shards, the
changeset repeatedly ships prose asserting protections the code does not deliver:
the NEL "exactly the `\s` set" and "characters copied equal length" claims
(text-layout), the mount-topology and staleness-key comments (multiline-input), the
"identical contract" and "never cancellable on one caller's behalf" docblocks
(harness-intelligence), the manifest `//devDependencies` comments (sdk, scripts),
and docs/development.md's provenance claims. Each is LOW alone; together they will
misdirect the next editor on exactly the invariants this changeset adds. One
documentation-truth pass bundled with the corresponding code fixes.

**F. What exactly makes CI red on this commit.** (1) types-declaration guard step +
its smoke test + `check:ci-local` Step J (+ pre-push hook locally); (2) the 3
deterministic text-layout test failures in the cli suite; (3) the sdk multi-byte
test on default-config CI runners. NOT red: the opentui yield-gate flake **[late]**
and the stale `bun.lock` entry (frozen install passes today). Items 1-3 are the
complete pre-commit fix list; everything else is post-commit-able.

## 6. Coverage

Per the `STATUS.md` coverage matrix, every subsystem touched by the uncommitted
changes was audited, with no gaps:

| Domain | Shard IDs | Covered |
|--------|-----------|---------|
| cli text-layout rewrite | shard-1, picker-consumers (area 1) | yes |
| cli input components/chat wiring | shard-2, picker-consumers (area 5) | yes |
| sdk run-terminal-command | shard-3, picker-consumers (area 3) | yes |
| sdk harness-intelligence | shard-4, picker-consumers (area 4) | yes |
| sdk file-change-hooks/concurrency/small tools/run.ts dispatch | shard-5, picker-consumers (areas 2-3) | yes |
| scripts guards + CI workflow + cli test runner | shard-6 | yes |
| manifests + bun.lock + docs + version pins | shard-7, picker-consistency | yes |
| public SDK API surface (index.ts re-exports) | picker-consumers | yes |
| repo-wide consistency (version pins, leftovers, naming, hygiene) | picker-consistency | yes |

Subsystem disposition: `cli/`, `sdk/`, `scripts/`, `docs/`, `.github/`, root files,
`common/`+`packages/` manifests — audited. Out of scope (no uncommitted changes):
`evals/` code, `agents/`, `agents-graveyard/`, `debug/`, `e2e-traces/`,
`node_modules/`, `openbuff.d.example/`, `rust/`, `scratch-logs/`, `test/`, `web/`.
The picker-consistency sweep additionally contributed 2 hygiene issues (folded into
the Dependency hygiene group above, deduplicated against shard-7 where overlapping).

Executed validation (from STATUS.md, with **[late]** clarifications folded in):

| Check | Result |
|---|---|
| Root typecheck (12 workspaces) | PASS |
| sdk changed-file tests (5 files) | 141/141 PASS |
| cli full suite (`bun run test`, new wrapper) | 3977 pass / 4 fail — 3 text-layout (real, diagnosed in shard-1), 1 yield-gate wall-clock gate in opentui-syntax-style.test.ts (**[late]** passes in isolation → load flake, not a regression) |
| scripts suite | 341/342 — 1 fail: types-declaration smoke "this repository satisfies the invariant today" |
| guard:dependency-provenance | PASS (107 releases reconcile, ~50ms, offline) |
| guard:types-declaration | **FAIL (exit 1)** — 61 flagged deps incl. self-typed packages; guard has never been green (HEAD yields 63 violations); invocation-form differential did not reproduce **[late]** (guard cwd-independent; earlier smaller set matched a mid-edit manifest state) |
| bun install --frozen-lockfile --dry-run | PASS |
| Worktree mutation by audit | none (status identical before/after) |

Pre-synthesis severity rollup (STATUS.md): 1 CRITICAL, 7 HIGH, 9 MEDIUM, 24 LOW
across the 7 shard findings files, plus 2 public-API breaks and 2 hygiene issues
from the picker sweeps — after de-duplication (§3), the public-API breaks merge
into one LOW finding and the hygiene issues into the Dependency hygiene group.
