# SPEC — Harness Remediation: turn "best possible" from NO into YES

## Overview
Remediate the complete harness audit of 2026-09-22 (435 findings — 1 CRITICAL, 31 HIGH, 209 MEDIUM, 194 LOW across 15 subsystem shards) AND close every missing-capability gap so each of the 15 audited parts reaches BEST-POSSIBLE under the audit rubric. The findings files are the authoritative work queue: `.agents/sessions/harness-audit-2026-09-22/findings/shard-*.md` (15 files with verbatim file:line evidence and per-feature verdict tables). Cross-cutting rollup and roadmap live in this session's audit report (synthesized from those files).

The 15 parts: core agent loop/streaming; deterministic edit system; subagent spawn & handoffs; background jobs & IPC; CLI/TUI; gate & reviewer loop; SDK core (BYOK routing/failover/credentials); SDK tool execution/filesystem authority; memory & context; shared contracts (common); indexing & retrieval; agent roster; templates/skills/evals; developer tooling & CI; docs & root config.

## Goals
- G1 Zero open CRITICAL/HIGH findings: the 10 top risks and all 31 HIGHs fixed with regression tests.
- G2 All MEDIUM findings resolved across the 8 domains (security, correctness, state-mutation, error-handling, performance, dependency-hygiene, test-coverage, api-contract); LOWs resolved or accepted with written rationale in the matching findings file.
- G3 Land the absent best-possible capabilities in 6 groups: sandboxing; edit UX (lint-gated applies, diff preview, dry-run, rollback journal, external-change watchers); semantic editing (LSP addressing); subagent lifecycle + isolation; sessions/context (resume/fork/rewind, incremental token accounting, prompt-cache stability); observability + evals hardening. Explicit user-accepted alternatives allowed only with written rationale.
- G4 Failure-path and CLI component test coverage for every remediated defect class.
- G5 Audit-tooling self-repair: inspect/evaluate coverage machine-check becomes runnable and passing in live sessions.
- G6 Re-audit certification: all 15 parts verdict BEST-POSSIBLE (or per-part signed exception recorded in the appendix below).

## Non-goals
- No new product features beyond the absent-capability list.
- No hosted/cloud/billing surfaces; BYOK-only architecture preserved.
- `agents-graveyard/**` stays quarantined (optional deletion is a P2 task only).
- No dependency version bumps unless a fix requires them; dependency changes go through dependency-reviewer.
- No force-push or history rewrite; work lands as normal commits on feature branch(es).

## Requirements
- R1 (security) No code-execution sink reachable from untrusted input: `handleSteps` string templates (run-programmatic-step.ts:345), eval data (run-buffbench.ts:432, judge.ts:280), dynamic agent loads (load-agents.ts:322), cli-agent send recipes (cli-agent-prompts.ts:243).
- R2 (containment) Every path resolution is normalize-then-check with symlink-safe lstat containment; owned-temp exec refusal covers all executable spellings; capability spans never widen (edit-transaction.ts:209 / process-edit-transaction.ts:779).
- R3 (trust) Config discovery trust-gated (provider-config.ts:1002/1057); receipts and read-capabilities attested, never re-minted from unauthenticated stamps (gate-reviewer.ts:137, read-authorization.ts:74); job/owner identity runtime-stamped, model-supplied values ignored (run.ts:2274).
- R4 (hygiene) No secrets in prompts, logs, or error surfaces (prompts.ts:164, run-agent-step.ts:690/2803, error.ts:78, write-file.ts:603, sensitive-paths.ts:8); CI secrets per-step scoped and third-party actions SHA-pinned (nightly-e2e.yml:21, ci.yml:27).
- R5 (correctness) Failure classification structured, not regex-over-prose (process-edit-transaction.ts:468); schemas single-sourced (edit-transaction.ts:311, memory-v2.ts:1361); AgentState authorization state runtime-validated (session-state.ts:367); generated tool type mirrors always regenerated (`bun scripts/generate-tool-definitions.ts`).
- R6 (lifecycle) Exception-safe cleanup everywhere (spawn-agents.ts:630, spawn-agent-inline.ts:390, tmux-cli.ts:752, change-file.ts:794); job state machine truthful (background-jobs.ts:999/1167); signals forwarded (run-mutation-gate.ts:14); finite default timeouts (basher.ts:157, llm.ts:1496, context7-api.ts:252, run-state.ts:253).
- R7 (performance) No unbounded hot-path work: params O(n²) (params/utils.ts:195), whole-transcript retokenizing (run-agent-step.ts:1947) and the GPT-4o fudge metric (token-counter.ts:4/6), per-call z.toJSONSchema (tool-executor.ts:884), uncached gate re-hashing (base2.ts readGateFileContentMarker), memory-drift-guard redundant walks (memory-drift-guard.ts:1010).
- R8 (contracts) Published SDK/CLI surfaces additive-only or versioned with deprecation windows; compatibility-reviewer green on every contract change; tool-call repair actually re-dispatches repaired input (currently echoes un-repaired).
- R9 (tests/CI) Failure-path tests per defect class; CLI components tested (app.tsx, chat.tsx, message-block, ask-user, tool-result-normalizer); every workspace test suite actually runs in CI (ci.yml:203 `find src` blind spot leaves all scripts/__tests__ unrun); flake ledger for the ci.yml:192 retry-x3.
- R10 (capabilities) G3 capability groups landed or explicitly accepted.
- R11 (audit tooling) Snapshot pipeline live-session-safe: live-state paths excluded from hashInventory; receipts validate against stored inventories (not the live tree); an explicit verified-evidence promotion path exists.

## Acceptance criteria
- AC1 `bun run typecheck` and `bun run test` (root, all workspaces) green at every milestone boundary; per-change validation per `agents/patterns/run-targeted-tests.md`.
- AC2 Every top-10 risk carries a regression test that fails against pre-fix behavior and passes after (adversarial fixture or fault injection).
- AC3 Specialist reviews with zero BLOCKING findings: security-reviewer (M1 surfaces), compatibility-reviewer (M2-T3 and all M5 public-surface changes), reliability-reviewer (M2-T4, M3-T3).
- AC4 M0-T1 golden test proves the previously-impossible flow: snapshot → write_audit_findings → evaluate_audit_coverage validates receipts against the stored inventory; probes survive between calls in a live session.
- AC5 Re-audit (M6): 15 shards re-run against the remediated tree, coverage machine-check returns complete, verdict table is BEST-POSSIBLE for all 15 parts (or an appendix exception with rationale and user sign-off).
- AC6 Pre-push hooks fully green including `guard:memory-drift` (knowledge.md files refreshed alongside src changes).
- AC7 Each findings file ends with a resolution marker per finding: fixed (commit ref) / accepted (rationale) — no silent drops.

## Relevant files/systems
- Work queue: `.agents/sessions/harness-audit-2026-09-22/findings/` (15 shard files) + `receipts.json`.
- Runtime: `packages/agent-runtime/src/**` (run-agent-step.ts, run-programmatic-step.ts, tool-executor.ts, process-edit-transaction.ts, process-structured-edit.ts, tools/handlers/tool/**, util/**).
- SDK: `sdk/src/**` (run.ts, provider-config.ts, credentials.ts, impl/llm.ts, impl/failover.ts, impl/chatgpt-backend-fetch.ts, tools/**, services/**, services/audit-intelligence.ts).
- Agents: `agents/**` (base2/gate-*.ts, base2/tool-tiers.ts, editor/**, basher.ts, tmux-cli.ts, git-committer/**, general-agent/**).
- Common: `common/src/**` (tools/params/**, types/session-state.ts, util/error.ts, util/project-path-containment.ts, util/sensitive-paths.ts).
- CLI: `cli/src/**` (app.tsx, chat.tsx, commands/command-registry.ts, components/ask-user/**, utils/tool-result-normalizer.ts).
- Indexing: `packages/indexer/src/**`, `packages/code-map/src/**`.
- Evals/templates: `evals/buffbench/**`, `.agents/lib/**`, `sdk/src/agents/load-agents.ts`, `sdk/src/skills/load-skills.ts`.
- Tooling/CI: `scripts/**`, `.github/workflows/**`.
- Docs: `docs/**`, `README.md`, `knowledge.md`, `*/knowledge.md`.

## Verdict rubric (definition of "BEST-POSSIBLE" — the target state)
A part is BEST-POSSIBLE only when: (a) it has zero open findings of severity HIGH or MEDIUM in any of the 8 domains; (b) every failure path it defines has tests; (c) its public contracts are documented and compatibility-reviewed; (d) no capability from the G3 absent list applies to it (or the alternative is accepted in writing). STRONG-IMPROVABLE, ADEQUATE, and SUBSTANDARD all count as "no" and must upgrade.

## Appendix — per-part target mapping (from the audit verdict table)
1. core agent loop: fix R1/R4/R7 items (new Function, prompt/log secrets, token accounting, gemini fallback, context7 timeout) → M1-T1, M1-T5, M3-T1/T2/T4.
2. deterministic edits: capability-span binding, attested stamps, structured failures → M1-T4, M2-T6; absent edit UX → M5-T2.
3. spawn & handoffs: exception-safe cleanup, handoff versioning, permissions semantics → M2-T1/T2.
4. jobs & IPC: CRITICAL output shape, owner stamping, lifecycle truth, signal forwarding → M1-T7, M2-T4.
5. CLI/TUI: concurrent-send guard, Esc data-loss, component tests → M4-T2.
6. gate & reviewer: receipt attestation, findingsAddressed requirement, symlink containment, mode default-deny, hash caching → M1-T2, M1-T4, M1-T6, M3-T2.
7. SDK core: config trust, repair contract, chatgpt arg reassembly, retry policy → M1-T3, M2-T5, M3-T4.
8. SDK tool exec: containment bypasses, temp exec refusal, change-file cancel → M1-T2, M3-T1.
9. memory & context: live re-hash verify, archivedAt collisions, consolidation tests, redaction → M0-T1 (pattern), M3-T4, M4-T1.
10. common contracts: AgentState zod, O(n²) params, schema unification → M2-T3, M3-T2.
11. indexing: lock reclaim + CAS, BM25 ranking, lstat TOCTOU, chunk-freshness label → M3-T2/T3, M5-T2 (watchers).
12. agent roster: push guard fail-closed, tmux label sanitization, BYOK model routing, basher timeout → M1-T6, M3-T1.
13. templates/evals: eval exec hardening, task delivery via stdin, skills/agents trust gates, judge calibration → M1-T1, M5-T7.
14. tooling & CI: CI test glob, action pins, secrets scoping, timeouts, guard fixes → M1-T6, M4-T3.
15. docs & root: fence/truncation/citation fixes, knowledge.md fill, drift check → M5-T9.
