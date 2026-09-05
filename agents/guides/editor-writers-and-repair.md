# Editor, Writers, and Repair (Public Spawn Contract)

How `editor`, `repair-editor`, `test-writer`, and `doc-writer` relate under base2, when the runtime spawns them automatically, and what may run in parallel.

This is the live public contract from the orchestrator gate and agent templates. It does not invent spawn conditions beyond what base2 and the agent definitions enforce.

## Roster availability (mode gates)

| Agent           | Default implementation | Fast                                      | Plan-only     |
| --------------- | ---------------------- | ----------------------------------------- | ------------- |
| `editor`        | Spawnable              | Not spawnable (inline `edit_transaction`) | Not spawnable |
| `repair-editor` | Spawnable              | Not spawnable                             | Not spawnable |
| `test-writer`   | Spawnable              | Spawnable                                 | Not spawnable |
| `doc-writer`    | Spawnable              | Spawnable                                 | Not spawnable |

Implementation modes that still run the automated validation/reviewer gate use the aux + repair paths below. Fast / no-validation / plan-only skip that automated gate; plan mode remains read-only for mutation agents.

## Role split

| Agent           | Owns                                                                                                                                                                                                                                                                                                           | Does not own                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `editor`        | Non-trivial **implementation** edits after discovery. Self-contained handoff only. Mutates via `edit_transaction`.                                                                                                                                                                                             | Validation, basher, review, git, todos, visual smoke, shell cleanup. Parent-only work stays with the orchestrator.                        |
| `repair-editor` | **Finding-scoped** fixes: parseable validation diagnostics or stable reviewer finding IDs. Same edit surface as editor plus `read_subtree` for diagnosis.                                                                                                                                                      | Unrelated refactors, docs, feature work, or protocol/attestation failures (snapshot mismatch is not a source repair).                     |
| `test-writer`   | New/extended tests under existing test paths only (`*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`). Mutates via `edit_transaction` (use `str_replace` / `create` / `write_file` edit _types_ inside the transaction; never as standalone tools). Reports `requestedValidation` for the parent/basher. | Production source (except when a test is unobservable without a minimal source change — still not the default). Running terminals itself. |
| `doc-writer`    | Documentation paths only (`docs/**`, `README*`, `**/*.md`, `**/*.mdx`). Mutates via `edit_transaction` (use `str_replace` / `create` / `write_file` edit _types_ inside the transaction; never as standalone tools). Verifies against source; never invents API behavior.                                      | Production source edits.                                                                                                                  |

All four use structured `set_output` receipts. Writers expose `status`, `completionKind` (`changed` \| `noop`), `changedFiles`, and `evidence`. The runtime accepts writer receipts only when status is `completed` and either:

- `completionKind=changed` with non-empty `changedFiles`, or
- `completionKind=noop` with empty `changedFiles` and non-empty `evidence`.

Empty or partial output blocks finalization for automated writer spawns and marks **reduced assurance** rather than looping forever.

`set_output` itself is for **spawned subagents**. The root orchestrator must not call it; absence from the root toolset is expected. Nested `{ output: { status, ... } }` is accepted for editor-family agents when the nested object matches the agent schema.

## Manual spawn (orchestrator)

Use phase-triggered delegation, not random spawns:

- **`editor`** — after discovery for non-trivial source changes in default mode. Prompt must be implementation-only: Requirements, Target files, Constraints/non-goals, Patterns, Risks. Omit parent-only work.
- **Direct orchestrator edit** — narrow exception only: one file, roughly ≤12 lines, no behavior/public-contract change, no required tests, no security/concurrency risk, no open reviewer findings. Otherwise use `editor`.
- **`repair-editor`** — validation/reviewer repairs with exact diagnostics or finding IDs. Prefer runtime-owned repair loops over free-form re-edits when the gate already owns the findings.
- **`test-writer` / `doc-writer`** — when documentation or test coverage is required or directly implied by acceptance criteria. Pass `params.target_files` / `params.source_files` (and `test_command` / optional `target_doc_files`) plus a self-contained verified contract in the prompt; writers do not inherit parent history.

## Automated aux gates (pre-reviewer)

When the automated gate is on and edits produced a non-empty pending file set, base2 runs **pre-reviewer aux work once per distinct aux-relevant pending set**, then the final hooks + `code-reviewer` gate.

**Order (sequential, blocking):**

1. `test-writer` (predicate-gated)
2. `doc-writer` (predicate-gated)
3. `security-reviewer` (security-sensitive pending paths)
4. Routed reviewer-family specialists (batched where selected)
5. File-change hooks + final `code-reviewer`

Each aux step uses `spawn_agent_inline` (or `spawn_agents` for specialist batches / repair). The generator **waits** for the child before the next gate. After any aux spawn fires, the loop re-enters so validation/review sees writer outputs in the pending set.

Done-flags (`testWriterGateDone`, `docWriterGateDone`, …) reset only when the **aux-relevant** pending subset changes — not when writer outputs (new tests/docs) join pending. That prevents infinite re-spawn loops.

### Aux predicate truth table (when each aux gate fires)

| Agent               | Fires when (predicate)                                                                                                      | Skips when                                             | Example trigger file                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `test-writer`       | `selectTestWriterTargets` non-empty: non-test source with inferable `test_command` + prompt mentions `test`/`test coverage` | Prompt lacks test intent or no eligible source/command | `packages/<pkg>/src/bar.ts`         |
| `doc-writer`        | `selectDocWriterTargets` non-empty: public-API source + prompt mentions `docs`/`documentation`/`readme`/`guide`             | Prompt lacks docs intent or no public-API source       | `packages/<pkg>/src/index.ts`       |
| `security-reviewer` | `matchesSecuritySensitiveGlob` matches pending path                                                                         | No security-sensitive pending paths                    | `src/auth/*`                        |
| specialists         | `selectSpecialistReviewers` routes ≥1 specialist                                                                            | No specialist routing match                            | `apps/web/src/payments/checkout.ts` |

### When automated `test-writer` runs

All of the following must hold:

1. Validation gate is active, edits happened, and pending gate files are non-empty.
2. **User prompt requires tests** — positive match on add/write/update/fix/increase/improve + `test(s)` or `test coverage`, and **not** a nearby “do not / don't / without / no … tests|test coverage” negation.
3. Target selection yields at least one group: non-test source files with an inferable package test command (monorepo package roots, ecosystem fallbacks such as `bun test` / `pytest` / `go test`, or project-aware `get_affected_tests` + `get_build_targets` when the prompt requires tests).

If the prompt does not require tests, or there are no eligible source targets, the gate marks the test-writer step done and **skips silently**.

After a successful writer receipt, the parent may run the group’s `test_command` via basher. Crash, incomplete receipt, or failed validation → reduced assurance and continue (no infinite retry).

**Coverage-only reviewer findings:** if the final code-reviewer returns blockers that are **all** pure test-coverage gaps, the harness routes repair to **`test-writer`**, not `repair-editor`. Mixed or code findings still use `repair-editor`.

### When automated `doc-writer` runs

All of the following must hold:

1. Validation gate is active, edits happened, and pending gate files are non-empty.
2. **User prompt requires docs** — match on `docs` / `documentation` / `document` / `readme` / `guide`, without a nearby negation of those terms.
3. `selectDocWriterTargets` keeps **public API source files** only (non-test source under the usual extensions; excludes tests, docs, evals, `.agents/`, generated files, pure config/markdown).

Write scope for the automated handoff is **package-rooted** from those source paths (`docs/**`, `README*`, `**/*.md`, `**/*.mdx` under each inferred workspace root). The agent may **read** the whole repo to verify contracts; it may **write** only documentation paths. It does not blanket-update every markdown file in the monorepo — targets follow the changed public sources and neighboring doc layout.

If docs are not required in the prompt or no public-API sources are pending, the step is marked done and skipped.

### Why writers often “never spawn”

- Automated spawns are **prompt-gated**: ordinary “implement feature X” without an explicit tests/docs requirement will not fire the aux writers.
- Eligible **source** must exist in the pending set (tests/docs alone do not re-trigger the same aux cycle).
- Plan mode withholds both writers; fast mode still has them on the roster but only under the same prompt/target predicates when the gate runs.
- Manual spawns still require a complete params/handoff envelope; missing structured receipts fail the automated gate’s acceptance checks.
- Prefer stating tests/docs in the user request or acceptance criteria when those deliverables are required — that is the intended trigger, not hoping the gate invents coverage work.

## Repair loops (after validation or review)

| Trigger                               | Repair agent                               | Parallelism                                                                       |
| ------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Parseable file-change hook failures   | `repair-editor` with `VF-*` finding IDs    | Sequential: hooks → repair → re-hooks                                             |
| Security-reviewer blockers            | `repair-editor` on open security findings  | After security aux; then re-validation + fresh security review                    |
| Specialist blockers                   | `repair-editor` per specialist finding set | Specialists may have been batched; repair for a blocking specialist is sequential |
| Code-reviewer blockers (code)         | `repair-editor`                            | After final review; then hooks + re-review                                        |
| Code-reviewer blockers (all coverage) | `test-writer`                              | Same sequential repair → hooks → re-review path                                   |

Repair budgets may be unlimited by default or capped via createBase2 / env (`OPENBUFF_MAX_REPAIR_ROUNDS`, `OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS`, `OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS`). Incomplete receipts, crashes, or **no snapshot-visible progress** fail closed and stop automatic retry.

## Cohesion: can they work in parallel?

**Yes, with hard join rules:**

| Combination                                                            | Allowed?                                            | Notes                                                                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context agents (file-picker, researchers) in parallel                  | Yes                                                 | Bounded waves ≤8 per `spawn_agents` call; join before dependent edits.                                                                                |
| Multiple bashers for independent validation commands                   | Yes                                                 | Join all results before finalizing. Sequential if command B depends on A.                                                                             |
| Static `code-reviewer` / specialists **with** validation still running | Only if review is explicitly validation-independent | Parallel approval is **not** final until validation completes. Prefer validation first for fragile harness/editor work, then review with the summary. |
| Routed specialists in one `spawn_agents` batch                         | Yes (runtime-owned)                                 | Gate batches selected specialists; attestation/retry is gate-owned.                                                                                   |
| Aux `test-writer` then `doc-writer` then security                      | **No** (by design)                                  | Sequential blocking yields so each sees a stable pending set.                                                                                         |
| Aux + final `code-reviewer`                                            | **No** (by design)                                  | Final gate after aux; file-change hooks + `code-reviewer` run only after aux/specialists complete.                                                    |
| `editor` and `test-writer` on the same change without a join           | **No**                                              | Implementation must land before coverage writers or coverage-repair can target real source.                                                           |
| `editor` and `repair-editor` on the same findings                      | **No**                                              | Repair owns open gate findings; do not race a second implementation editor over the same IDs.                                                         |
| Root `edit_transaction` while repair-editor runs                       | Avoid                                               | Fragile debug/fix loops should be read → one edit path → validation, sequential.                                                                      |

General rule from the orchestrator: **parallelize context, independent tests, and static review only when they do not depend on each other.** During a fragile repair loop, stay sequential.

## Handoff shape (writers)

Automated and manual writer spawns should carry a typed handoff: task ID, objective, requirements, acceptance criteria, context paths with confidence, invariants (`Do not modify production source files.` for pure writers), permissions, and success criteria.

Minimal manual examples:

```text
spawn test-writer
  prompt: focused tests for <behavior>; framework matches package
  params.target_files: ["packages/foo/src/bar.ts"]
  params.test_command: "cd packages/foo && bun test"
```

```text
spawn doc-writer
  prompt: document public contract of <API>; match agents/guides style
  params.source_files: ["packages/foo/src/bar.ts"]
  params.target_doc_files: ["packages/foo/README.md"]  # optional
```

```text
spawn repair-editor
  handoff findings: RF-… / VF-… with exact text and files
  writablePaths: pending gate files only
```

## Related guides

- Automated hooks → code-reviewer finalization: gate awareness section in the orchestrator system prompt (`GATE: PENDING` / `GATE: PASSED`).
- Specialist risk routing and `params.snapshot_id`: `agents/guides/specialist-routing.md`.
- Advisory pre-edit security patterns: `agents/guides/security-review.md`.
- Edit authorization (`edit_transaction`, capabilities): `packages/agent-runtime/docs/deterministic-edit-system.md`.
