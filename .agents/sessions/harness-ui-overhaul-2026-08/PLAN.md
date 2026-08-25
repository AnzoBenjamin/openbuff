# PLAN — Harness UI Overhaul (Full Sweep)

Slug: `harness-ui-overhaul-2026-08`
Snapshot: `399c28986835a71e7ee7b45b6dcaf9bf2b9f8ef85181a443bdcfaeebbe6a137c`
Source: SPEC.md (this session), prior harness inventory (399c… snapshot, 22 subsystems)
Current workspace: `feat/task-memory-evidence-pipeline`, clean worktree.

## Milestones

### M0 — Session bootstrap (done)
- SPEC.md landed. This PLAN.md + STATUS.md land this turn. Gate clears on session artifacts only (no src/ changes this turn).

### M1 — Primitive + Completion summary (P1, vertical slice 1)
Goal: one visual language — no more `✅ 3 files edited | ❌ Hooks: 1 failed` pipe-joined text line.

- [ ] M1-T1 Extract `cli/src/components/renderers/harness-box.tsx` (`HarnessBox`, `HarnessSection`, `HarnessRow`): `borderStyle: single` + `BORDER_CHARS` + `paddingLeft/Right 1 + gap`, theme token prop (`secondary` default, `success/error/warning` for status). Adopt in `PlanBox` + `GateStateBox` (no visual regression).
- [ ] M1-T2 Extend `cli/src/types/chat.ts`: `CompletionSummaryContentBlock { type:'completion-summary', summary: CompletionSummary }` + guard `isCompletionSummaryBlock`. Extend `ContentBlock` union.
- [ ] M1-T3 New renderer `cli/src/components/renderers/completion-summary-box.tsx`: sections Files / Hooks / Review / Tests / Auxiliary / Errors, icon+color mapping (`STATUS_ICON` style: `✓ ✗ ⚠` or reuse emoji but themed), bordered via `HarnessBox`. Empty → null (honor `computeCompletionSummary` null).
- [ ] M1-T4 Wire `cli/src/utils/sdk-event-handlers.ts:handleFinish`: emit typed block instead of `type:'text'` with `formatCompletionSummary(summary)`. Keep `formatCompletionSummary` export for logs/tests.
- [ ] M1-T5 Route in `cli/src/components/blocks/single-block.tsx` (`case 'completion-summary'` → `CompletionSummaryBox`), thread `availableWidth`/`markdownPalette`/`onInsertCommand` as needed (no new props needed, but keep parity with plan/gate).
- [ ] M1-T6 Tests: extend `cli/src/utils/__tests__/completion-summary.test.ts` (data unchanged), add `cli/src/components/__tests__/completion-summary-box.test.tsx` (dark/light, null/empty, mixed verdict), `cli/src/utils/__tests__/sdk-event-handlers.test.ts` for handleFinish block type.
- Validate: `bun --cwd cli run typecheck`, `bun --cwd cli test` (targeted), `tmux-cli` smoke: stream → completion box renders.

### M2 — Memory interactive box (P1, vertical slice 2)
- [ ] M2-T1 Extend `chat.ts`: `MemoryContentBlock { type:'memory', status:'empty'|'status'|'prune-result', revision?, updatedAt?, goal?, counts?, evidence:{live,stale,total}, stalePaths?, hint?, pruneOutcome? }` or reuse raw `TaskMemoryV1` + reconciled evidence; decide in slice kickoff (prefer minimal view-model to keep renderer pure).
- [ ] M2-T2 New renderer `cli/src/components/renderers/memory-box.tsx`: header `revision · age` (`formatAge`), goal preview 120 chars with expand, counts grid, evidence badge (`fresh/stale` colored), collapsible `Stale paths (5)` via `CollapseButton`/`Button`, empty state copy ("written after your first successful run"), error banner for prune failure reasons.
- [ ] M2-T3 Refactor `cli/src/commands/memory-command.ts`: `handleMemoryCommand` returns `{ blocks: ContentBlock[] }` or typed message payload instead of `string`; keep `string` fallback export for `handleMemoryCommand` tests via wrapper. Preserve `WorkspaceJournalService.create → collectWorkspaceMoves` move-rebinding for both status & prune.
- [ ] M2-T4 Wire `cli/src/commands/command-registry.ts` memory handler: `getSystemMessage(string)` → typed memory block insertion (mirror `appendLocalMessage` but block-aware; add `appendLocalBlocks` helper if needed, keep `appendLocalMessage` for other commands until M3).
- [ ] M2-T5 Interactions: `Button` "Prune stale evidence" → `onInsertCommand('/memory prune')`, hover `borderColor theme.foreground`, `DASHED_BORDER` not used (harness = solid).
- [ ] M2-T6 Tests: update `cli/src/commands/__tests__/memory-command.test.ts` (block shape), add `memory-box.test.tsx`, add move-aware prune integration test (rename fixture → stale rebounds, not deleted).
- Validate: `bun --cwd cli test` memory + command-registry, tmux `/memory` → box, `/memory prune` flow.

### M3 — Sweep remaining plain-text reports (P2)
Each command gets minimal typed block + box, reusing `HarnessBox`.

- [ ] M3-T1 `context` (`cli/src/commands/context.ts`): `context` block + `ContextBox` (ledger breakdown, trigger/target budgets).
- [ ] M3-T2 `info` (`cli/src/commands/info.ts`): `info` block + `InfoBox`.
- [ ] M3-T3 `doctor` (`formatOpenbuffProviderStatus` + diagnostics): `doctor` block + `DoctorBox` (split provider status vs diagnostics sections).
- [ ] M3-T4 `index` (`cli/src/commands/index-command.ts`): `index-status` block + `IndexStatusBox`.
- [ ] M3-T5 `plan-status` + `plans` (`formatPlanStatusReport`/`formatPlanListReport`): `plan-status-list` block + `PlanStatusBox` (preserve `STATUS_BADGE` `[active]/[paused]/…`, `progress done/total`, `currentTask`).
- [ ] M3-T6 `help` audit: if it bypasses box system, migrate; otherwise mark out-of-scope with reason in STATUS matrix.
- [ ] M3-T7 Registry wiring: replace `getSystemMessage(string)` calls for each with block helper; keep `appendLocalMessage(string)` deprecated path until all migrated, then remove or keep shim for skills.
- Validate: per-command tests + one combined `command-registry` sweep test; tmux checklist `/context /info /doctor /index /plan-status /plans`.

### M4 — Hardening + docs
- [ ] M4-T1 OpenTUI safety audit: every box wraps markdown/`span` in `<text>`, no `{' '}` whitespace, `minWidth:0` on flex cols, resize 1→2 col not collapsing. Add to `cli/knowledge.md` "HarnessBox" note.
- [ ] M4-T2 Theme parity: `dark` + `light` via `useTheme()`; `messageTextAttributes` preserved.
- [ ] M4-T3 Update `docs/architecture.md` (CLI TUI section) pending-gate box inventory.
- [ ] M4-T4 `LESSONS.md` capture: string→typed-block migration pattern for future harness surfaces.

## Dependencies
M1 primitive extraction before M1-T3/M2-T2/M3 boxes. M1-T2 (chat types) before any box. M2-T3 (memory command contract) before registry wiring. M3 can parallelize T1-T5 after harness-box lands.

## Risks
- `CompletionSummaryBox` icon drift from `formatCompletionSummary` emoji → mitigate: keep string formatter for logs, box uses theme tokens (not emoji parsing).
- `handleFinish` text→block change breaks `sdk-event-handlers.test.ts` snapshots → update snapshots, keep null-path.
- `memory-command` string→blocks breaks existing tests expecting `string` → keep backward-compat wrapper or update test to assert block shape.
- Move-rebinding regression (rename → stale → prune deletes) → explicit test with `WorkspaceJournalService` mock moves.
- OpenTUI reconciler fragility (`<text>` nesting) → reuse `PlanBox`/`GateStateBox` patterns verbatim.

## Validation gates
- `bun --cwd cli run typecheck`
- `bun --cwd cli test` (or `bun test cli/src/utils/__tests__/completion-summary.test.ts cli/src/utils/__tests__/sdk-event-handlers.test.ts cli/src/commands/__tests__/memory-command.test.ts`)
- `tmux-cli` (via `tmux-cli` agent): streaming → completion box, `/memory`, `/memory prune` (move-aware), `/context /info /doctor /index /plan-status /plans` sweep.
- No new `common/` contract beyond `chat.ts` ContentBlock extension; no `sdk/` provider change.

## Out of scope
- `read-edit` / `shell-policy` surfaces (separate sessions).
- `common/src/templates` agent examples.

## Resume pointer
Next concrete step after gate: `M1-T1 + M1-T2` (harness-box + chat types) — single editor slice, no validation bypass.
