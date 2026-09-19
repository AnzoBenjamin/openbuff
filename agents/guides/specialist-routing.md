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

## Deterministic routing triggers

Post-edit reviewer-family routing is a pure deterministic function of (reviewable pending file paths, prompt text), computed by `selectSpecialistReviewers` (`common/src/agents/specialist-risk-router.ts`, mirrored inline in `agents/base2/base2.ts`). At runtime the orchestrator populates `params.orchestrationControlPlane.selectSpecialistReviewers` with that canonical export (`packages/agent-runtime/src/run-programmatic-step.ts`), so the inline mirror runs only as a fallback when the control plane is absent. Behavioral coverage lives in `agents/__tests__/specialist-risk-router.test.ts`, and inline-fallback parity is enforced by `agents/__tests__/specialist-router-parity.test.ts`. Identical inputs always produce the same routed set; the table below is the exact vocabulary the router matches against.

| Specialist               | Path signals                                                                                                                                                                                                                                                                     | Prompt (requirements) keywords                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- | ---------- | ----- | ------- | ----- | ----------- | ----- | ------- | --------- | ---- | ------- | ------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency-reviewer`    | Paths: `package.json`, `bun.lockb/bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `pyproject.toml`, `uv.lock`, `poetry.lock`, `cargo.toml/cargo.lock`, `go.mod/go.sum`, `gemfile(.lock)`, `composer.json/.lock`, `pom.xml`, `build.gradle(.kts)`, `package.swift` | Keywords: `dependency`, `dependencies`, `lockfile`, `package manager`, `supply chain`, `license`, `vulnerabilit*`                                                     |
| `migration-reviewer`     | Paths: directories/files named `migrations`/`schema`/`database`/`db` (segment or dot form), `*.sql`                                                                                                                                                                              | Keywords: `migration`/`migrations`, `backfill`, `schema change`, `database compatibility`, `rollback`                                                                 |
| `compatibility-reviewer` | Paths: `index.*`/`exports.*`/`public-api.*` files; `routes`/`config`/`schemas`/`types` directories                                                                                                                                                                               | Keywords: `public api`, `backward compat`, `breaking change`, `deprecat*`, `serialization`, `persisted format`, `config contract`, `environment variable`, `cli flag` |
| `reliability-reviewer`   | Paths: directory segments — a path segment equal to `queue(s)`, `worker(s)`, `job(s)`, `cache`, `session(s)`, `state`, `process`, `async`, or `concurrency` immediately followed by `/` (trailing slash required), OR a code file whose filename stem exactly equals `queue(s)   | worker(s)                                                                                                                                                             | job(s) | cache | session(s) | state | process | async | concurrency | retry | retries | scheduler | pool | lock(s) | timeout | abort | circuit`(code extensions only; compound stems like`retry-policy.ts`and data files like`state.json`never match).`.agents/sessions/\*\*` artifacts excluded | Keywords: `race`, `concurr*`, `retry`/`retries`, `cancel`, `abort`, `idempoten*`, `deadlock`, `state machine`, `resource leak`, `partial failure` |
| `performance-specialist` | Paths containing `bench`/`perf`/`load-test`/`profil`                                                                                                                                                                                                                             | Keywords: `performance`, `latency`, `throughput`, `benchmark`, `profil*`, `allocation`, `hot path`, `load test`, `complexity`                                         |
| `accessibility-reviewer` | A UI-ish file is ALWAYS required — there is no keyword-only route. UI-ish = path segment/dir `components`/`pages`/`views`/`screens`/`widgets`/`layouts`/`features`/`ui`/`app` or extension `tsx`/`jsx`/`vue`/`svelte`/`css`/`scss`/`html`/`astro`/`less`/`sass`/`styl`           | Keywords (all require a UI file): `accessibility`, `a11y`, `keyboard`, `focus`, `screen reader`, `aria`, `contrast`, `reduced motion`                                 |
| `ux-visual-reviewer`     | Same always-required UI-file rule as `accessibility-reviewer` (UI-ish = path segment/dir `components`/`pages`/`views`/`screens`/`widgets`/`layouts`/`features`/`ui`/`app` or extension `tsx`/`jsx`/`vue`/`svelte`/`css`/`scss`/`html`/`astro`/`less`/`sass`/`styl`)              | Keywords (all require a UI file): `visual`, `layout`, `responsive`, `design system`, `spacing`, `hierarchy`, `screenshot`, `viewport`, `interaction`                  |
| `product-reviewer`       | No path signal                                                                                                                                                                                                                                                                   | Keywords: `user-facing`, `acceptance criteria`, `product behavior`, `user flow`, `end-to-end`, `ux`, `onboarding`                                                     |
| `evaluator`              | No path signal                                                                                                                                                                                                                                                                   | Keywords: `independent evaluat*`, `score against`, `requirement coverage`                                                                                             |

### Why a specialist may not spawn

- No rule matched: the router returns an empty set and nothing spawns — silently, with no error.
- Observable outcomes are recorded in active-work state as `activeWorkState.lastReviewerGateSkipReason`; real values include `no-pending-changes-in-snapshot`, `specialist-terminal-failure`, `specialist-rate-limited`, `specialist-repair-no-progress`, and `specialist-no-verdict-budget-exhausted`.
- Fresh-credit suppression of an identical aux-relevant pending fingerprint is tracked via `specialistReviewGatesDone` + `specialistReviewGateFingerprints`.
- Mode roster differences (fast/plan withhold families).

Widening the vocabulary or path patterns in the router is the supported way to change routing — keep this table in sync with the router.

#### Widened vocabulary (kept in sync with `selectSpecialistReviewers`)

The router also matches these additional signals (added to reduce false negatives); they route to the same specialists as their row above:

- `reliability-reviewer` — stems: `mutex`, `semaphore`, `throttle`, `debounce`, `latch`, `barrier`, `channel`, `stream(s)`, `socket(s)`, `transaction(s)`, `saga`, `reconcile`, `reconciler`, `watchdog`, `heartbeat`. Keywords: `mutex`, `semaphore`, `throttl*`, `debounc*`, `livelock`, `lock contention`, `data race`, `atomic*`, `reentran*`, `backpressure`/`back-pressure`, `graceful shutdown`, `dropped event(s)`/`dropped message(s)`.
- `performance-specialist` — keywords: `memory leak`, `oom`, `regress*`, `slow*`, `bottleneck`, `cache miss`, `n+1`. Path: `flamegraph`.
- `compatibility-reviewer` — keywords: `backwards compat`, `wire format`, `api contract`, `schema version*`, `protocol version*`, `semver`, `feature flag`.
- `migration-reviewer` — keywords: `data migration`, `reindex*`, `data backfill`, `dual-write`/`dual write`.
- `dependency-reviewer` — keywords: `cve`, `sbom`, `transitive dep*`, `peer dep*`.

## Gate vs Specialists

Ownership and timing — Final Gate always runs last; specialist gates are scoped auxiliaries that run in the aux phase before it.

| Dimension   | Final Gate (`code-reviewer`)                                        | Specialist Gates (reviewer-family + `security-reviewer`)                                                                                    |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership   | Orchestrator final gate; owns overall correctness and ship decision | Scoped risk dimension (perf, reliability, migration, etc.)                                                                                  |
| Timing      | After all aux gates and file-change hooks                           | Aux phase before final gate; batched when routed                                                                                            |
| Blocking    | Blocks release on any finding                                       | Blocks only its scoped dimension                                                                                                            |
| Spawn       | Runtime-owned; always runs with non-empty pending set               | Runtime-routed via `selectSpecialistReviewers` / `matchesSecuritySensitiveGlob`; manual only for pre-edit advisory or explicit user request |
| Attestation | Gate-assigned opaque `v3:<64-hex>` token                            | Same gate token family; see Params Contract below                                                                                           |

## Params Contract

`params.snapshot_id` is optional in the reviewer-family schema, but only one mode is valid per spawn. Runtime-owned programmatic spawns pass the gate-assigned opaque `v3:<64-hex>` token; manual spawns omit `params.snapshot_id` entirely. Never substitute the bare hex `snapshotId` from `get_change_review_bundle` — when the key is supplied it must be the opaque `v3:<64-hex>` token from the parent gate.

| Specialist family                                                                                                                                                                                                          | Required `params`                                                                                                     | On mismatch                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer-family (`product-reviewer`, `performance-specialist`, `reliability-reviewer`, `migration-reviewer`, `compatibility-reviewer`, `accessibility-reviewer`, `ux-visual-reviewer`, `dependency-reviewer`, `evaluator`) | `params.snapshot_id` = `v3:<64-hex>` (opaque gate token) for runtime-owned spawns; omitted entirely for manual spawns | Spawn fails: when supplied, a wrong value or bare hex instead of `v3:<64-hex>` fails; manual spawns that supply any value fail |
| `security-reviewer` (exception)                                                                                                                                                                                            | `params.changed_files` + `params.snapshot_fingerprint` (required on manual spawns too)                                | Spawn fails; does not accept `params.snapshot_id`; omitting the schema-required `snapshot_fingerprint` also fails              |

Manual/advisory reviewer-family spawns must OMIT `params.snapshot_id` entirely. The gate-assigned `v3:<64-hex>` token is only minted for runtime-owned programmatic spawns; a prompt-authored spawn call cannot obtain one, and display fingerprints in gate blocks or telemetry are truncated 16-char prefixes that never satisfy `^v3:[a-f0-9]{64}$`. No caller-facing guidance may tell a manual reviewer-family spawner to require, hunt for, or supply a gate-owned token: manual caller guidance always states the omit-for-manual contract (put the scoped file list in `params.files` and the review question in the prompt). `security-reviewer` is the documented exception: its schema still requires `params.changed_files` + `params.snapshot_fingerprint` on manual spawns, so a manual caller passes both keys and supplies as `snapshot_fingerprint` the stable fingerprint value it wants echoed exactly — the schema imposes no `^v3:` pattern on that key, so the caller never needs a gate-owned token; omitting the key fails the spawn.

## Example spawns

```text
# reviewer-family (advisory pre-edit) — no token is passed on manual spawns
spawn product-reviewer
  params.files: ["src/example.ts"]  # snapshot_id omitted entirely on manual spawns; the gate-assigned v3 token is only minted for runtime-owned spawns
```

```text
# security-reviewer (exception) — the schema-required fingerprint is passed on manual spawns too
spawn security-reviewer
  params.changed_files: ["src/auth/login.ts", "src/auth/session.ts"]
  params.snapshot_fingerprint: "<stable fingerprint value to echo>"  # schema-required on every spawn; no v3 pattern is imposed, so a manual caller supplies its own stable value
```

```text
# batching routed specialists (runtime-owned aux step)
spawn_agents [
  { id: "perf", agent: "performance-specialist", params: { snapshot_id: "v3:<64-hex>" } },
  { id: "rel",  agent: "reliability-reviewer",   params: { snapshot_id: "v3:<64-hex>" } }
]
```

## Compaction recovery

After `context-pruner` / compaction do not re-derive or re-mint any `v3:<64-hex>` token for a manual specialist spawn — the gate-assigned token is only available to runtime-owned programmatic spawns, and hand-rolled recomputation never attests. Do not manually re-spawn reviewer-family specialists: wait for the runtime-owned Final Gate result. A manual reviewer-family spawn, when explicitly requested, must omit `params.snapshot_id` entirely; never pass a stale bundle hex, a stale pre-compaction `snapshot_id`, or a truncated display prefix. `security-reviewer` keeps its schema-required `params.snapshot_fingerprint` on manual spawns; supply a stable value to echo rather than re-deriving a gate-owned token.

## Sequential vs parallel

Aux gates are sequential and blocking; specialists within a single aux step may run in parallel.

| Combination                                                                                           | Allowed?                  | Notes                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| Routed specialists in one `spawn_agents` batch                                                        | Yes                       | Parallel within the specialist aux step; join before hooks + final gate                   |
| Aux steps: `test-writer` → `doc-writer` → `security-reviewer` → specialists → hooks + `code-reviewer` | No — sequential by design | Each step waits for the prior; re-enters validation so next gate sees updated pending set |
| Specialists or `security-reviewer` in parallel with Final Gate                                        | No                        | Final gate runs only after all aux specialists complete                                   |
| `editor` / `repair-editor` in parallel with specialists on same pending set                           | No                        | Finish implementation/repair first; specialists attest to a stable snapshot               |

For `editor`, `repair-editor`, `test-writer`, and `doc-writer` spawn rules, aux-gate ordering, writer prompt predicates, and parallel join discipline, see `agents/guides/editor-writers-and-repair.md`.
