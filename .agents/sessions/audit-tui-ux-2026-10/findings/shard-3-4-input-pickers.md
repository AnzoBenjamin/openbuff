# Shards 3+4 — Input experience & pickers/searches

Auditor: orchestrator (agents unavailable). Evidence: greps + targeted reads of
command-palette-screen, suggestion-menu, prompt-history-search-screen,
selectable-list, chat-input-bar wiring (from earlier audit context).

## Up to standard

- **Command palette** (`command-palette-screen.tsx`): real fuzzy subsequence
  scoring (`fuzzyMatch`, prefix/exact boosts at :99-114, description matches
  ranked), unified command+file corpus, empty-query file cap (:37), explicit
  emptyMessage (:366).
- **Prompt history search** (`prompt-history-search-screen.tsx:69`): fuzzy
  scoring over prompts; distinguishes unreadable history from genuinely empty
  (:7) — thoughtful error/state separation.
- **selectable-list**: theme.primary focus/hover highlight with dual-theme
  legibility note (:6-8, :154).
- **Input bar foundations** (from the coherence audit's deep pass): single
  wrap-pass measurement, gutter awareness, placeholder memo, paste handling,
  mode-aware width estimates, compact/full branches — the mechanics are
  excellent.
- **Esc closes pickers** consistently (palette, prompt-history).

## Findings

1. **HIGH — no matched-character emphasis in fuzzy results.** Neither
   command-palette-screen nor suggestion-menu highlights WHICH characters
   matched (grep `highlightMatch|matchedIndices|emphasize`: 0 hits in both).
   fzf/VS Code bold the matched subsequence; here the user must re-derive why
   a row ranked. `fuzzyMatch` already computes positions — unused for display.
   Improvement: bold matched chars in label + file path.
2. **MEDIUM — no recency/MRU ranking.** Empty-query palette caps files but
   has no recently-used commands/files boost (grep `recent|MRU`: 0). Repeat
   workflows re-type; fzf-style history merge is the award-winning bar.
3. **MEDIUM — no keyboard-hint affordances.** No `↑↓ select · ↵ run · esc`
   footer in palette/pickers (grep for hint/↑/↓: 0). New users must discover
   navigation blind.
4. **LOW — suggestion-menu ranking opaque.** File/command/agent suggestions
   render grouped, but no visible reason for order (no recency, no
   match-position signal beyond grouping).
5. **LOW — validation feedback is popover-level** (validation-error-popover)
   rather than inline-at-caret; acceptable, but inline squiggles + hint line
   is the polish bar for input errors.

## Coverage receipt

command-palette-screen.tsx (scoring/filter/empty/cap), suggestion-menu.tsx
(ranking greps), prompt-history-search-screen.tsx (scoring + empty/error),
selectable-list.tsx (selection visuals), chat-input-bar/multiline-input
(carried from the earlier coherence audit's deep read). Not deep-read:
model-route-picker, provider/project/plan pickers (same selectable-list +
fuzzy substrate; flagged for follow-up).
