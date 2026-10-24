# STATUS: memory-overhaul-2026-10

## Current state (2026-10-19)
- Discovery COMPLETE: 4 audit shards with structural receipts (snapshot 1d150eb5); findings persisted under findings/ (cli-store.md, sdk-coordinator.md, runtime-recall.md, types-evals.md).
- Thesis CONFIRMED with file:line evidence: memory is write-heavy/read-light (8+ write sites, 1 read site, 12k compile discards over-fetch), zero procedural memory (no playbook kind; run_terminal_command output dropped from memory), zero enforcement (pull-only recall; no gate consults memory), cold-start re-reads (read tools capture no digests), no behavior-change eval.
- Architecture DECIDED: thinker ADR (first-class playbook store + tool-executor deterministic gate + reserved read band + digest ledger + A/B behavior eval), seam evidence re-verified live against tool-executor.ts / memory-v2.ts.
- Durable artifacts: SPEC.md + PLAN.md written.

## Completed
- Audit wave (4 shards + receipts), deterministic evals run (compaction-retention/fidelity/memory-retention green), specialist smoke test (security-reviewer full structured receipt — contract holds).
- Prior-session work already on branch: reviewer-family reliability fixes (4 commits pushed to origin).

## Next checkpoint
- Phase 1 implementation (P1-T1..P1-T6). Resume instructions: spawn editor with the P1-T1..T5 brief from PLAN.md Phase 1; then run validation gates; then P1-T6 tests.

## Blockers
- None. Gate pending on prior sdk advisory-fix files clears independently.

<!-- update_plan_status:appended -->
## Phase 1 COMPLETE — 2026-10-19T09:25:33.541Z

Phase 1 (playbook store + deterministic gate) is implemented and green across common/cli/sdk/agent-runtime.

Delivered:
- `common/src/types/memory-playbook.ts`: PlaybookTriggerSchema (tool enum, spawnAgentType, terminalAction argv-class, requireEvidence kinds), PlaybookScope/Counters, MemoryPlaybookSchema (strict), computeTriggerSignature (sha256, defaults-applied, key-sorted canonical JSON).
- `common/src/types/memory-v2.ts`: additive playbook.* event kinds.
- `common/src/types/contracts/playbook-store.ts`: DI contract.
- `common/src/types/session-state.ts`: additive `playbookContext?: MemoryPlaybook[]`.
- `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts`: `memory_playbooks` table + `listPlaybooks`/`upsertPlaybookByTriggerSignature`/`recordPlaybookGateOutcome`/`setPlaybookStatus`/`ensureSeedPlaybooks` (seeds CI-before-git-committer, status active, enforcement warn).
- `packages/agent-runtime/src/memory/playbook-gate.ts` + `session-evidence-log.ts`: deterministic gate (mode off|warn|block default warn, kill-switch env; argv-token git classifier; parseAgentId-based version/publisher-aware agent match so a version pin cannot bypass; unknown evidence kinds fail closed; zero-cost fast path).
- `packages/agent-runtime/src/tools/tool-executor.ts`: pre-dispatch seam covering spawn_agents + spawn_agent_inline + run_terminal_command, fail-open.
- `sdk/src/services/memory-v2/coordinator.ts`: loads active playbooks into agentState.playbookContext at turn prep (fail-open) + stages/clones/clears it + `recordPlaybookGateOutcome` wrapper.
- `sdk/src/services/memory-v2/types.ts`: playbook methods added to MemoryRepositoryV2 (optional).

Tests: memory-playbook schema 5/5, playbook-gate 12/12, memory-playbooks store + two-session-cold-start green; typechecks green in common/cli/sdk/agent-runtime.

Deferred to Phase 3 (documented in code): emitting playbook.blocked/bypassed events from the coordinator (counters-only in Phase 1).

Next: Phase 2 (reserved read band + digest cold-start) per PLAN.md.
