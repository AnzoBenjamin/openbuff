# Shards 5+6 — Status/feedback/errors, theme system, transcript core

Auditor: orchestrator (agents unavailable).

## Up to standard

- **Transcript virtualization** (`message-list-window.tsx:27-31`):
  viewport-windowed message list with fixed-height spacers preserving scroll
  height, a compensating scroll writer for above-viewport changes (:18), and
  scrollToLatest — the hard streaming-scroll problem, solved properly.
- **Theme discipline**: 113 `useTheme()` sites vs ZERO production ad-hoc hex
  colors (the 9 hex grep hits are all in `__tests__/code-block.test.tsx`
  fixtures). Outstanding token hygiene.
- **Status bar** (`status-bar.tsx:95-107`): carries model name, session cost
  in cents, compaction-budget chips — high information density in one line.
- **Status-severity language**: statusGlyph + tone chips (error/warning/muted)
  shared across discovery/status surfaces — consistent glyph vocabulary.
- **Per-block error boundary** (blocks-renderer) replacing whole-app blanks —
  resilience up to standard.
- **Provider status** (post-fix): coalesced muted single status line.

## Findings

1. **MEDIUM — thinking/reasoning presentation is basic.**
   `blocks/thinking-block.tsx` wraps the Thinking component with
   complete/streaming state but no duration, token cost, or per-turn summary
   header; collapsed reasoning shows no gist line. Claude Code's collapsible
   "Thought for Xs" header is the bar.
2. **MEDIUM — markdown code blocks lack language labels + line numbers**
   (`blocks/code-block.tsx` — palette-rich syntax highlighting exists, but no
   filename/lang header chip on plain code blocks in messages; tool cards
   compensate with their own headers).
3. **LOW — cost shown in cents** (`status-bar.tsx:104-106`): "$0.42" reads
   faster than "42¢" for most users; minor formatting polish.
4. **LOW — emoji vs glyph mixing**: statusGlyph vocabulary is textual/dot
   based while some banners/cards use emoji (⚙ in input-mode, ✓/▲ glyphs
   elsewhere) — one iconographic language should win.
5. **LOW — onboarding/help surfaces are banner-shaped** (help-banner,
   input-mode-banner) — good content, standard presentation; a first-run
   guided hint (key cheatsheet) is the missing award-winning touch.

## Coverage receipt

message-list-window.tsx (virtualization model), status-bar.tsx (content
model), thinking-block.tsx (structure), code-block tests (palette shape),
theme hygiene sweep (production greps), banners inventory. Not deep-read:
full theme palettes contrast math, init/ onboarding flow — flagged.
