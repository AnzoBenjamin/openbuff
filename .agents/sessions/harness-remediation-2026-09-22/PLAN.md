# PLAN — Harness Remediation (435 findings → all parts BEST-POSSIBLE)

Source of truth for defects: `.agents/sessions/harness-audit-2026-09-22/findings/shard-*.md`. Task IDs are stable (M<stage>-T<n> / M4-S<n>) — do not renumber. Every task lists Depends on / Acceptance / Validate.

## Milestone overview
- M0 Foundation & audit tooling (3 tasks) — unblocks verification and shared helpers.
- M1 P0 security & data-loss (7 tasks) — the 1 CRITICAL + top-10 risks + all security HIGHs.
- M2 Contracts & lifecycle correctness (6 tasks) — schemas, cleanup, job truth, repair contract.
- M3 Reliability & performance (4 tasks) — timeouts, hot paths, races, retry policy.
- M4 Test & CI coverage + per-shard MEDIUM/LOW sweeps (3 tasks + 6 sweeps) — clears the remaining ~370 findings.
- M5 Best-possible capability gaps (9 tasks) — the "entirely absent" list that upgrades verdicts to BEST-POSSIBLE.
- M6 Certification & release (3 tasks) — re-audit, verdict gate, release readiness.

Ordering: M0 → M1 → M2 → M3 → M4 → M5 → M6. M4-T2 may run parallel to M3; M5-T9 (docs) may run any time after M1-T5. M5 capability work may start after M2 where noted.

---

## M0 — Foundation & audit tooling

- [ ] **M0-T1** Repair the audit snapshot pipeline (R11). In `sdk/src/services/audit-intelligence.ts` + `sdk/src/tools/audit-intelligence.ts` + `common/src/tools/params/tool/audit-intelligence.ts`: (a) exclude live-state paths from `hashInventory`/`walk` (`.openbuff/`, `.codebuff-index/`, `debug/`, `scratch-logs/`, `.tmp/`, `.omx/`, `*.log`, `*.sqlite*`); (b) persist inventories at `inspectCodebaseStructure` time and let `evaluateAuditCoverage` validate receipts against the STORED inventory for each receipt's snapshot_id, not the live one; (c) add an explicit verified-evidence promotion path (exact-read attestations flip `evidence_kind` to `verified`) so probe receipts can reach `complete`.
  - Acceptance: golden test does snapshot → write_audit_findings → evaluate_audit_coverage and passes; two calls in one process no longer report stale when only live-state churned; probes mint receipts usable by the checker.
  - Validate: `cd sdk && bun test src/__tests__/audit-intelligence.test.ts` + sdk typecheck.
- [ ] **M0-T2** Shared fail-closed primitives (feeds M1/M2). Add: single normalize-then-check containment helper (extend `common/src/util/project-path-containment.ts` / `sdk/src/tools/path-utils.ts`), fail-closed guard helper, and a typed structured error-code union in `common/src/util/error.ts` (replaces prose-regex failure classification). No consumer behavior change yet.
  - Acceptance: exported + unit-tested helpers; error taxonomy covers every `resolveFailedEdit` outcome observed in shard-tools-edit.
  - Validate: `cd common && bun run typecheck && bun test`.
- [ ] **M0-T3** Sub-agent output durability. Fix silent `null` structured output and transport truncation: size-bound + chunk large `set_output` payloads (`common/src/tools/params/tool/set-output.ts`, `packages/agent-runtime/src/tools/handlers/tool/set-output.ts`), durable-write fallback for oversized receipts, explicit partial marker instead of silent loss (`spawn-agent-utils.ts` output normalization).
  - Acceptance: oversized output never vanishes silently; truncation surfaces an explicit partial result.
  - Validate: `cd packages/agent-runtime && bun test src/tools/handlers/tool/__tests__/set-output.test.ts` + common set-output-schema tests.

## M1 — P0 security & data-loss

- [ ] **M1-T1** Kill code-execution sinks (R1). `run-programmatic-step.ts:345` — replace `new Function` materialization with static-source allowlist or sandboxed evaluation (deny ALL non-registry sources, not just `'database'`); `load-agents.ts:322` — trust-gate dynamic imports of agent code; `run-buffbench.ts:432` + `judge.ts:280` — zod `safeParse` judge output, `execFileSync` with argv arrays, no shell interpolation; `cli-agent-prompts.ts:243` — deliver task text via stdin/file, never shell interpolation.
  - Depends on: M0-T2
  - Acceptance: adversarial fixtures (malicious template/eval/task payload) execute nothing; AC2 regression tests exist for all four sinks.
  - Validate: `cd packages/agent-runtime && bun test src/__tests__/sandbox-generator.test.ts src/__tests__/run-programmatic-step.test.ts`; `cd evals && bun test`; security-reviewer over the diff.
- [ ] **M1-T2** Containment hardening (R2). `terminal-command-policy.ts:2034` + `filesystem-authority.ts:777` + `read-policy.ts` — normalize-then-check at every entry; owned-temp exec refusal covers extension-less/multi-dot/interpreter file-args; `gate-paths.ts:19` + `readGateFileContentMarker` — lstat-based symlink containment; `plan-artifacts.ts:115` path binding; `edit-transaction.ts:209`/`process-edit-transaction.ts:779` — capability spans bound end-to-end (no widen-to-whole-file default).
  - Depends on: M0-T2
  - Acceptance: traversal/symlink/non-normalized/win32-alias test matrix passes; whole-file clobber via omitted startLine/endLine impossible.
  - Validate: `cd sdk && bun test src/__tests__/filesystem-authority.test.ts src/__tests__/terminal-command-policy.test.ts`; `cd agents && bun test __tests__/gate-paths.test.ts`; `cd packages/agent-runtime && bun test src/__tests__/replace-range-whole-file-capability.test.ts`; security-reviewer.
- [ ] **M1-T3** Config trust boundary (R3). `provider-config.ts:1002/1057` — trust-gate ancestor-directory config discovery (project-root allowlist or explicit trust record), gate `apiKeyEnv`-declaring providers and hooks with the same trust as `readableRoots`; `model-discovery.ts` — never send keys to non-HTTPS endpoints.
  - Depends on: M0-T2
  - Acceptance: an untrusted ancestor `openbuff.json` cannot reroute models or expose keys; negative tests.
  - Validate: `cd sdk && bun test src/__tests__/provider-config.test.ts`; security-reviewer.
- [ ] **M1-T4** Attestation fixes (R3). `gate-reviewer.ts:137` — receipts channel-attested (bind reviewer run id + snapshot fingerprint; forged receipts rejected); `read-authorization.ts:74` — stop re-minting HMAC caps from unauthenticated persisted stamps; `base2.ts:6039` — repair receipts must map `findingsAddressed` to open finding IDs and their files.
  - Depends on: M0-T2
  - Acceptance: forged/legacy/unmapped receipts fail closed with tests; gate-lifecycle e2e covers the forged-receipt case.
  - Validate: `cd agents && bun test __tests__/gate-reviewer.test.ts __tests__/gate-repair.test.ts`; `bun test e2e/gate-lifecycle.e2e.test.ts`; security-reviewer.
- [ ] **M1-T5** Secret redaction (R4). `prompts.ts:164` — replace verbatim shell-config embedding with a selective safe allowlist; `run-agent-step.ts:690/2803` — redact system prompt + history in debug/error logs; `error.ts:78`, `write-file.ts:603`, edit-error surfaces — no raw internal error messages to model-visible output; `sensitive-paths.ts:8` hardening; `evals/buffbench/judge.ts:330` — fence untrusted sections in judge prompts.
  - Acceptance: seeded-secret fixtures never appear in prompt bytes, logs, or error strings (property test).
  - Validate: `cd common && bun test`; `cd packages/agent-runtime && bun test`; security-reviewer.
- [ ] **M1-T6** Close fail-open guards (R4/R6). `git-committer.ts:330` — default-branch push guard fails CLOSED when `${remote}/HEAD` unresolvable; `tool-tiers.ts:49` + `packages/agent-runtime/src/util/base2-tool-tiers.ts` — `modeAllowsTool` default-deny for mutation-capable tools with an exhaustive mode-policy map + test asserting every ToolName has an explicit policy; `nightly-e2e.yml:21` — remove `toJSON(secrets)`; `ci.yml:27` — SHA-pin setup-bun/cache/retry, per-step secret scoping; `ci.yml:203` — fix `find src` glob so `scripts/__tests__` actually runs.
  - Acceptance: negative tests (unresolvable HEAD → refuse; unknown tool name in plan-only → deny); workflow lint passes `check-ci-local`.
  - Validate: `cd agents && bun test __tests__/git-committer.test.ts __tests__/base2.test.ts`; `cd scripts && bun test`; `bun run check:ci-local` (read-only steps).
- [ ] **M1-T7** CRITICAL background-agent output + ownership (R3/R5). `check-background-agent.ts:314` — fix the output shape (tuple-JSON) so all background-agent results render; `check-background-agent.ts:199` + `run.ts:2274` — runtime-stamp job owner; ignore model-supplied owner fields (`browser_logs` `_browserOwner` included).
  - Acceptance: a real background-agent result renders in CLI (tmux smoke); spoofed owner fields ignored with tests.
  - Validate: `cd packages/agent-runtime && bun test src/tools/handlers/tool/__tests__/check-job.test.ts`; `cd sdk && bun test src/__tests__/check-job.test.ts src/__tests__/run-session-job-ownership.test.ts`.

## M2 — Contracts & lifecycle correctness

- [ ] **M2-T1** Exception-safe spawn settle/teardown (R6). `spawn-agents.ts:630` + `spawn-agent-inline.ts:390` — try/finally around settle/post-processing; leases + shard ledger + discovery-shards released on every path; rollback skips already-wired background jobs.
  - Depends on: M1-T2
  - Acceptance: fault-injection test (throw at each settle step) leaves zero leases and zero dangling `spawn_started` ledger events.
  - Validate: `cd packages/agent-runtime && bun test src/__tests__/spawn-agents-permissions.test.ts src/__tests__/spawn-agent-inline-nesting.test.ts src/util/__tests__/workspace-path-leases.test.ts`; reliability-reviewer.
- [ ] **M2-T2** Handoff version boundary + permission semantics (R5/R8). `spawn-agent-inline.ts:185` + `spawn-agent-utils.ts` — reject non-v1 handoffs at the boundary (canonicalize like the batch path); define and test empty-permission semantics (empty `allowedTools` ≠ strip-all; empty paths ≠ unrestricted).
  - Depends on: M2-T1
  - Acceptance: unversioned/legacy handoff is a clean validation error, never a TypeError; permission matrix test.
  - Validate: `cd packages/agent-runtime && bun test src/__tests__/agent-handoff-boundary.test.ts src/__tests__/spawn-agents-permissions.test.ts`; compatibility-reviewer.
- [ ] **M2-T3** Schema unification & contract validation (R5/R8). Single-source `edit-transaction` schemas (`edit-transaction.ts:311`), `memory-v2.ts:1361`, `load-agents.ts:253` id-splitting fix; zod-validate `AgentState` at every boundary (`session-state.ts:367`); unified `errorCode` union consuming M0-T2 (`str-replace.ts:157`); regenerate all tool type mirrors via `bun scripts/generate-tool-definitions.ts`; deprecation shims where the published SDK surface changes.
  - Depends on: M0-T2
  - Acceptance: one schema definition per contract; `AuditFindingsInput`-style input/output drift test pattern applied to every exported type; mirrors byte-identical after regeneration.
  - Validate: `cd common && bun test src/tools`; `cd cli && bun test src/__tests__/init-type-sources.test.ts`; compatibility-reviewer.
- [ ] **M2-T4** Job lifecycle truth (R6). `background-jobs.ts:999/1167` — stuck-running/false-stopped fixed (pid liveness + exit-code capture); `kill-job.ts`/`run-mutation-gate.ts:14` — signal forwarding, no orphaned children; `check-job.ts:198`; `end-turn.ts` pending-jobs handling.
  - Depends on: M1-T7
  - Acceptance: lifecycle state machine test (start→exit→report) with no leaks; killed job's child tree is gone.
  - Validate: `cd sdk && bun test src/__tests__/kill-job.test.ts src/__tests__/list-jobs.test.ts`; `cd packages/agent-runtime && bun test src/tools/handlers/tool/__tests__/kill-job.test.ts src/__tests__/end-turn-pending-jobs.test.ts`; reliability-reviewer.
- [ ] **M2-T5** Tool-call repair + ChatGPT-OAuth correctness (R5/R8). `direct-agent-tool-repair.ts` / `repairToolCall` contract — repaired input actually re-dispatched/re-validated (verify installed AI SDK semantics first), never echoed un-repaired; `chatgpt-backend-fetch.ts:355/389` — done/delta mismatch reassembly fixed; `credentials.ts` OAuth refresh single-flight per account (not cross-account).
  - Depends on: M2-T3
  - Acceptance: invalid-JSON tool call either repairs to a valid dispatch or fails explicitly; corrupted-args fixture round-trips correctly.
  - Validate: `cd sdk && bun test src/impl/__tests__/direct-agent-tool-repair.test.ts src/__tests__/chatgpt-backend-fetch.test.ts src/__tests__/credentials.test.ts`.
- [ ] **M2-T6** Deterministic-edit correctness (R2/R5). `process-edit-transaction.ts:468` — structured failure classification (M0-T2 union, no prose regex); `write-file.ts:261` — preserve `modelVisibleReadAuthorizationHashesByPath`; `tool-executor.ts:3223` — await/guard `onCostCalculated`; `str-replace.ts:460` — no shared settled-object mutation; `edit-application-coordinator.ts:319` — stop revoking authorization on untrusted-output prose classification; `rewrite-symbol.ts:103` occurrence default + typed handler.
  - Depends on: M0-T2, M2-T3
  - Acceptance: failure taxonomy exhaustive over injected error shapes; no authz state change driven by model-visible prose.
  - Validate: `cd packages/agent-runtime && bun test src/__tests__/process-edit-transaction.test.ts src/__tests__/process-str-replace.test.ts src/tools/handlers/tool/__tests__/edit-application-coordinator.test.ts`.

## M3 — Reliability & performance

- [ ] **M3-T1** Finite timeouts everywhere (R6). `llm.ts:1496` request timeout; `context7-api.ts:252` body-read timeout + `:108` response zod validation; `run-state.ts:253`; `basher.ts:157` default finite timeout + `:130` clamp `max_failure_lines`/NaN; `tmux-cli.ts:500/752` setup timeout + unconditional teardown; `change-file.ts:794` per-change try/catch + cancel-on-exit; `check-ci-local.ts:194` default step timeout on.
  - Depends on: M2-T1
  - Acceptance: a hung subprocess/stream cannot hang the harness; every default timeout documented.
  - Validate: `cd agents && bun test __tests__/basher.test.ts`; `cd packages/agent-runtime && bun test src/llm-api/__tests__/context7-api.test.ts`; `cd scripts && bun test __tests__/check-ci-local.test.ts`.
- [x] **M3-T2** Hot-path cost (R7). `params/utils.ts:195` O(n²) → linear; `run-agent-step.ts:1947` incremental token accounting + `token-counter.ts:4/6` per-provider counters, bounded LRU (no whole-transcript caching); `tool-executor.ts:884` cache `z.toJSONSchema`; `base2.ts` `readGateFileContentMarker` content-hash cache; `memory-drift-guard.ts:1010` single batched walk; `tool-result-eviction.ts:78` bound. (implementation + benchmark evidence + specialist review complete; checkbox flips after the automated gate passes for tool-result-eviction.test.ts + measure-m3-t2-hot-paths.ts) (complete: all 7 sites implemented + benchmark evidence (exit 0, 7/7 parity/contract assertions) + specialist review NON_BLOCKING (3 low findings fixed) + gate LOOKS_GOOD; commit follows)
  - Acceptance: benchmark evidence (before/after) per hot path from `scripts/measure-context-baseline.ts` + micro-timings; token metrics per provider documented.
  - Validate: `cd packages/agent-runtime && bun test src/util/__tests__/token-counter.test.ts src/util/__tests__/context-budget.test.ts`; performance-specialist review.
- [ ] **M3-T3** Race fixes (R6). `coordinator.ts:721`; `index-store.ts:685` liveness-checked lock reclaim + generation CAS for vector writes; `harness-enforcement.ts:72`; `file-walker.ts` stat→lstat TOCTOU; `command-registry.ts:169` guarded submit + `:474` flush; `chunk-freshness.ts` FRESH-vs-ORPHAN label fix.
  - Depends on: M2-T4
  - Acceptance: concurrent-fixture tests for each race; no lost updates under parallel writers.
  - Validate: `cd packages/indexer && bun test src/index-store.test.ts src/chunk-freshness.test.ts src/file-walker.test.ts`; `cd sdk && bun test src/__tests__/harness-enforcement.test.ts`; reliability-reviewer.
- [ ] **M3-T4** Retry/fallback policy (R6). `gemini-with-fallbacks.ts:88` — error-class gating + backoff/Retry-After (no blanket escalation); `:49` — implement the documented Vertex leg + `costMode`; `retry-config.ts` — non-streaming paths retry like streaming; `failover.ts` — content-policy violations per documented contract; `context-consolidation.ts` `archivedAt` collision-safe ids.
  - Depends on: M2-T5
  - Acceptance: retry matrix test (error class × attempt × backoff); `costMode` observable in routing; no duplicate `archivedAt`.
  - Validate: `cd packages/agent-runtime && bun test src/llm-api/__tests__/gemini-with-fallbacks.test.ts`; `cd sdk && bun test src/__tests__/retry-config.test.ts src/impl/__tests__/failover.test.ts`; `cd packages/agent-runtime && bun test src/util/__tests__/context-consolidation.test.ts`.

## M4 — Coverage: tests, CI truth, per-shard sweeps

- [ ] **M4-T1** Failure-path test campaign (R9). Close every "untested" finding: `process-structured-edit` 12-language import logic; `workspace-journal.ts`; context-consolidation gating + recall-context merge; spawn lease/ledger fault paths; index-store races; un-skip `failover-integration.test.ts:293` (`promptAiSdkStream` loop).
  - Depends on: M2-T6, M3-T3
  - Acceptance: each named surface has a failure-path suite; the skipped loop test runs and passes (or its behavior fix lands in M2-T5).
  - Validate: per-package targeted suites + `bun run typecheck`.
- [ ] **M4-T2** CLI component tests & UX data-loss (R9). First component tests for `app.tsx`, `chat.tsx`, `message-block.tsx`, `ask-user/**`, `tool-result-normalizer.ts`; fix ask-user Esc data-loss; guard concurrent sends (with M3-T3). May run parallel to M3.
  - Acceptance: streaming/concurrency/ask-user interactions covered; Esc preserves draft.
  - Validate: `cd cli && bun test src/components src/hooks`.
- [ ] **M4-T3** CI truth & guard fixes (R9). With M1-T6's glob fix, assert `scripts/__tests__` runs in CI; flake ledger for `ci.yml:192` retry-x3 (track which suites flake); `check-tool-registration.ts:75` word-boundary matching; `check-ci-local.ts:74` vs `memory-drift-guard.ts:956` `.openbuff/.gitignore` contradiction resolved; `generate-gate-helpers.ts` `--check` mode wired to CI; `scripts/package.json:9` exports map fixed.
  - Depends on: M1-T6
  - Acceptance: deliberately broken scripts test fails CI (proving it runs); guard contradiction documented and single-sourced.
  - Validate: `cd scripts && bun test`; `bun run check:ci-local`.
- [ ] **M4-S1** Sweep — runtime-loop + tools-edit shards: fix or accept-with-rationale every remaining MEDIUM/LOW finding in `shard-runtime-loop.md` and `shard-tools-edit.md`.
  - Depends on: M1-T1, M1-T5, M2-T6, M3-T2
  - Acceptance: every finding in both files carries a resolution marker (fixed+commit ref / accepted+rationale).
  - Validate: `cd packages/agent-runtime && bun run typecheck && bun test`.
- [ ] **M4-S2** Sweep — spawn-subagents + jobs-ipc + cli-tui shards (`shard-spawn-subagents.md`, `shard-jobs-ipc.md`, `shard-cli-tui.md`).
  - Depends on: M2-T1, M2-T2, M2-T4, M1-T7, M4-T2
  - Acceptance: resolution markers for every finding in the three files.
  - Validate: `cd packages/agent-runtime && bun test`; `cd cli && bun test`.
- [ ] **M4-S3** Sweep — sdk-core + sdk-tool-exec shards (`shard-sdk-core.md`, `shard-sdk-tool-exec.md`).
  - Depends on: M1-T3, M2-T5, M3-T1, M3-T4
  - Acceptance: resolution markers for every finding in both files.
  - Validate: `cd sdk && bun run typecheck && bun test`.
- [ ] **M4-S4** Sweep — memory-context + common-contracts shards (`shard-memory-context.md`, `shard-common-contracts.md`).
  - Depends on: M2-T3, M3-T4, M4-T1
  - Acceptance: resolution markers for every finding in both files.
  - Validate: `cd common && bun run typecheck && bun test`; `cd packages/agent-runtime && bun test src/util`.
- [ ] **M4-S5** Sweep — agent-roster + templates-evals shards (`shard-agent-roster.md`, `shard-templates-evals.md`).
  - Depends on: M1-T1, M1-T6, M3-T1, M5-T7
  - Acceptance: resolution markers for every finding in both files.
  - Validate: `cd agents && bun test`; `cd evals && bun test`.
- [ ] **M4-S6** Sweep — indexing-retrieval + tooling-ci + docs-root shards (`shard-indexing-retrieval.md`, `shard-tooling-ci.md`, `shard-docs-root.md`).
  - Depends on: M3-T3, M4-T3, M5-T9
  - Acceptance: resolution markers for every finding in the three files.
  - Validate: `cd packages/indexer && bun test`; `cd scripts && bun test`; docs link check.

## M5 — Best-possible capability gaps (upgrade verdicts to YES)

- [ ] **M5-T1** Sandboxing for tool/template/hook execution. OS-level profiles (Linux bubblewrap+Landlock, macOS Seatbelt, Windows restricted tokens) for terminal + `handleSteps` + hooks, with approval-policy separated from sandbox level (Codex-style); graceful policy-level fallback where OS sandboxing is unavailable; config + docs.
  - Depends on: M1-T1
  - Acceptance: sandbox escape fixtures fail; fallback documented; `openbuff.json` sandbox levels configurable.
  - Validate: `cd sdk && bun test src/__tests__/terminal-command-capability.test.ts` + new sandbox suite; security-reviewer.
- [ ] **M5-T2** Edit UX completeness. Opt-in lint/typecheck-gated applies; per-edit unified-diff preview (CLI `diff-viewer` wiring); dry-run mode; on-disk rollback journal; external-change watchers feeding workspace-revision invalidation.
  - Depends on: M2-T6
  - Acceptance: dry-run mutates nothing; rollback journal restores an aborted transaction; watcher invalidates stale anchors on external edits.
  - Validate: `cd packages/agent-runtime && bun test src/__tests__/edit-transaction-multi-file-recovery.e2e.test.ts` + new suites.
- [ ] **M5-T3** Semantic editing. Wire the LSP harness (`scripts/harness-language-server.ts`) for symbol-accurate `rewrite_symbol` addressing (fallback to tree-sitter when no server).
  - Depends on: M5-T2
  - Acceptance: symbol rename/move via LSP with test fixture project; graceful fallback.
  - Validate: `cd packages/agent-runtime && bun test src/__tests__/rewrite-symbol.test.ts` + new LSP suite.
- [ ] **M5-T4** Subagent lifecycle & isolation. spawn/wait/send/close/resume/list lifecycle surface; git-worktree isolation option for mutating subagents; summary-only return enforcement; sidechain transcripts persisted per subagent.
  - Depends on: M2-T1, M2-T2
  - Acceptance: isolated subagent cannot dirty the main worktree (unless opted in); lifecycle API covered by tests; transcripts recoverable after crash.
  - Validate: `cd packages/agent-runtime && bun test src/__tests__/spawn-depth.test.ts` + new lifecycle suite.
- [ ] **M5-T5** Sessions & context. Session resume/fork/rewind + file-history checkpoints; incremental token accounting finalized (with M3-T2); prompt-cache-prefix stability pass (cache anchors never churn); reasoning-state-preserving compaction path.
  - Depends on: M3-T2
  - Acceptance: rewind restores prior turn state; cache-debug shows stable prefixes across turns; compaction fidelity eval passes (`evals/compaction-fidelity`).
  - Validate: `cd evals && bun test compaction-fidelity compaction-retention`; `cd cli && bun test src/utils/__tests__/run-state-storage.test.ts`.
- [ ] **M5-T6** Observability. Structured metrics/events/traces (OTEL-compatible exporter), typed failure-taxonomy events (M0-T2), job-update drop/backpressure counters (`job-update-forwarder.ts:95`), gate telemetry completeness.
  - Depends on: M0-T2, M2-T4
  - Acceptance: one run emits complete trace; drop counters observable under load.
  - Validate: `cd packages/agent-runtime && bun test src/orchestration/__tests__/gate-telemetry-sink.test.ts` + new observability suite.
- [ ] **M5-T7** Evals hardening. Pinned judge models + zod-validated judge output (with M1-T1), true median scoring, gold-set judge calibration, adversarial-injection eval tests, deterministic-signal fixes (word-boundary command matching, `idiomScore` clamp) (`deterministic-signals.ts`, `judge.ts`, `run-buffbench.ts`).
  - Depends on: M1-T1
  - Acceptance: synthetic-zero runs excluded from averages (scoringStatus-based); adversarial judge-prompt fixture cannot skew scores.
  - Validate: `cd evals && bun test buffbench/__tests__`.
- [ ] **M5-T8** (stretch, decision at M5 start) MCP server mode + hook-event breadth parity.
  - Depends on: M5-T4
  - Acceptance: openbuff exposes an MCP server surface; hook events documented.
  - Validate: new mcp suite + docs.
- [ ] **M5-T9** Docs overhaul. Fill root `knowledge.md` (or delete); `docs/request-flow.md:191` fence; `docs/agents-and-tools.md:1246` truncation + slash-command table; `docs/configuration.md:222` `openbuff.d.example` wording; README test instructions (root `bun run test`); docs↔code citation drift check script. Depends on M1-T5 (secret-safe examples).
  - Acceptance: link checker green; no doc cites a nonexistent path.
  - Validate: link check + `cd scripts && bun test __tests__/byok-wording-guard.test.ts`.

## M6 — Certification & release

- [ ] **M6-T1** Re-audit wave. Re-run all 15 audit shards against the remediated tree (same 8-domain contract), then `evaluate_audit_coverage` (now runnable after M0-T1) and a synthesizer rollup.
  - Depends on: M4-S1, M4-S2, M4-S3, M4-S4, M4-S5, M4-S6, M5-T1, M5-T2, M5-T3, M5-T4, M5-T5, M5-T6, M5-T7, M5-T9
  - Acceptance: 15 fresh findings files with resolution-status sections; machine-check `complete: true`.
  - Validate: coverage tool output recorded in `.agents/sessions/harness-remediation-2026-09-22/recheck/`.
- [ ] **M6-T2** Verdict gate. Every part BEST-POSSIBLE per the SPEC rubric; any exception requires written rationale + user sign-off recorded in SPEC appendix.
  - Depends on: M6-T1
  - Acceptance: verdict table with 15× BEST-POSSIBLE (or signed exceptions).
  - Validate: evaluator agent scores the verdict table against source evidence.
- [ ] **M6-T3** Release readiness. Full typecheck+test green; pre-push hooks green incl. `guard:memory-drift` (knowledge refreshed with every src change); security + compatibility + reliability reviewers over the full branch diff; changelog entries; commits per git-discipline guide, push per explicit user authorization.
  - Depends on: M6-T2
  - Acceptance: zero BLOCKING reviewer findings; branch pushable.
  - Validate: `bun run typecheck && bun run test`; `bun run check:ci-local`.

## Dependencies & ordering constraints
- M0-T2 primitives must land before M1-T1/T2 and M2-T6 (they consume the containment helper + error union).
- M0-T1 must land before M6-T1 (certification requires the runnable machine-check).
- M2-T3 regenerates all tool type mirrors — pair every later tool-schema change with `bun scripts/generate-tool-definitions.ts` + knowledge.md refresh (guard:memory-drift blocks pushes otherwise).
- M1 before M2/M3 in the same files (security fixes define the boundaries the lifecycle work builds on).
- M4 sweeps are the closure gate for MEDIUM/LOW; each sweep depends on its milestone fixes to avoid rework.
- M5 capability work interleaves after M2; M5-T8 is a go/no-go decision recorded in STATUS.md at M5 start.

## Risks, blockers, open questions, assumptions
- Risk: published `@openbuff/sdk` surface changes break consumers → mitigation: additive-first, deprecation windows, compatibility-reviewer per change (M2-T3, M5).
- Risk: OS sandboxing is platform-fragmented → mitigation: policy-level fallback layer ships first (M5-T1), OS profiles land per platform behind config.
- Risk: un-skipping `failover-integration.test.ts:293` may expose latent behavior changes in `promptAiSdkStream` → budget repair time in M2-T5.
- Risk: multi-day execution drifts → mitigation: STATUS.md checkpoint discipline (below), stable task IDs.
- Open question (verify at fix time): exact AI SDK `experimental_repairToolCall` return semantics (re-dispatch vs re-validate) — M2-T5 must test both shapes.
- Open question: two CLI findings cite approximate line numbers (`chat.tsx`, `sdk-event-handlers.ts`) — locate exact lines from the verbatim snippets during M4-S2.
- Assumption: findings files remain the stable work queue; if code moves, resolution markers cite commit refs, not line numbers.
- Assumption: no dependency upgrades required beyond lint/typecheck gating (M5-T2) and possibly an LSP client (M5-T3) — any add goes through dependency-reviewer.

## Validation gates (per milestone)
- Gate A (M0): golden audit-tooling test + common/sdk suites green. — PASSED (M0-T1/T2/T3 reviewer receipts on record).
- Gate B (M1): all adversarial fixtures pass; security-reviewer zero BLOCKING; AC2 tests exist.
- Gate C (M2): compatibility-reviewer + reliability-reviewer zero BLOCKING; mirrors regenerated & committed.
- Gate D (M3): benchmark evidence attached; race suites green.
- Gate E (M4): `bun run typecheck` + `bun run test` all workspaces green; every sweep file fully marked.
- Gate F (M5): capability acceptance tests green; product-reviewer signs UX-visible changes (diff preview, dry-run, ask-user).
- Gate G (M6): machine-check complete; 15× BEST-POSSIBLE; release checklist green.

## Checkpoint / update rules
- STATUS.md: update via `update_plan_status` at every task completion, every blocker, and every validation gate (include receipt/commit refs). Never batch more than one task of drift.
- LESSONS.md: append via `update_plan_status` whenever a fix reveals a gotcha (schema regeneration, knowledge.md staleness, transport limits, provider quirks). Substantial rewrites via `create_plan`.
- PLAN.md / SPEC.md: revise via `create_plan` only when scope changes (new findings, user direction, M5-T8 decision); record the reason in LESSONS.md.
- Per-task completion requires its `Validate` command green + the automated reviewer gate before the task checkbox flips.

## Resume / update guidance
- Resume: read STATUS.md → first non-done task in PLAN.md → re-read its target files fresh (never from memory) → execute → validate → update STATUS.md + LESSONS.md → flip the checkbox via update_plan_status.
- The findings files under `.agents/sessions/harness-audit-2026-09-22/findings/` are read-only inputs; record resolutions in this session's STATUS.md/LESSONS.md and per-file resolution markers (M4 acceptance) — do not rewrite audit evidence.
- Artifacts: `.agents/sessions/harness-remediation-2026-09-22/{SPEC,PLAN,STATUS,LESSONS}.md`.

## Current-task pointer
<!-- current-task: none -->
