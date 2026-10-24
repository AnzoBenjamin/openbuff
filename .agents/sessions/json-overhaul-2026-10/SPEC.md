# JSON Overhaul — Phase 2: set_output receipt-overwrite rework

## Root cause (user-evidence + source)
A reviewer-family child calls set_output TWICE: first with a valid verdict-bearing receipt (sometimes wrapped in an invented envelope like `{jsonKey:'output', value:'<stringified receipt>'}`), then again with a degenerate echo `{"message": "Output set"}`. Because the tool contract says each call "completely replaces any previous output," the second call OVERWRITES the good receipt in `agentState.output` with a verdict-less payload → the reviewer verdict guard classifies `schema_invalid` → parent re-reviews forever. Phase 1 (C1–C3, committed: `84ce821e5`, `499d7552e`, `b7183d697`) consolidated all reader-side decode/unwrap into `common/src/util/model-payload-recovery.ts` — that made the FIRST call succeed but left the writer unguarded against the echo overwrite.

## Goal
Writer-side protection: a reviewer's verdict-bearing receipt can only be replaced by another receipt-shaped call (decision: user chose option **b: receipt-only replacement**, NOT first-write-wins).

## Requirements
- R1 (core): In `handleSetOutput` (`packages/agent-runtime/src/tools/handlers/tool/set-output.ts`), when the computed `finalOutput` is verdict-LESS and an existing `agentState.output` is verdict-BEARING (via shared `isReceiptShape`), for reviewer-family agents only: preserve the existing output; return a NON-error ack that explicitly tells the model "your receipt was already published." Legitimate corrected receipts (also receipt-shaped) still replace.
- R2: The degenerate `{message:'Output set'}` echo must never be stored as output for reviewer-family agents (it is verdict-less, so R1 covers it; add explicit test).
- R3: Update the tool description in `common/src/tools/params/tool/set-output.ts` to instruct models: the `{"message":"Output set"}` result is confirmation, not an example to echo; call set_output once; corrections must be full receipt objects.
- R4: No overwrite-guard on non-reviewer agents (their outputs legitimately replace); fail-closed verdict guards unchanged; all bounds stay content-based via `isReceiptShape`.
- R5: Regression tests: verdict-receipt → verdict-less retry ignored (output preserved, ack non-error); verdict → corrected receipt replaces; envelope-wrapped first call still lands (Phase 1 path); non-reviewer replacement unaffected; ack-echo not stored.

## Acceptance criteria
- Live reproduction chain (valid receipt then degenerate echo) settles `ok`/`completed` with the real verdict — pinned by a regression test in `set-output.test.ts`.
- All pinned tests keep passing (23 set-output handler, 26 set-output-schema, 29 recovery-util, 75 spawn-agent-utils-output).
- Full workspace typecheck green; reviewer gate LOOKS_GOOD; committed on feature branch, no push.

## Non-goals
- Changing reader behavior further (Phase 1 did that).
- Changing wire format away from JSON.
- Any first-write-wins semantics (rejected by user decision).

## Relevant files
- `packages/agent-runtime/src/tools/handlers/tool/set-output.ts` (R1/R2)
- `common/src/tools/params/tool/set-output.ts` (R3)
- `common/src/util/model-payload-recovery.ts` (shared `isReceiptShape` — canonical home, Phase 1)
- `packages/agent-runtime/src/tools/handlers/tool/__tests__/set-output.test.ts` (R5)
- Reviewer receipt shape lives in reviewer outputSchema; `agentState.output` semantics in `common/src/types/session-state.ts`