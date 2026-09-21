# PLAN — Compatibility-Reviewer Remediation (compat-remediation-2026-09)

## Milestones

### M1 — Finding-scoped remedies (each targets one open finding ID)

- [ ] C1: saveChunkSidecar boolean contract publication (savechunksidecar-void-to-boolean)
  Depends on: none
  Acceptance: `packages/indexer/src/index-store.ts` `saveChunkSidecar` JSDoc documents the old `Promise<void>` → new `Promise<boolean>` signature and boolean semantics (true = validated write; false = validator/fallback rejection); `sdk/CHANGELOG.md` gains a bullet under the current Unreleased section naming the export and the widened return. Existing tests at `packages/indexer/src/index-store.test.ts:488,497` already pin both boolean branches — extend only if doc reveals a missing branch.
  Validate: `cd packages/indexer && bun run typecheck && bun test src/index-store.test.ts`; `grep` CHANGELOG for `saveChunkSidecar`.

- [ ] C2: legacy AgentState field passthrough regression (agentstate-field-removal-persisted-state-compat)
  Depends on: none
  Acceptance: new test in `cli/src/utils/__tests__/run-state-storage.test.ts` that a checkpoint JSON written by an older binary carrying `consecutiveTextOnlyWithoutCompletion` (plus a legacy chat-state envelope carrying it inside `runState.mainAgentState`) still loads via `loadCheckpoint` / `loadChatStateFromDirectory` and that the stale field is absent from the next `saveCheckpoint` output. Verified live: the read path is `JSON.parse(...) as` + `sanitizeForChatPersistence` (non-strict), so no production change is needed — this is proof-only.
  Validate: `cd cli && bun run typecheck && bun test src/utils/__tests__/run-state-storage.test.ts`.

- [ ] C3: legacy 8-hex archive mirror surfaced in the mismatch warning (archive-filename-64hex-mirror-contract)
  Depends on: none
  Acceptance: in `cli/src/commands/memory-command.ts` `runCompact`, the post-apply mismatch branch (currently `return report(... 'warning')` on `outcome.archiveHash !== archiveHash || !outcome.archivePath.endsWith(fileName)`) additionally scans `.openbuff/memory/archive/` for legacy `archive-<8hex>.jsonl` siblings and, when present, appends a line naming the legacy mirror as a recoverable artifact and stating the canonical full-digest file is authoritative. Extend the covering CLI test with a legacy-file fixture asserting the warning line appears.
  Validate: `cd cli && bun run typecheck && bun test src/commands/__tests__/memory-command.test.ts`.

- [ ] C4: researcher-web set_output contract documented (researcher-web-toolnames-contract-change)
  Depends on: none
  Acceptance: `docs/agents-and-tools.md` gains a short note in the agent-templates/tool-contract section: `programmaticToolNames` vs `toolNames` semantics, and that structured-output agents (researcher-web first) now declare `set_output` in `toolNames` with empty `programmaticToolNames`, so embedders that introspected `programmaticToolNames` to intercept set_output at the generator boundary must now intercept at the model-call boundary. Optionally mirror the note in `sdk/CHANGELOG.md`. The contract itself is already pinned by `agents/__tests__/researcher-web.test.ts:74-77` — no code change.
  Validate: manual read of the docs diff; `cd agents && bun run typecheck && bun test __tests__/researcher-web.test.ts`.

### M2 — Validation join + gate

- [ ] V1: full validation wave
  Depends on: C1, C2, C3, C4
  Acceptance: indexer typecheck+suite green (`bun test --isolate`, 226 tests), cli typecheck + memory-command + run-state-storage tests green, agents typecheck + researcher-web tests green, sdk typecheck 0 + v1-migration/credentials suites green.
  Validate: the four package commands above plus `cd sdk && bun run typecheck && bun test src/services/memory-v2/__tests__/v1-migration.test.ts src/__tests__/credentials.test.ts`.

- [ ] V2: runtime gate cycle
  Depends on: V1
  Acceptance: end turn; fresh compatibility-reviewer + migration-reviewer receipts clear all open finding IDs (including the earlier migration-reviewer blockers, already repaired: archive mirror 64-hex naming, credentials copy-fallback, post-marker retirement, invalid-record reason).
  Validate: gate receipts with `unresolvedCount: 0` and verdicts NON_BLOCKING/LOOKS_GOOD.

## Dependencies & Ordering
- C1–C4 are independent; V1 joins them; V2 ends the turn.
- Do not regress prior repairs: credentials copy-based fallback, post-marker retirement ordering, invalid-record audit reason, 64-hex archive naming, p8-lite/p8-degraded-delta mock split, indexer `bun test --isolate`.

## Risks / Blockers
- Repair-editor agents have repeatedly blocked without submitting edits in this session; if delegation is used again, fall back to direct root edits (worked successfully for the migration repairs).
- C3 touches `runCompact`'s report shape — keep the existing 'warning' tone and only append lines, so the render contract stays additive.

## Checkpoint Rules
- After each C-task: no status update needed until V1.
- After V1: update STATUS.md (completed items, validation receipts).
- After V2/gate: update STATUS.md + LESSONS.md (lesson: repair-editor blocking → direct root edits fallback; bun mock.module persistence requiring --isolate).

## Artifact Paths
- Session: .agents/sessions/compat-remediation-2026-09
- SPEC.md / PLAN.md / STATUS.md / LESSONS.md under that directory.
