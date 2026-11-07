# STATUS — Subagent Streaming, Specialist Routing, Reviewer Verdict Robustness

## Current state

All three waves are IMPLEMENTED and locally VALIDATED. Two reviewer passes (migration-reviewer, reliability-reviewer) produced BLOCKING findings on the Wave 3 windowed-attestation wiring; all are repaired. Awaiting a fresh matching reviewer pass to clear the records.

## Completed

- **Wave 1 — streaming parity.** `stream-chunk-processor.ts` (reasoning routes by `agentId`), `sdk-event-handlers.ts` (tool blocks nest under the child when `agentId` present), `child-entry.ts` (`buildChildOnResponseChunk` relays non-text events over the bridged `sendAction` channel). Test signatures updated in `child-entry.test.ts`.
- **Wave 2 — specialist routing.** `base2.ts` routes over `specialistAuxRelevantFiles ∪ pending manifest/CI files`; skip reasons `specialist-no-attestable-files` / `no-specialists-routed` recorded + telemetry.
- **Wave 3 — verdict robustness.** `gate-reviewer.ts`: `recoverStructuredReviewerOutputs`, `diagnoseReviewerVerdictRejection`, `buildReviewerVerdictRetryNotice`, `planGateReviewWaves`, `waveKey`. `gate-state.ts`: `noVerdictDiagnosticCodes`, `waveCompletions`. `base2.ts`: recovery pre-pass, retry diagnostic, state-based convergence, windowed credit.
- **migration-reviewer repairs.** Ledger-family consistency (specialist family), union across all routed specialists, `boundWaveCompletions`/`boundNoVerdictDiagnosticCodes` bounds.
- **reliability-reviewer repairs.** (1) Wave-completeness check moved AFTER the spawn/credit so the ledger is populated before it is read. (2) Planning partitions `waveCreditUniverse` (union of routed scoped sets), the same universe crediting uses. (3) `boundWaveCompletions` scoped to the current fingerprint — retains all current keys, caps only stale. Plus a parent fix: threaded `fingerprint` into the now-two-arg `boundWaveCompletions` call site (TS2554).

## Validation evidence (post-repair)

- gate-helpers region regenerated; `--check` reports fresh.
- Typecheck green: `agents`, `packages/agent-runtime`, `cli`.
- Tests green: agents gate/reviewer/specialist 123 pass / 0 fail; child-entry 24 pass / 0 fail.
- No budget defaults changed; `common/src/util/gate-repair-budgets.ts` untouched.

## Pending / blocked

- Fresh migration-reviewer and reliability-reviewer passes must clear the open finding records.
- New dedicated behavioral tests for the Wave 3 helpers are NOT yet written (recovery from prose/fenced JSON, diagnostic notice, >40-file wave planning, and the deadlock scenarios). Existing suites + region-freshness parity pass; the wide-review path is reasoned + typechecked, not end-to-end exercised.
- `agents/guides/specialist-routing.md` not updated with the new skip-reason strings.

## Resume instructions

1. Read SPEC.md, PLAN.md, then this file.
2. All implementation work is done; only reviewer clearance + optional dedicated tests remain.
3. Before editing any `agents/base2/*` spliced helper, regenerate with `bun run scripts/generate-gate-helpers.ts --write agents/base2/base2.ts` and verify with `--check`.
