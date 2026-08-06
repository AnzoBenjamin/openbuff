# STATUS — Terminal policy repair (2026-08-04)

## Current state
- Mode: plan. Gate: PENDING (blocked) with 6 open reviewer findings RF-1..RF-6 on snapshot `v3:7fa30d019b80a…`.
- Raw-newline ban removal: implemented; `bun test sdk/src/__tests__/terminal-command-policy.test.ts` was 33/33 green; typecheck hooks green.
- Reviewer pass: BLOCKING on tmux-test fail-open `?? false` guards, missing tmux fail-closed tests, git-commit `-m` vs `--message` inconsistency, missing coverage/requirements.
- Repair-editor spawn attempt failed earlier — next execution must include the full structured `handoff` object (see PLAN.md execution notes).

## Completed
- Blanket raw-newline ban removed from `evaluateTerminalCommandPolicy`.
- Newline-aware composition handling added (`normalizeCommand` preserves newlines; `hasUnquotedShellSyntax` treats unquoted newlines as syntax; `splitReadOnlyShellSegments` splits on newlines incl. `\r\n`; validation-diagnosis heredoc strip retained with narrow multi-line fail-closed guard).
- Test update: multi-line multi-command composition still denied under restricted profiles; reason no longer the blanket newline message.
- Local validation: policy tests 33/33 pass; `bun run typecheck` + sdk typecheck pass.

## Blocked on
- RF-1-4391b95f, RF-2-327c10c4, RF-3-fa741f2a, RF-4-7b925458, RF-5-e9fa653a, RF-6-7a8c09df — see PLAN.md T1–T6.

## Next checkpoint
T5 validation run after repair; then T6 fresh reviewer pass. GATE: PASSED is the completion signal.

## Resume instructions
In execute mode: work PLAN.md T1→T6 in order. Use repair-editor with full handoff citing the RF IDs and the harness-provided snapshot fingerprint. Do not touch the unrelated dirty paths listed in PLAN.md risks.

<!-- update_plan_status:appended -->
## RF tee findings status — 2026-08-04T15:19:32.653Z

RF-1-999e85ef / RF-2-356e9c97 claim tee is missing from TMUX_UNSAFE_EXECUTABLES. Live code at sdk/src/tools/terminal-command-policy.ts:267 already includes 'tee'. hasUnsafeTmuxExecutable + resolveTmuxCommand cover bare, command/env-wrapped, and /usr/bin/tee. Suite bun test sdk/src/__tests__/terminal-command-policy.test.ts: 35 pass / 0 fail including "blocks tmux agents from direct workspace mutation". No further source edit required for these RF IDs; needs fresh matching reviewer pass to clear open records.


<!-- update_plan_status:appended -->
## Session complete — 2026-08-04 — 2026-08-04T21:04:52.635Z

All six reviewer findings RF-1..RF-6 verified as already resolved in the live tree during resume; no new source edits were required. Validation green: `bun test sdk/src/__tests__/terminal-command-policy.test.ts` 35/35 pass; `cd sdk && bun run typecheck` clean. Runtime gate: GATE PASSED (no edited files; reviewer verdict LOOKS_GOOD). Session is complete — safe to archive.

