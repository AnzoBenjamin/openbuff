# SPEC: Memory System Overhaul — Procedural Memory + Deterministic Enforcement

## Problem (owner complaints, evidence-backed)
1. **Memory does not change behavior.** Recurring failure: forgetting the CI check (`bun run check:ci-local`) before spawning git-committer / pushing. Evidence: memory is strictly pull-based (recall-context.ts:23-42), `run_terminal_command` output is dropped from memory entirely (sdk coordinator.ts:1359-1373), and no gate ever consults memory before high-stakes tools.
2. **Bloated / inefficient.** Unbounded event log + projections (bun-sqlite-memory-repository.ts:2908-2963), no content dedup for ~20 read/search tools (digest exists at coordinator.ts:1499 but unused for dedup), 3-7 unconditional lifecycle events per turn (coordinator.ts:2025-2135), GC near-unreachable (compaction-eligibility.ts:22-25), compaction is a manual operator command never called in the turn lifecycle.
3. **Cold-start re-reads.** Digest-verified knowledge exists only for explicitly recorded observations; read tools do not capture content digests, so every session re-reads files.
4. **No behavior-change eval.** evals/memory-retention README:70-74 explicitly disclaims behavior claims.

## Goals
- G1: First-class **procedural memory** (playbooks: machine-evaluable condition→action rules) with **deterministic enforcement** at the tool pre-dispatch seam — the CI-check-before-git-committer case works end-to-end.
- G2: **Read-side guarantee**: procedural rules can never be silently clipped; injected as a reserved band outside the 12k memory-v2 budget.
- G3: **Write-side hygiene**: content-hash dedup, lifecycle-event gating, automatic compaction trigger, TTL policy, duplicate-body storage removal.
- G4: **Cold-start efficiency**: file-digest ledger so prior verified knowledge maps to content hashes; digest match ⇒ skip re-read + inject prior analysis; digest mismatch ⇒ rereadRequired (existing demotion semantics).
- G5: **Behavior-change eval** (`evals/memory-behavior/`) measuring gate-block-then-correct rate on a deterministic fixture.
- G6: All enforcement works with ANY user model (BYOK): deterministic gates own high-stakes decisions; prompts are advisory.

## Non-goals
- No hosted backend / server components.
- No change to the append-only event-log invariant (ABORT triggers stay).
- No rewrite of the 12k memory-v2 compile budget (carve-out instead).
- base2.ts handleSteps stays serialized; runtime-side seams only.

## Architecture decisions (from ADR, thinker-verified against source)
- Playbook = **parallel first-class store** (not a new observation kind): machine-evaluable trigger predicates cannot live in LLM-shaped observation text; needs synchronous keyed lookup; emits `playbook.*` events into the existing append-only log as facts about the store.
- Enforcement = **tool-executor pre-dispatch gate** (tool-executor.ts:2563-2580 seam, filterSpawnAgentsGate:279-318 as pattern) covering `spawn_agents`, `spawn_agent_inline` (~3021), `run_terminal_command`; prompt injection is advisory only.
- Trigger matching = structured argv-token classification + normalized agent-type comparison (no regex over prose); write-time validation rejects any playbook the gate cannot deterministically evaluate.
- Block carries actionable message + playbookId (GIT_COMMITTER_WITHHELD_USER_MESSAGE pattern, autoRecovering).
- False-positive controls: scope keying, withinMs evidence staleness, expiresAt, kill-switch env `OPENBUFF_PLAYBOOK_GATE=off|warn|block`, counted bypass, empty-index zero-cost pass-through.
- Lifecycle: candidate(warn) → active(block) → verified → retired; counters (fired/blocked/compliedAfterBlock/falsePositives/bypassed) are the effectiveness oracle.
- Read side: reserved `<active_playbooks>` band (≤8 playbooks, ≤1,500 chars, deterministic order by triggerSignature), assembled independently of the 12k budget; `claim.pinned` routed into the same band.
- Cold start: DigestLedger on read-tool post-dispatch; `file_knowledge` projection (workspaceId, path, contentDigest, observationIds, verifiedAt); lazy stat+hash only when a read is attempted.

## Acceptance criteria
- A1: With an active `ci-before-git-committer` playbook, a spawn_agents(git-committer) call without a successful matching CI command in-session is BLOCKED with an actionable message; after a successful `bun run check:ci-local`, the same spawn is allowed.
- A2: Gate default is `warn` in Phase 1 shipping config, `block` available; kill-switch env honored (unit-tested).
- A3: No regression: two-session-cold-start, compaction-retention evals, all package test suites green.
- A4: Append-only event log invariant preserved under playbook events (test).
- A5: `<active_playbooks>` band appears in compiled context whenever ≥1 active scoped playbook exists, and is outside the 12k budget (Phase 2 test).
- A6: Behavior eval arm A blocks once then observes correction; arm B reproduces the bug (Phase 4).

## Session artifacts
- findings/: 4 audit shard reports (cli-store.md, sdk-coordinator.md, runtime-recall.md, types-evals.md), snapshot 1d150eb5.
- This SPEC + PLAN.md + STATUS.md.
