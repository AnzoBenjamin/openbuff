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

Pass the exact params contract or the spawn fails. Do not substitute the bare hex `snapshotId` from `get_change_review_bundle` — reviewer-family requires the opaque `v3:<64-hex>` token from the parent gate.

| Specialist family                                                                                                                                                                                                          | Required `params`                                        | On mismatch                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Reviewer-family (`product-reviewer`, `performance-specialist`, `reliability-reviewer`, `migration-reviewer`, `compatibility-reviewer`, `accessibility-reviewer`, `ux-visual-reviewer`, `dependency-reviewer`, `evaluator`) | `params.snapshot_id` = `v3:<64-hex>` (opaque gate token) | Spawn fails: missing or wrong key, or bare hex instead of `v3:<64-hex>` |
| `security-reviewer` (exception)                                                                                                                                                                                            | `params.changed_files` + `params.snapshot_fingerprint`   | Spawn fails; does not accept `params.snapshot_id`                       |

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

| Combination                                                                                           | Allowed?                  | Notes                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| Routed specialists in one `spawn_agents` batch                                                        | Yes                       | Parallel within the specialist aux step; join before hooks + final gate                   |
| Aux steps: `test-writer` → `doc-writer` → `security-reviewer` → specialists → hooks + `code-reviewer` | No — sequential by design | Each step waits for the prior; re-enters validation so next gate sees updated pending set |
| Specialists or `security-reviewer` in parallel with Final Gate                                        | No                        | Final gate runs only after all aux specialists complete                                   |
| `editor` / `repair-editor` in parallel with specialists on same pending set                           | No                        | Finish implementation/repair first; specialists attest to a stable snapshot               |

For `editor`, `repair-editor`, `test-writer`, and `doc-writer` spawn rules, aux-gate ordering, writer prompt predicates, and parallel join discipline, see `agents/guides/editor-writers-and-repair.md`.
