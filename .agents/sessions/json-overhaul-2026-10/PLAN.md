# JSON Overhaul — Phase 2: receipt-overwrite rework (plan)

> **Reconciled 2026-10-24 against the working tree** (evidence-based file/symbol inspection, not commit-history trust): items ticked below with `<!-- reconciled -->` evidence notes are verified landed; unticked items annotated OPEN are not found in the tree (or could not be verified cheaply) and remain real work.

## Milestone D1 — Writer-side downgrade guard (core fix)
- [x] D1.1 Confirm root cause from live evidence: reviewer set_output twice; second degenerate echo replaces good receipt (task memory: three `schema_invalid` receipts; user-pasted settle log)
- [x] D1.2 <!-- reconciled 2026-10-24: guard live in set-output.ts (ack-echo/verdict-less preservation) --> Implement guard in `packages/agent-runtime/src/tools/handlers/tool/set-output.ts`:
  - Policy (user-decided, option b): a reviewer-family receipt can only be REPLACED by another receipt-shaped output (via shared `isReceiptShape`)
  - When: existing `agentState.output` isReceiptShape AND parsed `finalOutput` NOT isReceiptShape AND agent is reviewer-family → keep existing output, clear `lastSetOutputError`, return a NON-error ack instructing the model the receipt is already published
  - Depends on: shared `isReceiptShape` from `common/src/util/model-payload-recovery.ts` (committed C1)
  - Acceptance: verdict-bearing → verdict-less retry preserves the original receipt; corrected receipt-shaped calls still replace
  - Validate: `bun test src/tools/handlers/tool/__tests__/set-output.test.ts` + typecheck-agent-runtime
- [x] D1.3 <!-- reconciled 2026-10-24: agentType.includes('reviewer') gating at set-output.ts:126 --> Gate the guard exactly on reviewer-family (`agentType.includes('reviewer')` or `family === 'reviewer'` paths already computed in the handler) so non-reviewer agents keep replace-always semantics

## Milestone D2 — Model-side contract clarity
- [x] D2.1 <!-- reconciled 2026-10-24: confirmation-not-payload text in common set-output params :124 --> Update tool description in `common/src/tools/params/tool/set-output.ts`: the `{"message":"Output set"}` result is a confirmation NOT an example payload; never echo it back as a payload; one receipt per run; corrections must be full receipt objects
- [x] D2.2 <!-- reconciled 2026-10-24: reviewer prompts route verdicts solely via set_output (code-reviewer.ts:187) --> Confirm reviewer prompts (`agents/reviewer/code-reviewer.ts`, `agents/security-reviewer/security-reviewer.ts`) already say native JSON — no further change expected
  - Acceptance: description text pinned by existing set-output-schema description tests still passing (or updated where they made exact-text assertions)

## Milestone D3 — Regression tests (R5)
- [x] D3.1 <!-- reconciled 2026-10-24: ack/echo/verdict-less describe block present in set-output.test.ts --> `set-output.test.ts` new describe block: verdict→verdict-less retry ignored (output preserved, ack non-error, `lastSetOutputError` cleared); verdict→corrected receipt replaces; ack-echo `{message:'Output set'}` never stored for reviewer; non-reviewer replacement unaffected; envelope-wrapped first call still lands (Phase 1 path intact)
  - Depends on: D1.2
  - Validate: same command as D1.2

## Milestone D4 — Validation + commit
- [x] D4.1 <!-- reconciled 2026-10-24: typechecks green (workspace gate, re-verified 2026-10-24) --> typechecks: common, agent-runtime (then full workspace via gate)
- [x] D4.2 <!-- reconciled 2026-10-24: set-output suite green 34/34 (re-run 2026-10-24) --> Targeted suites: set-output (23), set-output-schema (26), recovery-util (29+), spawn-agent-utils-output (75) — all green
- [x] D4.3 <!-- reconciled 2026-10-24: landed and committed; code in tree at HEAD --> Reviewer gate LOOKS_GOOD; git-committer commit of D1.2/D2.1/D3 files (no push)

## Risks / blockers
- Drift risk: guard keyed on reviewer-family only; must not swallow genuinely corrected-but-unshaped output — mitigated by option (b) semantics (only receipt-shaped replacements accepted)
- Integrated status: existing `lastSetOutputError` lifecycle kept (cleared on successful publish AND on ignored-retry ack)

## Checkpoint rules
- Update STATUS.md at each milestone boundary (update_plan_status)
- SPEC/PLAN revisions via create_plan only if scope changes
- LESSONS.md ongoing via update_plan_status