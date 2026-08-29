# STATUS — Harness UI Overhaul (Full Sweep)

Slug: `harness-ui-overhaul-2026-08`
Snapshot: `399c28986835a71e7ee7b45b6dcaf9bf2b9f8ef85181a443bdcfaeebbe6a137c`
Branch: `feat/task-memory-evidence-pipeline` (clean)

## Current state

- **Phase:** Plan complete — SPEC.md + PLAN.md landed and under gate review. Ready for `M1` execution.
- **Mode:** PLAN (no `cli/src` edits this turn; gate is artifacts-only)

## Milestone tracker

- M0 Session bootstrap — done ✅ (SPEC.md, PLAN.md)
- M1 Primitive + Completion summary (P1) — pending
  - M1-T1 `harness-box.tsx` + adopt in PlanBox/GateStateBox
  - M1-T2 `chat.ts` `completion-summary` block + guard
  - M1-T3 `completion-summary-box.tsx`
  - M1-T4 `sdk-event-handlers.ts:handleFinish` wired
  - M1-T5 `single-block.tsx` routing
  - M1-T6 tests + tmux smoke
- M2 Memory interactive box (P1) — pending
- M3 Sweep remaining reports (P2) — pending
- M4 Hardening + docs — pending

## Coverage matrix (plan scope)

| Domain                               | Shard / File                                                                                           | Covered                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| cli TUI renderers                    | `cli/src/components/renderers/*`                                                                       | yes — SPEC R4, M1        |
| cli chat types                       | `cli/src/types/chat.ts`                                                                                | yes — R1/R2, M1-T2/M2-T1 |
| cli completion summary               | `cli/src/utils/completion-summary.ts`                                                                  | yes — R1, M1             |
| cli sdk-event-handlers (finish seam) | `cli/src/utils/sdk-event-handlers.ts`                                                                  | yes — R5, M1-T4          |
| cli memory command                   | `cli/src/commands/memory-command.ts`                                                                   | yes — R2, M2             |
| cli command registry + helpers       | `cli/src/commands/command-registry.ts` + `context.ts`/`info.ts`/`index-command.ts`/`plan-artifacts.ts` | yes — R3, M3             |
| cli blocks routing                   | `cli/src/components/blocks/single-block.tsx`                                                           | yes — M1-T5/M2           |
| sdk task memory store                | `sdk/src/services/task-memory-store.ts`                                                                | yes — R2 (data source)   |
| common task-memory types             | `common/src/types/task-memory.ts`                                                                      | yes — R2                 |
| theme/tokens                         | `cli/src/types/theme-system.ts` + `ui-constants.ts` + `hooks/use-theme.tsx`                            | yes — R4                 |

Domains explicitly out-of-scope for this plan: `sdk/provider`, `agent-runtime` prompts, `packages/indexer`, `common/templates`.

## Validation gates (next)

- `bun --cwd cli run typecheck`
- `bun --cwd cli test` (completion-summary, sdk-event-handlers, memory-command, command-registry)
- `tmux-cli` smoke: streaming→completion box, `/memory` + `/memory prune` (move-aware), `/context /info /doctor /index /plan-status /plans`

## Resume instructions

1. Read `SPEC.md` + `PLAN.md` in this session dir.
2. Start at `M1-T1 + M1-T2` (harness-box + chat types) — single editor slice.
3. Keep `formatCompletionSummary`/`formatAge` exported for logs/tests (AC7).
4. Preserve move-rebinding: `WorkspaceJournalService.create → collectWorkspaceMoves` in memory status & prune.
