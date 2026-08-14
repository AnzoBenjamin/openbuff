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

Post-edit reviewer-family specialists are routed automatically by the orchestrator's gate. Do not manually re-spawn them after edits, after compaction, or merely because set_output is unavailable; wait for the runtime-owned gate result. Manual specialist calls are for pre-edit advisory work or an explicit user request.

## Gate vs Specialists

Ownership and timing — Final Gate always runs last; specialist gates are scoped auxiliaries that run in the aux phase before it.

| Dimension | Final Gate (`code-reviewer`) | Specialist Gates (reviewer-family + `security-reviewer`) |
| --- | --- | --- |
| Ownership | Orchestrator final gate; owns overall correctness and ship decision | Scoped risk dimension (perf, reliability, migration, etc.) |
| Timing | After all aux gates and file-change hooks | Aux phase before final gate; batched when routed |
| Blocking | Blocks release on any finding | Blocks only its scoped dimension |
| Spawn | Runtime-owned; always runs with non-empty pending set | Runtime-routed via `selectSpecialistReviewers` / `matchesSecuritySensitiveGlob`; manual only for pre-edit advisory or explicit user request |
| Attestation | Gate-assigned opaque `v3:<64-hex>` token | Same gate token family; see Params Contract below |

## Params Contract

Pass the exact params contract or the spawn fails. Do not substitute the bare hex `snapshotId` from `get_change_review_bundle` — reviewer-family requires the opaque `v3:<64-hex>` token from the parent gate.

| Specialist family | Required `params` | On mismatch |
| --- | --- | --- |
| Reviewer-family (`product-reviewer`, `performance-specialist`, `reliability-reviewer`, `migration-reviewer`, `compatibility-reviewer`, `accessibility-reviewer`, `ux-visual-reviewer`, `dependency-reviewer`, `evaluator`) | `params.snapshot_id` = `v3:<64-hex>` (opaque gate token) | Spawn fails: missing or wrong key, or bare hex instead of `v3:<64-hex>` |
| `security-reviewer` (exception) | `params.changed_files` + `params.snapshot_fingerprint` | Spawn fails; does not accept `params.snapshot_id` |

## Example spawns

```text
# reviewer-family (advisory pre-edit) — requires gate token
spawn product-reviewer
  params.snapshot_id: "v3:<64-hex>"  # opaque token from parent gate, not bare hex snapshotId
```

```text
# security-reviewer (exception) — requires files + fingerprint
spawn security-reviewer
  params.changed_files: ["src/auth/login.ts", "src/auth/session.ts"]
  params.snapshot_fingerprint: "<fingerprint from gate>"  # never snapshot_id
```

```text
# batching routed specialists (runtime-owned aux step)
spawn_agents [
  { id: "perf", agent: "performance-specialist", params: { snapshot_id: "v3:<64-hex>" } },
  { id: "rel",  agent: "reliability-reviewer",   params: { snapshot_id: "v3:<64-hex>" } }
]
```

## Compaction recovery

After `context-pruner` / compaction the prior bundle hex is stale. Recompute the gate fingerprint from the fresh `get_change_review_bundle` and re-derive `v3:<64-hex>` before any manual specialist spawn. Do not reuse a stale bundle hex or a pre-compaction `snapshot_id` — the gate will reject it and the finding will not attest to the current pending set.

## Sequential vs parallel

Aux gates are sequential and blocking; specialists within a single aux step may run in parallel.

| Combination | Allowed? | Notes |
| --- | --- | --- |
| Routed specialists in one `spawn_agents` batch | Yes | Parallel within the specialist aux step; join before hooks + final gate |
| Aux steps: `test-writer` → `doc-writer` → `security-reviewer` → specialists → hooks + `code-reviewer` | No — sequential by design | Each step waits for the prior; re-enters validation so next gate sees updated pending set |
| Specialists or `security-reviewer` in parallel with Final Gate | No | Final gate runs only after all aux specialists complete |
| `editor` / `repair-editor` in parallel with specialists on same pending set | No | Finish implementation/repair first; specialists attest to a stable snapshot |

For `editor`, `repair-editor`, `test-writer`, and `doc-writer` spawn rules, aux-gate ordering, writer prompt predicates, and parallel join discipline, see `agents/guides/editor-writers-and-repair.md`.
