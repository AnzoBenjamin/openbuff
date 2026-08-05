# Specialist Routing

Use specialists when repository evidence or the requested outcome crosses one of these risk boundaries. This applies in DEFAULT, PLAN, and EXECUTE_PLAN modes; planning and resumed execution need the same expert access as implementation.

- Architecture or public boundary decisions → `architect`; requirement/acceptance ambiguity or end-to-end reachability → `product-reviewer`.
- Independent branches, patches, worktrees, or conflicting implementations → `integration-agent`.
- Benchmarks, hot paths, latency, throughput, or allocations → `performance-specialist`; races, retries, cancellation, idempotency, or state machines → `reliability-reviewer`.
- Schema/data changes or backfills → `migration-reviewer`; exported APIs, serialization, CLI/config/env contracts, or persisted formats → `compatibility-reviewer`.
- UI keyboard/focus/semantic/assistive behavior → `accessibility-reviewer`; visual hierarchy, responsive layout, screenshots, or design-system behavior → `ux-visual-reviewer`.
- Manifest/lockfile/provenance/license/vulnerability concerns → `dependency-reviewer`; multi-component failures and competing hypotheses → `incident-coordinator`.
- Explicit release/version/tag/package/CI work → `release-manager`; documentation architecture/coverage → `docs-architect`; independent requirement scoring → `evaluator`.

Gather the exact source and snapshot evidence before spawning. Advisory specialists inform the plan; reviewer specialists can block their scoped risk dimension. They complement rather than replace targeted validation and the final code-reviewer gate.

Post-edit reviewer-family specialists are routed automatically by the orchestrator's gate. Do not manually re-spawn them after edits, after compaction, or merely because set_output is unavailable; wait for the runtime-owned gate result. Manual specialist calls are for pre-edit advisory work or an explicit user request. When you do spawn one, pass its exact params contract: reviewer-family specialists (product-reviewer, performance-specialist, reliability-reviewer, migration-reviewer, compatibility-reviewer, accessibility-reviewer, ux-visual-reviewer, dependency-reviewer, evaluator) require params.snapshot_id set to the gate-assigned opaque `v3:…` token from the parent gate (not the bare hex `snapshotId` from `get_change_review_bundle`). security-reviewer is the exception: it requires params.changed_files plus params.snapshot_fingerprint and does not accept snapshot_id. Spawning with the wrong or missing snapshot key fails the spawn.
