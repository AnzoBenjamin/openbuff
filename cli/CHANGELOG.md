# Changelog

All notable changes to the `@openbuff/cli` package will be documented in this file.

## [Unreleased] - 2026-08-07

### Changed

- **BREAKING (bundled agent output):** `dependency-manager` structured output moved from `schemaVersion: 1` to `schemaVersion: 2`, on both the `set_output` envelope and the nested `rollbackReceipt`. `rollbackReceipt.deletedCreatedFiles` now lists **only** lockfile deletes whose `edit_transaction` delete actually applied; v1 listed every *attempted* delete, including refused or unauthorized ones. The new `rollbackReceipt.undeletedCreatedFiles` carries the remainder (refused, unauthorized for lack of a complete whole-file read, or otherwise unconfirmed), and a non-empty `undeletedCreatedFiles` forces `status: 'incomplete'` with `rollbackRequired: true`. External spawners reading v1 semantics should branch on `schemaVersion` before interpreting `deletedCreatedFiles`, reconstruct the v1 attempted set as `[...deletedCreatedFiles, ...undeletedCreatedFiles]` (a per-attempt audit trail remains in `rollbackReceipt.results`), and treat a missing `undeletedCreatedFiles` as a v1 payload rather than "nothing left behind". Full contract in `docs/request-flow.md` under "Consumer-visible change: dependency-manager output `schemaVersion` 2".
- Gate repair loops default to **unlimited / progress-gated** (no hard round caps). Optional positive-int caps remain via `createBase2` options (`maxRepairRounds`, `maxReviewerRepairRounds`, `maxSpecialistRepairRounds`) and env (`OPENBUFF_MAX_*_REPAIR_ROUNDS`, max `20`). Unset/invalid → unlimited (`null` in programmaticConfig). `/context` prints `unlimited` for defaults. Shared helpers in `common/src/util/gate-repair-budgets.ts`.
- Already-credited (`gatePassedFiles`) dirty task files no longer re-expand final gate scope via `deriveGateScopeFiles`, so durable/conversation reuse is not broken and the reviewer is not re-spawned solely for still-dirty credited paths. Marker eviction and unreviewed re-arm still handle real content drift.
- Validation/reviewer gate finalization is **LOOKS_GOOD-only**. Structured `NON_BLOCKING` no longer passes the gate: findings are elevated into the same repair-editor / re-review loop as `BLOCKING` and burn the reviewer repair counter until a later review returns `LOOKS_GOOD` (or an optional hard cap is exhausted).

### Added

- Optional gate repair budget caps on `createBase2` / env (see Changed). Shared resolve/format helpers live in `common/src/util/gate-repair-budgets.ts` and are re-exported from `agents/base2/base2.ts`. Documented in `docs/configuration.md` and `docs/environment-variables.md`.
- `/context` (alias `/ctx`) now always prints the effective **Gate repair budgets** section (validation / reviewer / specialist), resolved from env/defaults even when no context-budget ledger exists yet. Ledger output, when present, is shown first with budgets appended after a blank line.
- The `code-reviewer` gate now recognizes an embedded JSON verdict object emitted after a prose preamble (e.g. `"I now have full context. … {\"verdict\":\"LOOKS_GOOD\",…}"`). The new `extractEmbeddedJsonVerdict` helper in `agents/base2/gate-reviewer.ts` tracks brace depth with `\"`-escape and JSON-string-boundary awareness so a `}` inside a string value does not prematurely close the object, uses the last embedded verdict when a reviewer echoes a prior `BLOCKING` before a final `LOOKS_GOOD`, and rejects truncated/unknown/`coverage:"missing"` verdicts. The inline `base2.handleSteps` mirror is kept in sync and parity-tested in `agents/__tests__/gate-reviewer.test.ts`. Documented in `docs/agents-and-tools.md` under a new "## Reviewer verdict contract" section.

### Fixed

- Specialist crash taxonomy and gate attestation hardening (`#43`): classify specialist failures as `none` / `transient` / `protocol` / `fatal`, treating rate-limit / `resource_exhausted` as **transient** so the repair-editor is not thrashed; non-advisory `createSpecialist` / spawn recovery require gate-assigned opaque `v3:…` snapshot tokens (bare review-bundle hex remains evidence-only); clear terminal and rate-limit skip pins on successful specialist credit; coverage for gate-reviewer, spawn permissions, tool validation, and writer spawn rules.
- Security aux LOOKS_GOOD credit fingerprints the **reviewable** pending subset only (`selectReviewableGateFiles`), so non-reviewable plan/session dirt (e.g. `.agents/sessions/**/STATUS.md`) no longer thrash-invalidates security credit; entry still uses full pending for `matchesSecuritySensitiveGlob`. Bundle docs clarify bare `get_change_review_bundle.snapshotId` is evidence-only — gate attestation stays opaque `v3:…` tokens.
- Post-edit specialist review attestation now uses the **gate-owned v3 fingerprint** (same family as security/code-reviewer) as the sole review token: spawn `params.snapshot_id`, prompt echo, `specialistSnapshots`, finding `snapshotFingerprint`, and gateId all use `specialistCreditFingerprint` (`v3:…` from `hashGateSnapshotDetails`). Bare `get_change_review_bundle.snapshotId` hex is evidence-only (files/diff/empty-tree) and is no longer accepted as specialist credit identity. Stale retry recomputes the gate fingerprint from current pending files; bundle refresh is optional for evidence. Non-attestable fingerprints (`unreadable:no-crypto`) fail closed without spawning bare bundle ids. Empty/failed bundles never auto-credit specialists while reviewable pending files still exist — the gate always spawns with the gate-owned v3 token instead of fail-open empty-tree attestation.
- `git_status` tool result schema now accepts the per-turn suppressed `{ unchanged: true, note }` payload (mirroring `list_jobs`), so byte-identical worktree re-observations no longer fail as `malformed_result`.
- Inline reviewers now receive the orchestrator history as read context without copying their private file reads, tool results, and `set_output` transcript back into the parent prompt. Deliberate `set_messages` control-plane rewrites and context-pruner compaction still propagate.
- Structured reviewer results are bounded before entering parent history, while retaining verdicts, snapshots, findings, corrections, dimensions, and representative evidence.
- Semantic compaction preserves a larger beginning-and-end task contract and next action so trailing instructions survive long pasted diagnostics.
- `edit_transaction` now strongly requests real edit arrays, continues to repair complete legacy JSON encodings, and reports truncated encodings at the `edits` field with safe recovery guidance instead of a misleading `edits[0]` object error.

## [1.1.11] - 2026-07-07

Patch release covering context-pruner reviewer-memory hardening, auxiliary gate-state reset fixes, and updated default agent model routing.

### Changed

- Switched default Openbuff agent routes from `iamhc/glm-5.2` to `agentrouter/gpt-5.5`.

### Fixed

- Context pruning now preserves actionable `code-reviewer` and `security-reviewer` findings across tight repeated compaction without also retaining generic agent-result summaries.
- Stale `final_response_allowed` active-work state and `NON_BLOCKING` reviewer notes no longer survive compaction as pinned or regular summary text.
- Reset auxiliary gate tracking when the validation/reviewer gate completes so future gate runs do not inherit stale pre-edit security, test-writer, doc-writer, or pending-file state.

### Added

- Added cross-language idiom guidance and language-profile prompt plumbing so orchestrator/editor prompts can conditionally include compact idiom contracts for non-TypeScript work.
- Added BuffBench idiom evaluation signals, traceability checks, proposal dry-run artifacts, and self-improvement proposal plumbing for manual-review-only agent improvements.
- Expanded deterministic edit, structural read, rewrite-symbol, code-map, and indexer retrieval coverage across additional language and repo-map scenarios.

### Changed

- Improved inferred validation hook behavior and documentation for local file-change checks.
- Refreshed CLI and tmux knowledge notes for menu coverage, readiness waits, input encoding, and capture behavior.

### Fixed

- Excluded generated `evals/test-repos` clones from the focused BYOK wording guard so local validation does not scan temporary repository fixtures.

## [1.1.7] - 2026-07-05

Pipeline release of `@openbuff/cli` covering the inline-subagent rendering fix, a legacy-skill prune, and model-agnostic slash-command descriptions.

### Fixed

- `spawn_agent_inline` now nests inline-subagent events under the child agent block in the TUI instead of blending them into the orchestrator's turn. The handler's `onResponseChunk` injects the same lineage tagging `spawn_agents` uses: `tool_call`/`tool_result` get the child's `agentId` as `parentAgentId`, `text` events get the child's `agentId` (empty text dropped), and `subagent_start`/`subagent_finish` get the parent orchestrator's `agentId`. Both injections use `??` so a pre-existing value (set by `run-programmatic-step` for grandchild spawns) is preserved, keeping correct lineage across deep inline nesting. Restores clean rendering of the `test-writer`/`doc-writer`/`security-reviewer` aux-gate spawns.

### Changed

- Pruned the legacy `cleanup` and `review` skills, which duplicated the root "Code Craftsmanship" guidance and the `/review` handler plus the auto-spawned code-reviewer gate covering the same surface. Retiring them removes three sources of truth that were drifting apart.
- `/plan` and `/review` palette descriptions are now model-agnostic ("configured planner" / "configured reviewer") instead of naming a specific hosted model, so the strings stay correct under BYOK and across providers.

### Added

- `cli/src/data/__tests__/slash-commands.test.ts` (23 tests) locking the slash-command contract — `SLASH_COMMANDS`, `SLASHLESS_COMMAND_IDS`, `getSlashCommandsWithSkills` — including "GPT 5.4"-style model-name regression guards (reject hardcoded hosted-model text) and a 50-char description-truncation boundary check.
- `packages/agent-runtime/src/__tests__/spawn-agent-inline-nesting.test.ts` (12 tests) covering the new nesting behavior, including grandchild regression guards for both `parentAgentId` and `agentId` preservation, the silent-`context-pruner` guard, and verbatim pass-through of non-nesting event types.
- `## Slash Commands` section in `docs/agents-and-tools.md` cataloging the three exports, the `SlashCommand` shape, the registered command set, and the skill-command vs. alias/implicit rules.
- `### spawn_agent_inline` subsection in `docs/agents-and-tools.md` documenting the handler contract, forced template overrides, return shape, and the `parentAgentId`/`agentId` nesting table.

### Removed

- `.agents/skills/cleanup/SKILL.md` and `.agents/skills/review/SKILL.md` (see "Changed" above for rationale).
