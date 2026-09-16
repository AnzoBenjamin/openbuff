# STATUS — Persistent Codebase Understanding

Status: SPEC + PLAN frozen. Inventory in progress.
Current phase: INV -> A.
Current task: inventory precise targets.

## Progress

- SPEC.md created: two-store design (chunk code store + understanding memory), invariants, R-A/R-P0..P8.
- PLAN.md created: phased tasks A, P0-P8 with validation per phase.
- Next: inventory exact symbols/files, then Phase A chunk store.

## Validation receipts

- None yet.

## Resume

1. Read SPEC.md + PLAN.md in this session dir.
2. Continue at current-task pointer in PLAN.md.
3. After each phase record receipts here.

<!-- update_plan_status:appended -->

## Phase A + P0 + P1 + P2 + P4 + P5 + P6 landed — 2026-09-16T13:42:34.781Z

Chunk store (chunks.ts, structure root-skip fix, indexer chunks, CodeChunkSummary), P0 chunk selector + lexical-match, P1 enriched evidence capture, P2 verifyCapturedPaths best-effort hook, P4 coverage inference for validation tools, P5 lexical-match rename + chunk boost + selectorKey, P6 tiered verified excerpts. Validation observed green: common 42/42, code-map 21/21, indexer metadata 27/27, SDK coordinator+operator 59/59, CLI sqlite 49/49, agent-runtime context 9/9; code-map/indexer/common typechecks clean. Remaining: P7 memory-first DiscoveryMemoryPort wiring, P3 consolidation polish (already exists), P8 lifecycle docs + full matrix.

<!-- update_plan_status:appended -->
## P7 memory-first wiring verified — 2026-09-16T14:34:57.029Z

getVerifiedMemoryPaths + verifiedPaths plumbed through planDiscoveryBatch/recordDiscoveryResult and query-index/spawn-agents handlers. agent-runtime typecheck clean; discovery-coordinator + query-index 19/19 green. Behavior-preserving: optional param, empty set default.


<!-- update_plan_status:appended -->
## P3 consolidation polish + P8 lifecycle verified — 2026-09-16T14:36:45.700Z

P3: canonicalObservation now carries merged evidence (max 8, deterministic source order) + merged selectors (dedupe, max 5) + content-bearing summary/detail with facet. SDK typecheck clean; operator-service 24/24 green. P8: append-only canonical events, owner-only dirs 0o700 / files 0o600, rebuild guard with cursor checks, authority-flip rollback (json-v1/shadow-v2) preserved; typechecks clean across common/code-map/indexer/sdk/cli/agent-runtime.
