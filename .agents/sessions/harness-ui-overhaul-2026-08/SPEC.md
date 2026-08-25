# SPEC — Harness UI Overhaul (Full Sweep)

## Goal
Unify the Openbuff harness into one visual language. Every system surface that currently emits a plain `string → getSystemMessage → <text>` must land on the same bordered, themed, OpenTUI-safe renderer system that `PlanBox` / `GateStateBox` / `AgentBranchWrapper` already use. No more split between premium interactive chrome and `console.log`-style dumps for memory or session summaries.

## Non-goals
- No redesign of already-mature surfaces (`PlanBox`, `GateStateBox`, `AgentBranchWrapper`/`AgentBlockGrid`/`ImplementorRow`/`DiffViewer`, `StatusBar`) beyond extracting a shared primitive they adopt.
- No new backend or provider APIs; no agent-runtime prompt contract change (`task_completed` stays empty).
- No global theming overhaul; reuse existing `ChatTheme` + `BORDER_CHARS` tokens.
- No migration of log/debug artifacts outside `cli/src`.

## Requirements

### R1 — Completion summary becomes a first-class box (P1)
- Data source stays `computeCompletionSummary(blocks)` (`cli/src/utils/completion-summary.ts`).
- New typed block `type: 'completion-summary'` + renderer `CompletionSummaryBox` replaces the `formatCompletionSummary()` → `type:'text'` injection in `cli/src/utils/sdk-event-handlers.ts:handleFinish`.
- Sections: Files (edited/failed/unconfirmed/rolled_back/rollback_incomplete), Hooks (passed/failed/skipped), Review verdict (`BLOCKING/NON_BLOCKING/LOOKS_GOOD/…` → `error/warning/success`), Tests, Auxiliary, Errors. Status → border color + icon mapping mirrors `GateStateBox` (success/warning/error).
- `formatCompletionSummary()` retained for logs/fallback; renderer is the TUI source of truth.

### R2 — Memory becomes interactive and on-system (P1)
- Data source stays `sdk/task-memory-store` + `reconcileTaskMemoryEvidence`/`pruneStale…` via `WorkspaceJournalService`.
- New typed block `type: 'memory'` + `MemoryBox` replaces `string` return from `cli/src/commands/memory-command.ts` (`handleMemoryCommand` → `runStatus`/`runPrune`).
- Layout: header `revision · age` (via `formatAge`), goal preview (120 chars, expand affordance if truncated), counts grid (Decisions · Requirements · Edits / Validations · Blockers · Next actions), evidence `fresh/stale` with colored badge, collapsible `Stale paths (5)` list, empty/no-record state that explains when memory is written.
- Prune affordance: clickable `Button` wired to `onInsertCommand('/memory prune')` (same pattern as `PlanBox` command pills), hover border `theme.secondary → theme.foreground`. Prune failure reasons surfaced verbatim (invalid-record / concurrent-write / write-failed) with no phrasing as "nothing to prune".
- Workspace-move rebinding contract preserved: both status and prune pass `WorkspaceMoveRecord[]` from `WorkspaceJournalService.create`.

### R3 — Sweep remaining plain-text reports (P2)
Convert every `getSystemMessage(string)` report in `cli/src/commands/command-registry.ts` and helpers to typed blocks/boxes sharing the same primitive:
- `/context` (`cli/src/commands/context.ts` — ledger breakdown)
- `/info` (`cli/src/commands/info.ts`)
- `/doctor` (`formatOpenbuffProviderStatus` + agent diagnostics)
- `/index` (`cli/src/commands/index-command.ts`)
- `/plan-status` + `/plans` (`formatPlanStatusReport`/`formatPlanListReport` — retain `STATUS_BADGE`/`progress done/total` + `currentTask` semantics)
- `/help` if it still bypasses the box system; otherwise leave its existing structured screen.
Each gets a minimal typed block (e.g. `context`, `info`, `doctor`, `index-status`, `plan-status-list`) and a `*Box` renderer. No one-off inline styles.

### R4 — Shared harness chrome primitive (P2, extracted alongside R1/R2)
- Extract `HarnessBox` (and `HarnessSection`/`HarnessRow` helpers) that codifies the common pattern: `borderStyle:'single' + BORDER_CHARS + theme token + paddingLeft/right 1 + gap`. Adopted by `PlanBox`, `GateStateBox`, `CompletionSummaryBox`, `MemoryBox`, and the sweep boxes. One change propagates.
- Tokens: `DASHED_BORDER_CHARS` / `IMPLEMENTOR_BORDER_CHARS` remain reserved for ghost/implementor contexts; harness uses rounded `BORDER_CHARS`.

### R5 — Wiring and single-point injection
- `sdk-event-handlers.ts:handleFinish` and `command-registry.ts` (`appendLocalMessage` path) are the only UI injection seams. Change is additive (new block types) not string-format surgery.

## Acceptance criteria
- AC1: A completed run with edits+hooks+review renders a bordered `CompletionSummaryBox` (not a `| -joined` text line); empty runs produce no box (`computeCompletionSummary` null path unchanged).
- AC2: `/memory` (no record) shows the two-line "not yet written" empty state inside a box; `/memory` with record shows revision/age/goal/counts/evidence + stale-list affordance; `/memory prune` with stale entries shows the button and correctly rebinds renamed-file evidence (move-aware).
- AC3: `/context` `/info` `/doctor` `/index` `/plan-status` `/plans` each render as bordered boxes with themed headings (no raw `lines.join('\n')` text blocks).
- AC4: `SingleBlock` routes all new block types; `chat.ts`→`MessageBlock`→`BlocksRenderer` threading of `onInsertCommand`/`markdownPalette`/`availableWidth` matches `PlanBox` precedent.
- AC5: OpenTUI-safe: every markdown / `<span>` / `<strong>` fragment is wrapped in `<text>`; no `{' '}` JSX whitespace; no box-inside-text violations; resize (1→2 column) does not collapse `minWidth`.
- AC6: Theme-correct in `dark` and `light` (`useTheme()` tokens, border `success/error/warning/secondary` mapping, `TextAttributes.DIM/BOLD` where appropriate).
- AC7: Backward-compatible: `formatCompletionSummary` and `formatAge`/`pluralizeEntries` remain exported for logs/tests; block types extend the `ContentBlock` union, never retype existing `text`/`tool`/`agent` fields.
- AC8: Tests: `completion-summary.test.ts` (data), new `completion-summary-box.test.tsx`/`memory-box.test.tsx` (render), `command-registry` integration for move-aware prune, plus one `tmux-cli` smoke for streaming→completion and `/memory` flow.

## Relevant systems
- `cli/src/types/chat.ts` — `ContentBlock` union, `GateStateStatus`, `PlanArtifactMetadata`.
- `cli/src/types/theme-system.ts` + `cli/src/utils/ui-constants.ts` + `cli/src/hooks/use-theme.tsx` — `ChatTheme`, `BORDER_CHARS`.
- `cli/src/utils/completion-summary.ts` + `cli/src/utils/sdk-event-handlers.ts` (finish seam) + `cli/src/utils/message-block-helpers.ts`.
- `cli/src/commands/memory-command.ts` + `sdk/src/services/task-memory-store.ts` + `common/src/types/task-memory.ts`.
- `cli/src/commands/command-registry.ts` + `cli/src/commands/context.ts`/`info.ts`/`index-command.ts`/`plan-artifacts.ts`.
- `cli/src/components/renderers/{plan-box,gate-state-box}.tsx` + `cli/src/components/blocks/single-block.tsx` + `cli/src/components/message-block.tsx` + `cli/src/utils/markdown-renderer.tsx`.
- `cli/knowledge.md` — autoCollapse, toggle, suggestion-menu, streaming markdown constraints.
- Validation: `cli` Vitest/Bun + `tmux-cli` / `scripts/tmux/tmux-cli.sh`.
