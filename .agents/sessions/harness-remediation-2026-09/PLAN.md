# Harness Remediation Plan (from harness-audit-2026-09)

Source: full-repo harness audit, 13 shard artifacts under `.agents/sessions/harness-audit-2026-09/findings/`.
Four user directives shape this plan:
- (D1) Do NOT add aggressive step-loop guards; agents must be free to loop/think long on genuinely complex tasks.
- (D2) Terminal `full-access` override exists because restrictive profiles neutered agents (can't write to temp, can't run complex CLI commands). Fix capability first; profile enforcement only proceeds once profiles are genuinely usable.
- (D3) Fix `containsStructuralAuditReceipt is not defined`.
- (D4) researcher-web/researcher-docs are over-restricted; make them capable of real complex research. P2.1 details researcher-web; researcher-docs receives the same model-loop treatment (same fixed-budget scripting pattern, adapted to docs retrieval).
- (D5) Fix the librarian: spawned runs produce no output.

## P0 — Correctness bugs (do first; small, independent)

**P0.1 Fix `containsStructuralAuditReceipt is not defined` (D3)**
- Files: `agents/general-agent/general-agent.ts`, `packages/agent-runtime/src/run-programmatic-step.ts`
- Root cause: `handleSteps` runs in a `new Function` sandbox; the module-level `import { containsStructuralAuditReceipt } from '@codebuff/common/util/audit-receipt'` is not visible inside the serialized body. The crash fires on the audit-completion path (line ~381) AFTER the agent has already done its work and persisted `write_audit_findings` — so the parent receives `Error executing handleSteps` instead of the compact receipt, and the spawn receipt carries the error even though findings landed.
- Fix options (pick one, prefer A):
  - A) Inline a minimal structural-receipt detector inside `handleSteps` (pattern already used by `researcher-web` and `context-pruner`: "keep helpers inside handleSteps because built-in agents serialize this function"). The check is a bounded-depth object walk for `{structuralReceipt: {...snapshot_id matches}}`; ≤30 lines, no import.
  - B) Runtime-inject the helper into the `new Function` scope (extend the sandbox bindings in `run-programmatic-step.ts`) — more general but touches the serialization layer.
- Acceptance: a general-agent spawned with sessionSlug/shardId/snapshotId that calls `write_audit_findings` completes with NO `Error executing handleSteps`; add a unit test simulating the serialized-handlesSteps environment.

**P0.2 Silent-catch hygiene bundle**
- `sdk/src/impl/chatgpt-backend-fetch.ts:527` — pipeTo rejection silently truncates streams → call `controller.error(...)` so retry/failover machinery classifies it.
- `packages/agent-runtime/src/run-agent-step.ts:2805` — wrap `finishAgentRun` awaits in catch/finally paths in try/catch so the original error always surfaces.
- `sdk/src/run.ts:727` — replace `require('child_process')` with a static ESM import.
- `agents/basher.ts:263` — non-JSON tool result currently becomes `{message: ''}`; pass through the string.

**P0.3 git-committer quoting (HIGH)**
- `agents/git-committer/git-committer.ts:171` — replace `JSON.stringify(path)` with POSIX single-quote escaping (the `'\\''` form already used in `basher.ts`/`librarian.ts`; note librarian's current pattern is subtly wrong for values containing backslashes — use the canonical `'` → `'\''` replacement). Also validate branch name at :250-270 against a git-ref-safe charset before interpolation into push/rev-list commands.
- `agents/__tests__/git-committer.test.ts:230` — replace the test that pins the unsafe shape with a hostile-path table (spaces, quotes, `$(...)`, backticks, leading dashes, unicode) asserting inertness under `sh -c`.

**P0.4 Librarian: no-output on completion (D5)**
- Files: `agents/librarian/librarian.ts`
- Root cause (verified against source): `handleSteps` clones, injects instructions via `add_message`, then ends with a bare `yield 'STEP_ALL'`. There is NO post-step harvest: if the model finishes by answering in text without calling `set_output`, or calls `set_output` that fails the strict `outputSchema` (five REQUIRED fields — status/answer/relevantFiles/cloneDir/cloneRetained; one omission = whole output rejected and turn ends), the parent receives no structured output at all — exactly the reported symptom "could not output anything".
- Fix (mirror the general-agent pattern):
  - After `STEP_ALL` resumes, inspect the returned step result: if no successful `set_output` landed on agentState.output, harvest the assistant's answer text from messageHistory into a `set_output` with status "answered" (or "failed" when only errors exist), deriving relevantFiles from the messages where feasible, and filling cloneDir/cloneRetained from params.
  - On schema failure, run ONE guided recovery pass: `add_message` naming exactly the missing required fields, then a second bounded STEP; only then fall back to harvest (per D1, no premature kill — but a terminal一定能 outcome instead of silence).
  - Add `timeout_seconds` (300–600) to the `git clone` call (the P0-effect "librarian clone without timeout" finding; a hung clone today blocks the turn with no failure signal).
- Acceptance: unit test asserting (a) text-only completion still yields structured output, (b) schema-failing set_output followed by guided retry, (c) clone failure with timeout reports status failed with stderr.

## P1 — Terminal profile redesign (D2): capability first, enforcement only after usability

**P1.1 Make the workspace-write/git-commit profiles genuinely capable (precondition)**
The profiles were neutering agents; before any enforcement is turned back on, live-path behavior under profiles must match what users see today under full-access for legitimate work. Add to `sdk/src/tools/terminal-command-policy.ts` + `sdk/src/tools/run-terminal-command.ts`:
- Owned-temp writes: allow `mktemp`/`/tmp`/`/var/tmp` and project-owned temp dirs (machinery exists, `ownedTempRoot`/`resolveOwnedTempRealPath` in `common/src/util/project-path-containment.ts`), with os/mac-tmp os.tmpdir() cross-platform mapping.
- Parameter expansion: allow `${HOME}`-style expansions for *reading* env into args in workspace-write when the expansion is an argument to the real executable and the resulting path remains in-project; keep denying the current known-bad shapes. Rule of thumb: deny data-out (`cp .env $X`), allow tool invocation (`--config=$FOO`).
- Pipelines/chains judged per-command, not denied wholesale: today's complex one-liners (`cmd a | tee log && cmd b`) must pass containment for every segment; run `findOutsideAbsolutePath` per resolved operand rather than rejecting on first unparseable fragment.
- Keep the dedicated failures (sudo/su, apt install, `rm -rf /`, force-push to default, env-dump `printenv`) as profile denies — these are orthogonal to the "neutered" complaint.
- Design probe (cheap, before P1.2): write a test corpus of the exact commands that failed under restrictive profiles in the original incident, and assert workspace-write now allows every one.

**P1.2 Wire the profile through the runtime (replaces the CRITICAL finding)**
- `packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:42` — stop hardcoding `permission_profile: 'full-access'`; forward the template-declared profile (default stays `full-access` for base2/omniscient agents; specialist agents declare their own narrower profile only when their template opted in).
- `sdk/src/run.ts:2013-2020` — clamp: a client/runtime-supplied profile may be narrowed, never widened beyond the template declaration.
- Keep the policy engine dormant for templates that genuinely need full-access; the point is that the ~70% of agents that should be modest-runners get real containment without losing capability (P1.1 is the gate).
- Cross-layer parity test: profile emitted by runtime == template declaration; staged-commit scanner (`run-terminal-command.ts:380`) becomes live again for git-commit templates.

**P1.3 Post-live checks (after P1.1+P1.2)**
- extends `SENSITIVE_STAGED_PATH` with `.envrc`, `id_ecdsa`, `id_dsa`, `id_ed25519_sk`; add `.envrc` to `common/src/util/sensitive-paths.ts` mandatory-read list.
- Fix bare `${HOME}` token check at `terminal-command-policy.ts:1892` (or cover by P1.1's expansion policy).
- git-committer's `bash -c` string building (P0.3) must be verified again once profiles are live — under full-access it was masked.

## P2 — Researcher overhaul (D4): make research agents genuinely capable

**P2.1 researcher-web: hybrid model-loops architecture**
Today `handleSteps` fully decomposes the prompt deterministically (MAX_SUBQUERIES=5, 1 call per subquestion, deep=2) and the LLM never sees intermediate results. Redesign:
- Remove the fixed call budget from programmatic decomposition; instead give the model `web_search` as a real tool (`toolNames: ['web_search']`) and put it in control: instructions "search, read results, adapt queries, revisit" with a generous step budget (per D1, no artificial kill). Keep the SSRF lexical guard as a pre-tool guard.
- Keep the deterministic decomposer as an optional bootstrap (emit the parsed subquestions into the prompt to seed the first search), but never cap the model's own follow-ups.
- Raise the per-search `include_links` and remove the `.slice(0,5)` cap in reuse, so follow-up link reads are possible.
- Preserve the structured `questions[]/sources[]/skippedQuestions[]` output contract.

## P3 — Job system ownership + forwarding (D3-adjacent reliability)

**P3.1 Session-stable ownership identity**
- `sdk/src/run.ts:732` — derive job ownership from the CLI session id (stable across turns) falling back to per-run when no session id is present. Store it on session state, not on Math.random() promptId.
- `packages/agent-runtime/src/util/runtime-job-owner.ts` and runtime handlers read the same identity. Cross-turn test: spawn job turn N, check_job turn N+1 returns real output.

## P4 — SDK robustness / performance (independent, batchable)

## P5 — CI hardening
- Pin third-party GitHub Actions to commit SHAs (all 10 workflows); add `.github/dependabot.yml` for github-actions + npm.
- Add `permissions: contents: read` to push/schedule workflows (keep per-job elevation for releases).
- Add `scripts` + `evals` packages to ci.yml test matrix (the harness's own guard/eval tests never run today).
- Replace `SECRETS_CONTEXT: ${{ toJSON(secrets) }}` with per-step named `env:` (drop `CODEBUFF_GITHUB_TOKEN` out of GITHUB_ENV).
- Fix evals.yml:89 commit-message script injection (env var pass-in) and the dead `git-evals/*` references.

## P6 — CLI TUI stability
- Guard the top-level submit path from unhandled rejections (today a rejected command promise can take down the TUI).
- Replace Date.now message ids with collision-free ids.
- Add a real connection-state machine under `useConnectionStatus` (status per event; reconnect banner path — unchanged until actual reconnection work lands elsewhere).

## P7 — Memory v2 performance + import resumability
- Repository Layer: generated `project_id` + `schema_version` columns with indexes replacing `json_extract(metadata_json, '$.projectId')` scans on append/query paths.
- Stream-aggregate the operator `/ import` scans instead of materializing everything per call, so large stores don't stall consolidations etc.

## P8 — indexer robustness
- parserDegraded shouldn't drop mutation deltas nor re-stamp builtAt: don't mark stale-then-fresh, requeue the applied delta, don't stamp fresh builtAt on failure.

## What this plan intentionally does NOT do
- No forced step-loop watchdog, per-step wall-clock alarm, or step cap (per D1). '/../
- No profile enforcement until P1.1 genuinely restores capability. Full-access remains the default.

## P4–P8 deferred-item checklist (see audit findings for file:line detail)

### P4 — SDK robustness (shard-sdk-tools)
- [ ] P4.1 OAuth refresh negative cache (30–60s TTL) in sdk/src/credentials.ts
- [ ] P4.2 Cache resolved dependency-path list per config-path set in provider-config hot path
- [ ] P4.3 Broker receipt retention cap + malformed-entry skip in workspace-mutation-broker
- [ ] P4.4 engines.node >=20.3 in sdk/package.json + oldest-Node CI job
- [ ] P4.5 Finite default timeout for file-change hooks (300s, explicit opt-out)
- [ ] P4.6 Delete mapWithConcurrency duplicate in read-files.ts; import from tools/concurrency.ts + contract tests

### P5 — CI hardening (shard-ci-evals)
- [ ] P5.1 Pin actions to commit SHAs; add dependabot.yml (github-actions + npm)
- [ ] P5.2 permissions: contents: read on push/schedule workflows
- [ ] P5.3 Add scripts + evals packages to ci.yml test matrix
- [ ] P5.4 Named per-step env instead of SECRETS_CONTEXT blob
- [ ] P5.5 Fix evals.yml commit-message injection + dead git-evals/* references
- [ ] P5.6 Upload eval artifacts; scheduled compare-runs regression gate
- [ ] P5.7 Gate-helper/pruner-budget --check freshness in CI; .agents mirror in TOOL_DEF_TRACKED_PATHS
- [ ] P5.8 Central config for judge/runner model ids; wire or remove eslint

### P6 — CLI TUI stability (shard-cli-tui)
- [ ] P6.1 Guard top-level submit path from unhandled rejections (chat.tsx + renderer-cleanup.ts)
- [ ] P6.2 Collision-free message ids (no Date.now())
- [ ] P6.3 Align/remove the silent 100-message transcript cap
- [ ] P6.4 Async checkpoint restore (no first-paint block)
- [ ] P6.5 Zod-validate legacy session loaders; bound undo stack

### P7 — Memory v2 perf + resumability (shard-memory-v2)
- [ ] P7.1 Generated project_id/schema_version columns + indexes replacing json_extract scans
- [ ] P7.2 Query path reads maintained projections; chunk the 10k IN list
- [ ] P7.3 Cursor-resumable allEvents/import scans (>10k events)
- [ ] P7.4 Redaction at capture time + the four named missing tests
- [ ] P7.5 Standardize memory-v2 imports on package aliases (remove dual deep-relative instances)

### P8 — indexer robustness (shard-indexer)
- [ ] P8.1 parserDegraded keeps builtAt, requeues delta
- [ ] P8.2 Per-file-entry + queryData shape validation at load
- [ ] P8.3 Normalized workspaceRevision comparison (numeric-string coercion)
- [ ] P8.4 Trigram posting index + command posting list
- [ ] P8.5 Sharded Float32 semantic vector cache with dimension pinning
- [ ] P8.6 Opt-in .git/info/exclude write; lstat in statProjectFiles
- [ ] P8.7 Validate setWasmDir; make integration tests explicit on missing WASM

Execution order: P4 (small independents) → P7.1/P7.2 → P8.1/P8.2 → P5 (CI) → P6 (TUI) → P8 remainder. Validate each wave with the narrowest package typecheck + touched test files.

## Suggested order / critical path
P0.1 first (unblocks audit shard tooling), then P0.2/P0.3 (safe small fixes), then P2 research, then P1 capability (insert in that order after the capability corpus exists), then P3 jobs, then batched P4-P8. Track each item as a tracked checklist line in this file; cleanliness on completion of each is confirmed by running the narrowest typecheck/test for the touched package.