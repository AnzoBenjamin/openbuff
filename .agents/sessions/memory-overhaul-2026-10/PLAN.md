# PLAN: Memory Overhaul Implementation

> **Reconciled 2026-10-24 against the working tree** (evidence-based file/symbol inspection, not commit-history trust): items ticked below with `<!-- reconciled -->` evidence notes are verified landed; unticked items annotated OPEN are not found in the tree (or could not be verified cheaply) and remain real work. Phases 2–4 remain OPEN (no evidence in tree).

<!-- current-task: P1-T1 playbook schema + contract types -->

## Phase 1 — Vertical slice: playbook store + deterministic gate (independently valuable: fixes the CI-check failure)
- [x] P1-T1 <!-- reconciled 2026-10-24: common/src/types/memory-playbook.ts exists --> `common/src/types/memory-playbook.ts`: PlaybookTriggerSchema (tool enum, spawnAgentType, terminalAction argv-class enum, requireEvidence array ≤8 with kind toolSucceeded|fileDigestUnchanged|claimPinned|observationPresent, commandPattern, withinMs, path), PlaybookSchema (ids, title, instruction, trigger, scope{repos,glob,agentTypes}, status candidate|active|verified|retired, enforcement block|warn|inject-only, counters, provenance, triggerSignature, expiresAt), payloadSchemaVersion 1, zod strict. Add `playbook.blocked|bypassed|proposed|activated|retired` event kinds additively in common/src/types/memory-v2.ts.
- [x] P1-T2 <!-- reconciled 2026-10-24: common/src/types/contracts/playbook-store.ts (upsertByTriggerSignature) exists --> `common/src/types/contracts/playbook-store.ts`: DI contract (upsertByTriggerSignature, listActive, recordGateOutcome, bumpCounters).
- [x] P1-T3 <!-- reconciled 2026-10-24: store landed in-substance in cli/src/services/memory-v2/bun-sqlite-memory-repository.ts (playbooks persisted; cli/knowledge 2026-10-20), not at the planned sdk path --> `sdk/src/services/memory-v2/playbook-store.ts`: SQLite-backed store (new table in the memory-v2 DB migration path), triggerSignature dedup/upsert, write-time trigger validation (reject non-evaluable), seed default playbook migration (ci-before-git-committer, enforcement 'warn' initially).
- [x] P1-T4 <!-- reconciled 2026-10-24: packages/agent-runtime/src/memory/playbook-gate.ts + session-evidence-log.ts exist; gate tests green --> `packages/agent-runtime/src/memory/playbook-gate.ts` + `session-evidence-log.ts`: SessionPlaybookIndex (load once per step, version-bump refresh), trigger matcher (normalized agent-type compare reusing filterSpawnAgentsGate normalization; argv-token terminal classifier for git push/commit/stage), evidence checks against SessionEvidenceLog (toolSucceeded w/ commandPattern+withinMs), block/warn outcome with actionable message, kill-switch env, bypass counter path.
- [x] P1-T5 <!-- reconciled 2026-10-24: tool-executor.ts carries the playbook seam (23 playbook refs) --> `packages/agent-runtime/src/tools/tool-executor.ts` seam: one `playbookGate.evaluate` call in the pre-dispatch block after 2563-2580 covering spawn_agents + spawn_agent_inline + run_terminal_command; post-dispatch hook feeds SessionEvidenceLog; playbook.blocked/bypassed events appended.
- [x] P1-T6 <!-- reconciled 2026-10-24: playbook-gate + repository suites green (re-run 2026-10-24) --> Tests: gate unit tests (match/evidence/scope/kill-switch/alias-bypass/dry-run-no-block), store upsert-dedup + write-time rejection tests, seed playbook E2E fixture (block once → run check:ci-local → allowed), append-only-log invariant test.

## Phase 2 — Read side: reserved band + decision-point injection + digest cold-start
- [ ] P2-T1 `packages/agent-runtime/src/memory/playbook-context.ts`: reserved `<active_playbooks>` band (≤8, ≤1500 chars, deterministic triggerSignature order), consumed at run-agent-step.ts:2216-2247 as sibling of memory-v2 compile.
- [ ] P2-T2 Route `claim.pinned` into the band; gate "allowed" confirmations into step context.
- [ ] P2-T3 `packages/agent-runtime/src/memory/digest-ledger.ts` + `file_knowledge` projection + coordinator query extension: digest match ⇒ inject `<verified_knowledge>` + skip note; mismatch ⇒ rereadRequired.
- [ ] P2-T4 Tests: clipping-impossibility invariant, band order stability, cold-start digest-match skip / mismatch-rereadRequired (extend two-session-cold-start).

## Phase 3 — Write-side hygiene
- [ ] P3-T1 Content-hash dedup at coordinator.ts:1499 (`observation_fingerprints` index, TTL'd, emits observation.deduped).
- [ ] P3-T2 Lifecycle-event gating at coordinator.ts:2025-2135 (significance + per-turn budget, coalesced turn.lifecycle).
- [ ] P3-T3 Auto-compaction trigger at turn-finalize (every N turns / row threshold; skip workspaces with open task).
- [ ] P3-T4 TTL extensions + duplicate-body storage removal (bun-sqlite-memory-repository.ts:3030-3034); staled-weight producer for usefulness-scorer (:4717).
- [ ] P3-T5 Tests: dedup collapse rate, compaction threshold + log invariant, TTL sweep.

## Phase 4 — Evals & learning loop
- [ ] P4-T1 `evals/memory-behavior/`: A/B deterministic fixture (scripted model), gate-block-then-correct rate, tokens-wasted, false-positive suite in CI; README claims behavior.
- [ ] P4-T2 Gate-block-event → candidate-playbook promotion; lessons-extraction producer; `/memory playbooks` CLI report.

## Validation gates (per phase)
- common: `cd common && bun run typecheck && bun test`
- sdk: `cd sdk && bun run typecheck && bun test src/services/memory-v2`
- agent-runtime: `cd packages/agent-runtime && bun run typecheck && bun test src/memory src/tools`
- agents/evals regression: two-session-cold-start, compaction-retention eval suites.
- Runtime hooks + reviewer gate per edit wave (harness-owned).

## Risks
1. Gate false positives → Phase 1 ships `warn` default; false-positive suite before `block`.
2. Digest staleness races → sha256 content (not metadata), verify at read-attempt time, rereadRequired fail-safe.
3. Band budget drift → hard cap + utilization telemetry next to 12k compile.
4. Migration safety: playbook table must be additive (new table, no alteration of existing projections).
