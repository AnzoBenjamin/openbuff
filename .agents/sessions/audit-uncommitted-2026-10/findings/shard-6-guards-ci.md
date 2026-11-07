# Shard 6 — CI guards, provenance record, CLI test wrapper

- Shard: `shard-6-guards-ci`
- Repo: `/home/ben/Code/CLI/openbuff`, branch `feat/polyglot-reaudit-roadmap`, uncommitted changes
- Files audited:
  - `scripts/dependency-provenance-guard.ts` (NEW)
  - `scripts/dependency-provenance.json` (NEW data file)
  - `scripts/types-declaration-guard.ts` (NEW)
  - `scripts/__tests__/dependency-provenance-guard.test.ts` (NEW)
  - `scripts/__tests__/types-declaration-guard.test.ts` (NEW)
  - `scripts/check-ci-local.ts` (modified, +50)
  - `scripts/__tests__/check-ci-local.test.ts` (modified, +50)
  - `scripts/__tests__/ci-workflow.test.ts` (modified, +61)
  - `.github/workflows/ci.yml` (modified, +16)
  - `cli/scripts/run-cli-tests.ts` (NEW)
  - `cli/src/__tests__/run-cli-tests.test.ts` (NEW)
  - Context files consulted: `package.json`, `cli/package.json`, `sdk/package.json`, `common/package.json`, `scripts/package.json`, `bun.lock`, `docs/development.md`, `docs/testing.md`, `scripts/install-pre-push-hook.ts`

Everything below was verified by execution on the current working tree, not by reading alone.

---

## CRITICAL — types-declaration guard ships red: CI is guaranteed to fail on this very commit

- Domain: Correctness (blast radius into Test coverage and the pre-push hook)
- Files: `scripts/types-declaration-guard.ts:368-388` (`collectUndeclaredTypes`), `:64-66` (`NO_TYPES_PACKAGE`), `.github/workflows/ci.yml:109-110`, `scripts/check-ci-local.ts:492-506` (Step J), `scripts/__tests__/types-declaration-guard.test.ts:439-450` (smoke test)
- Evidence (all executed):
  - `bun --cwd=scripts run guard:types-declaration` → exit 1, 61 forward violations + 1 reverse (orphaned) violation across every workspace member (cli 18, common 8, evals 5, root 3, agent-runtime 4, code-map 3, indexer 3, internal 3, sdk 11, plus `common/package.json: @types/parse-path` orphan).
  - `bun run scripts/types-declaration-guard.ts` (the ci.yml:110 form) → exit 1, byte-identical output (diffed programmatically: 61 identical lines).
  - `bun test scripts/__tests__/types-declaration-guard.test.ts` → `1 tests failed`: `checkTypesDeclarations > this repository satisfies the invariant today`.
  - The same guard against HEAD's committed manifests (clean copies) → 63 violations + 1 orphan. The change-set's manifest edits (`@types/lodash` added to common and sdk, `lodash` moved root devDeps→deps, `@types/ws` moved sdk deps→devDeps, `@ai-sdk/openai-compatible` moved scripts deps→devDeps) reduced the count from 63 to 61 — the guard has never been green at any point of this change-set's history.

- Root cause (mechanism): the guard is a pure manifest-driven invariant. For EVERY entry of EVERY member's `dependencies` it requires `@types/<name>` in that SAME manifest (`collectUndeclaredTypes`), with only four escape hatches: internal `@codebuff//`/`@openbuff/` prefixes, names already starting `@types/`, `node:`/Node builtins, and the `NO_TYPES_PACKAGE` map — which ships containing exactly ONE entry (`bun`). It never consults `node_modules` (installed package.json `types`/`typings`/`exports` fields) or the registry; the docblock (`scripts/types-declaration-guard.ts:15-34`) explicitly refuses to guess whether a package bundles its own `.d.ts`. Consequently self-typed packages — `zod`, `ai`, `commander`, `immer`, `zustand`, `ts-pattern`, `picocolors`, `yoga-layout`, `@opentui/*`, `web-tree-sitter`, `@modelcontextprotocol/sdk`, …, i.e. the overwhelming majority of the 61 — are flagged even though no `@types/zod`/`@types/ai` exists on npm. `zod` alone is flagged in 4 manifests.

- (a) Why self-typed packages are flagged: by design — the guard asserts a manifest-level co-declaration, not "types resolve"; a package that ships its own `.d.ts` still needs a one-line `NO_TYPES_PACKAGE` exemption, and only `bun` has one.
- (b) The reported invocation-form differential does NOT reproduce: both forms emit byte-identical findings. The guard is cwd-independent by construction (`projectRoot()` derives from `import.meta.url` at `scripts/types-declaration-guard.ts:215-217`; nothing reads `process.cwd()` or `node_modules`). The earlier smaller set (sdk 6 deps + common `@types/parse-path`, plus one extra `@vscode/tree-sitter-wasm`) matches neither HEAD (63) nor the working tree (61) and is best explained by the manifests being mid-edit when the two runs were captured — not by any cwd- or install-dependent resolution in the shipped code.
- (c) The fix is guard logic, not manifest changes: adding `@types/zod`/`@types/ai`/etc. is impossible (those packages don't exist on npm; `bun install` would fail). Either teach the guard to resolve the installed `node_modules/<name>/package.json` `types`/`typings`/`exports.types` field (present in-repo after `bun install`, which CI runs before the guard; the docblock's claim that this is "not possible from files in this repository" is wrong for a post-install check) and require the `@types` sibling only as fallback — or populate `NO_TYPES_PACKAGE` with ~60 entries, which turns it into the per-package allowlist the docblock explicitly disclaims and guarantees rot. One flagged item IS a genuine manifest defect fixable by hand: `common/package.json` declares `@types/parse-path` in devDependencies but `parse-path` in neither block (pre-existing at HEAD; the reverse check correctly surfaces it). Either drop the typings from common or declare `parse-path`.
- (d) CI impact: YES, red on this commit, three ways: (1) ci.yml `build-and-check` step "Types declaration guard (runtime deps declare their typings)" (line 109-110) exits 1; (2) the `test-scripts` matrix job runs the guard's own smoke test, which fails; (3) `check:ci-local` Step J fails, and the pre-push hook (`scripts/install-pre-push-hook.ts:39` → `bun run check:ci-local`) blocks local pushes of this commit.
- Suggested fix: implement node_modules-based self-type detection before wiring the step into CI (or land the guard with `NO_TYPES_PACKAGE` fully populated and the common `@types/parse-path` orphan fixed), and make the smoke test's premise true. As shipped, this commit cannot pass its own CI.

## HIGH — ci.yml provenance "reviewed commit" step is a no-op (false security)

- Domain: Correctness / Security
- File: `.github/workflows/ci.yml:106-107`; echoed in `scripts/__tests__/ci-workflow.test.ts:161-171` and `docs/development.md` ("Dependency provenance" section)
- Step: `git diff --exit-code HEAD -- scripts/dependency-provenance.json`, commented as "the independent anchor: a diff to the recorded upstream identity of an already-approved release fails the build instead of merging silently, so such a change must arrive in a separate, reviewed commit."
- Analysis: the job checks out with `actions/checkout@v5.0.0` and NO `with:` block (ci.yml:23-24) — default depth-1, no base-ref fetch, and no other checkout exists in the job. After checkout the working tree == HEAD. Between checkout and this step, the only commands that run are `bun install --frozen-lockfile`, env-var setup, `generate-tool-definitions` (writes other files), and the offline guards (read-only; only `--refresh` writes, and CI does not pass it). Nothing regenerates `scripts/dependency-provenance.json`, so the diff against HEAD is always empty and the step always passes. Contrast the tool-defs step at ci.yml:81-84, which is meaningful precisely because `generate-tool-definitions` regenerates the files being diffed in the same step.
- Concrete risk: a PR that bundles malicious code and a matching "provenance" record change in one commit passes this step — the exact scenario the step, its ci-workflow test comment, and docs/development.md all claim it prevents. The ci-workflow test only asserts the string is present, enshrining a dead check. This also collapses the guard's threat model: the guard's own docblock (dependency-provenance-guard.ts:13-23) is honest that the offline check only proves record↔lockfile agreement and names "the REVIEWED DIFF of the record file" as the upstream anchor — with this step being a no-op, the shipped system has NO independent anchor at all: the record is checked in with the code it vouches for, so one commit can swap both and stay green everywhere.
- Suggested fix: compare against the base branch, not the working tree, e.g. `git fetch --depth=1 origin main` then `git diff --exit-code FETCH_HEAD...HEAD -- scripts/dependency-provenance.json` (or `origin/main...HEAD` with `fetch-depth: 0`), and update the ci-workflow test to assert the meaningful form. Note `check-ci-local.ts` has no equivalent step at all (its Step B diff works only because Step A regenerates the tool-def files first).

## MEDIUM — types-declaration guard fail-open on malformed manifests

- Domain: Error handling
- Files: `scripts/types-declaration-guard.ts:224-230` (`readJson` returns undefined on parse failure), `:280-300` (`readWorkspaceManifests` silently skips unparseable manifests), `:250-273` (`expandWorkspaceDirectories` falls back to `['.']` when the root manifest is unparseable)
- Demonstrated concretely: an experiment accidentally copied directory-listing noise into every fixture `package.json`; the guard reported `violations: 0` — a syntactically broken member manifest removes all its dependencies from scope and the run is vacuously green. The provenance guard has the same shape (`readJson` → `if (!manifest) continue`, dependency-provenance-guard.ts:332-338, 407-411): a malformed manifest's pins silently vanish from the reconciled scope.
- Mitigation: a manifest broken enough to matter also fails `bun install`, typecheck, and the tool-def steps first, so this is not reachable as a quiet green in realistic CI. Downgraded from HIGH for that reason.
- Suggested fix: distinguish "missing" (skip) from "present but unparseable" (finding / non-zero exit) in both guards — `parseJsonObject` already exists in the provenance guard for exactly this and is unused on this path.

## LOW — stale/incorrect comments in check-ci-local.test.ts failing-case tests

- Domain: Test coverage gaps
- File: `scripts/__tests__/check-ci-local.test.ts:536-537` — the `guard:byok-wording` failure test (8th call fails, `expect(calls).toHaveLength(8)`, i.e. Steps A-H ran) is commented "Steps A-J ran; the types-declaration guard (Step J) passed and the full suites (Step K) were skipped" — wrong on both counts (Steps I and J never ran). Similarly line 514 says "Steps A-H ran" for the 7-call (A-G) project-root case. Comment-only; assertions themselves are correct and the suite passes.
- Suggested fix: correct the comments to "Steps A-H ran; Steps I-J and the full suites (Step K) were skipped."

## LOW — docs/development.md provenance section overstates the gate twice

- Domain: Security (threat-model honesty)
- File: `docs/development.md` (new "Dependency provenance" section)
- Two inaccuracies: (1) it repeats the no-op CI anchor claim ("CI runs `git diff --exit-code HEAD …` so a record whose integrity changed … fails the build instead of merging silently" — see HIGH finding); (2) "Upstream deprecation is reported but does not fail the gate" contradicts the implementation — an in-scope deprecated release without a `DEPRECATION_EXCEPTIONS` entry is a failing `unreviewed-deprecation` finding (dependency-provenance-guard.ts:693-706). The guard source and tests are honest; the docs undersell/oversell in opposite directions.
- Suggested fix: correct both sentences when fixing the CI step.

## LOW — ci.yml invocation-form inconsistency for the types guard

- Domain: API/ABI contract breaks (non-breaking, consistency)
- File: `.github/workflows/ci.yml:110` vs `:89-98`
- Every other guard runs as `bun --cwd=scripts run guard:<name>`; the types guard step uses the direct-path form `bun run scripts/types-declaration-guard.ts`. Verified functionally identical (byte-identical output from both forms), but it is a second string form that ci-workflow.test.ts pins separately and an unnecessary variant.
- Suggested fix: use `bun --cwd=scripts run guard:types-declaration` for uniformity.

## Verified non-findings (checks that passed)

- **lodash@4.17.23 integrity**: `scripts/dependency-provenance.json` line 378 `sha512-LgVTMpQtIopCi79SJeDiP0TfWi5CNEc/L/aRdTh3yIvmZXTnheWpKjSZhnvMl8iXbC1tFg9gdHHDMLoV7CnG+w==` is an exact string match for bun.lock line 1208's tuple. Verified.
- **Provenance guard health**: offline gate passes on the working tree ("107 dependency releases reconcile"), exits 0, ~50 ms runtime; types guard ~30 ms. Negligible CI cost (Domain 5).
- **Fail-closed paths** (Domain 4) verified by code read + tests: missing record → `missing-provenance` finding; missing/malformed bun.lock → `missing-lock-entry` per pin (regex no-match degrades to empty map, safe direction); integrity/tarball mismatch, missing/UNKNOWN/copyleft license, unreviewed deprecation, mirror-sourced record (`source-mismatch`), and stale record entries all fail; `--refresh` is all-or-nothing, refuses non-npmjs registry before the first fetch, and its fail paths are tested.
- **State mutation** (Domain 3): `writeProvenanceRecord` (dependency-provenance-guard.ts:1267-1286) genuinely does temp-sibling + `renameSync` with best-effort unlink on error — atomic on POSIX, same directory. No other writes outside `--refresh`.
- **Dependency hygiene** (Domain 6): both guards import only `node:fs`, `node:path`, `node:url`; network (`fetch`) is touched only in the `--refresh` path. Matches the `//devDependencies` note added to `scripts/package.json`.
- **run-cli-tests.ts semantics** (Domain 8): wrapper preserves `NODE_ENV=production` (line 143); discovery mirrors CI's find (prune `node_modules`/`.git`/`dist`, exclude `*.integration.test.ts`, include `*.test.ts`+`*.test.tsx`, sorted); fails closed on empty discovery and spawn error; propagates the child exit code; extra flags forwarded after the file list. Intentional, documented semantic change vs the old `NODE_ENV=production bun test`: `bun run test` in cli no longer runs tmux integration suites (CI-parity; they remain in the separate test-integration job). Benign divergence: prunes any *nested* directory named `node_modules`/`.git`/`dist`, where CI's find prunes only the top-level ones — strictly safer. All 11 of its tests pass.
- **ci-workflow.test.ts assertions vs ci.yml** (Domain 8): all three new assertion strings match actual ci.yml lines 98, 107, 110 exactly; the new bun-toolchain alignment test matches the manifests' `engines.bun`/`packageManager` 1.3.5 (including the 1.3.11→1.3.5 downgrades in this diff). Suite passes (65 tests across 2 files).
- **Script-name wiring** (Domain 8): `guard:dependency-provenance` and `guard:types-declaration` added to `scripts/package.json` and invoked by exactly those names from check-ci-local Steps I/J and ci.yml; step renumbering A→K consistent across source, success message, and tests.
- **Test coverage of fail paths** (Domain 7): the provenance guard suite is genuinely thorough (59/59 pass; missing entry, integrity/tarball mismatch, every license failure mode, stale record, source mismatch, unreviewed deprecation, missing record file, missing lock resolution, duplicate resolutions, unresolved pins). The types guard suite covers the pure functions' fail paths well (39/40); its one failure is the repo smoke test covered by the CRITICAL finding; no test covers the malformed-manifest skip (MEDIUM finding above).

## Coverage receipt

| File | Status | Note |
| --- | --- | --- |
| `scripts/dependency-provenance-guard.ts` | AUDITED (full read + execution) | Offline gate sound, fail-closed, node:-only imports, atomic record write; honest docblock; refresh path well-guarded (mirror refusal, all-or-nothing). |
| `scripts/dependency-provenance.json` | AUDITED (full read + cross-checks) | 107 entries; lodash@4.17.23 integrity matches bun.lock exactly; deprecated entries all covered by DEPRECATION_EXCEPTIONS; licenses allowlisted/normalized/exempted. |
| `scripts/types-declaration-guard.ts` | AUDITED (full read + execution) | CRITICAL: manifest-only design flags 61 deps incl. all self-typed packages; `NO_TYPES_PACKAGE` has one entry; never green at HEAD or working tree; cwd-independent. |
| `scripts/__tests__/dependency-provenance-guard.test.ts` | AUDITED (full read + run) | 59/59 pass; strong fail-path coverage incl. repo-level offline smoke tests that pass. |
| `scripts/__tests__/types-declaration-guard.test.ts` | AUDITED (full read + run) | 39/40 pass; repo smoke test fails (the CRITICAL); pure-function coverage good. |
| `scripts/check-ci-local.ts` | AUDITED (diff + full read) | Steps I/J wired correctly with short-circuit on non-zero; numbering A-K consistent; no provenance-diff equivalent of the ci.yml step. |
| `scripts/__tests__/check-ci-local.test.ts` | AUDITED (diff + run) | 65/65 pass across 2 files; two stale comments flagged (LOW). |
| `scripts/__tests__/ci-workflow.test.ts` | AUDITED (diff + run + cross-check) | All new assertion strings match actual ci.yml content; the provenance-diff assertion enshrines the no-op step (see HIGH). |
| `.github/workflows/ci.yml` | AUDITED (diff + full read) | Provenance guard step fine; provenance git-diff step is a no-op (HIGH); types guard step makes CI red (CRITICAL); checkout v5 default, no base-ref fetch. |
| `cli/scripts/run-cli-tests.ts` | AUDITED (full read + run of its tests) | NODE_ENV preserved, CI-parity discovery, fail-closed on empty discovery/spawn error; integration-suite exclusion is an intentional documented change. |
| `cli/src/__tests__/run-cli-tests.test.ts` | AUDITED (full read + run) | 11/11 pass; covers naming, pruning, exclusion, empty-tree guard, argv contract. |

Severity totals: 1 CRITICAL, 1 HIGH, 1 MEDIUM, 3 LOW.
