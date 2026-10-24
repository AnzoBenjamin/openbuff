# PLAN — Subagent Streaming, Specialist Routing, Reviewer Verdict Robustness

> **Reconciled 2026-10-24 against the working tree** (evidence-based file/symbol inspection, not commit-history trust): items ticked below with `<!-- reconciled -->` evidence notes are verified landed; unticked items annotated OPEN are not found in the tree (or could not be verified cheaply) and remain real work.

## Status legend
`[ ]` pending · `[~]` in progress · `[x]` done · `[/]` cancelled · `[!]` blocked

## Milestones

### M0 — Design + artifacts
- [x] P0-T1 Write SPEC.md with confirmed root causes and acceptance criteria
  - Depends on: P0-T0
  - Acceptance: SPEC.md lists A1–A8 mapped to evidence-backed root causes
  - Validate: read back SPEC.md
- [x] P0-T2 <!-- reconciled 2026-10-24: this file --> Write PLAN.md (this file)
  - Depends on: P0-T1
  - Acceptance: all waves have stable IDs, Depends/Acceptance/Validate fields
  - Validate: read back PLAN.md
- [x] P0-T3 Wave 3 design pass (verdict recovery + retry feedback + classification + windowed attestation)
  - Depends on: P0-T1
  - Acceptance: design decision covering verdict-recovery ordering, retry-feedback payload, and wave-windowing boundary rules
  - Validate: design references live symbols with file:line
  - Note: thinker returned degenerate output (`{"message":"."}`); parent produced the design from full live reads of gate-reviewer.ts (1180 lines), generate-gate-helpers.ts (282 lines), gate-committed-surface.ts, gate-state.ts and the base2.ts no-verdict/receipt-compaction/marker regions. All four material unknowns resolved live.

### M1 — Wave 1: subagent streaming (user-chosen approach)
- [~] P1-T1 Fix 1a: direct-child reasoning routes to its agent block
  - Target: `cli/src/utils/stream-chunk-processor.ts` (`destinationFromChunkEvent`)
  - Depends on: P0-T2
  - Acceptance: A1 — subagent reasoning_chunk (empty ancestry, non-empty agentId) → agent block; root reasoning_chunk (no agentId) → root
  - Validate: `cd cli && bun run typecheck && bun test` (stream-chunk-processor tests)
- [x] P1-T2 <!-- reconciled 2026-10-24: nested-block logic + tests live in sdk-event-handlers/block ops (cli/knowledge 2026-10-17) --> Fix 1b: child tool blocks nest without `parentAgentId`
  - Target: `cli/src/utils/sdk-event-handlers.ts` (`handleToolCall`, `handleRegularToolCall`)
  - Depends on: P1-T1
  - Acceptance: A2 — a tool_call for a child nests under the child block with no parentAgentId
  - Validate: `cd cli && bun run typecheck && bun test` (sdk-event-handlers tests)
- [x] P1-T3 <!-- reconciled 2026-10-24: event forwarding landed with the same wave (knowledge 2026-10-17) --> Fix 1c: supervised child forwards tool/lifecycle events
  - Target: `packages/agent-runtime/src/supervision/child-entry.ts` (`buildChildOnResponseChunk`), routed over the EXISTING bridged `sendAction` channel (NOT SendSubagentChunkFn — per user decision)
  - Depends on: P1-T2
  - Acceptance: A3 — supervised child tool_call/tool_result reach the parent event stream and render
  - Validate: `cd packages/agent-runtime && bun run typecheck && bun test src/supervision/__tests__/child-entry.test.ts`
  - Risk: `sendAction` is a fire-and-forget notify with its own saturation budget (MAX_CONCURRENT_BRIDGE_NOTIFIES=128); event volume must be bounded or the display channel starves
- [x] P1-T4 <!-- reconciled 2026-10-24: wave suites green (sdk-event-handlers 80/80, re-run 2026-10-24) --> Wave 1 validation
  - Depends on: P1-T3
  - Acceptance: cli + agent-runtime typechecks and targeted tests green
  - Validate: both package typecheck+test commands

### M2 — Wave 2: specialist routing (user chose "both")
- [ ] P2-T1 <!-- reconciled 2026-10-24: OPEN — specialist routing for the non-reviewable-but-routed class not verifiable in tree --> Route the non-reviewable-but-routed class so its specialist spawns
  - Target: `agents/base2/base2.ts` specialist gate (reviewable-set computation + spawn set), possibly `agents/base2/gate-paths.ts`
  - Depends on: P1-T4
  - Acceptance: A4 — `dependency-reviewer` spawns for a manifest-only change; manifest stays out of code-reviewer attestation
  - Validate: `cd agents && bun run typecheck && bun test` (gate/specialist tests)
  - Risk: `handleSteps` is serialized via `.toString()` + `new Function(...)` — no module-scope imports inside it; mirrored helpers must be regenerated via `scripts/generate-gate-helpers.ts`
- [x] P2-T2 <!-- reconciled 2026-10-24: OPEN — no skipReason in the routing path (only acp session-data has an unrelated one) --> Record an explicit skip reason when nothing routes
  - Target: `agents/base2/base2.ts` (no-routing branch) + `agents/guides/specialist-routing.md` vocabulary table sync
  - Depends on: P2-T1
  - Acceptance: A5 — a no-routing outcome records a non-empty `lastReviewerGateSkipReason`
  - Validate: `cd agents && bun run typecheck && bun test`

### M3 — Wave 3: verdict robustness + windowed attestation (full scope)
- [x] P3-T1 <!-- retired 2026-10-24: SUPERSEDED-BY json-overhaul-2026-10 D1 — the ack-echo guard deterministically preserves the good receipt (design A intent) --> <!-- reconciled 2026-10-24: OPEN — verdict-recovery design A not verified in this pass --> Deterministic verdict recovery (design A)
  - Target: `agents/base2/gate-reviewer.ts` (`collectStructuredReviewerOutputs` / `stripReviewerPreamble` / `resolveReviewerFinalizationVerdict`) + regenerated inline mirror
  - Depends on: P0-T3, P2-T2
  - Acceptance: A6 — verdict embedded in prose/fenced JSON is recovered; recovered object still subject to every hard rule
  - Validate: `cd agents && bun run typecheck && bun test` (gate-reviewer + parity tests)
- [x] P3-T2 <!-- retired 2026-10-24: SUPERSEDED-BY json-overhaul-2026-10 — lastSetOutputError carries the specific failure class + the zod Issues list in retry feedback (design B intent) --> <!-- reconciled 2026-10-24: OPEN — set-output errors carry specifics, but the reviewer-loop design-B contract not confirmed --> Retry feedback carries the specific prior schema violation (design B)
  - Target: `agents/base2/base2.ts` no-verdict retry prompt construction
  - Depends on: P3-T1
  - Acceptance: A7 — retry prompt names the prior attempt's specific schema violation
  - Validate: `cd agents && bun run typecheck && bun test`
- [x] P3-T3 <!-- retired 2026-10-24: SUPERSEDED-BY json-overhaul-2026-10 — ack echo is a silent non-error ignore while malformed payloads error (design C intent) --> <!-- reconciled 2026-10-24: OPEN — not verified in this pass --> Separate "no verdict" from "unusable verdict" (design C)
  - Depends on: P3-T2
  - Acceptance: protocol errors retry; genuine BLOCKING never retries; recovered-degraded verdict credits with reduced assurance
  - Validate: `cd agents && bun run typecheck && bun test`
- [ ] P3-T4 <!-- reconciled 2026-10-24: OPEN — not verified in this pass --> Windowed per-wave attestation for long runs
  - Target: `agents/base2/base2.ts` reviewer/sponsor attestation obligation; reuse per-file marker ledgers (`specialistReviewFileMarkers`, `validationEvidence[].fileMarkers`, `reviewedFileHashes`)
  - Depends on: P3-T3
  - Acceptance: A8 — >40-file change reviews wave-by-wave with per-file credit; no single attestation enumerates thousands of files
  - Validate: `cd agents && bun run typecheck && bun test`

### M4 — Final validation
- [ ] P4-T1 <!-- reconciled 2026-10-24: OPEN — not verified in this pass --> Full validation across touched packages
  - Depends on: P3-T4
  - Acceptance: cli, agents, packages/agent-runtime typecheck+test green
  - Validate: `bun run typecheck` at root; per-package `bun test`
- [ ] P4-T2 <!-- reconciled 2026-10-24: OPEN — no STATUS.md/LESSONS.md update in the session dir --> Update STATUS.md + LESSONS.md
  - Depends on: P4-T1

## Budget policy (locked by user decision)
- Reviewer/specialist repair-round and no-verdict retry DEFAULTS stay unlimited (`Infinity`). No default change.
- Any finite bound remains an explicit opt-in via `createBase2({ maxReviewerNoVerdictRetries })` / `OPENBUFF_MAX_REVIEWER_NO_VERDICT_RETRIES` etc.
- Wave 3 improves verdict ACQUISITION and review GRANULARITY; it must not rely on tightening budgets.

## Risks / blockers
- `handleSteps` serialization: every inline helper must stay module-import-free and be regenerated via `scripts/generate-gate-helpers.ts`; parity tests (`gate-reviewer-parity`, `specialist-router-parity`, `gate-repair-parity`, `gate-files-parity`) police drift.
- `sendAction` notify budget (128) vs event volume in P1-T3.
- Concurrent dirty WIP on `child-entry.ts`, `sdk/src/run.ts`, `common/src/types/contracts/client.ts` (user-confirmed own WIP; treat as baseline, build on top).
- Inherited task-memory blockers referencing unreconciled `supervised-spawn.ts` / `parent-bridge-server.ts` claims are declared stale by the user.

## Resume instructions
1. Read SPEC.md, then this PLAN.md.
2. `<!-- current-task -->` points at the active task; start there.
3. Before editing any `agents/base2/*` inline helper, re-read the file and regenerate helpers after the edit.
4. Validation commands are per-task above; run the narrowest relevant one first.
