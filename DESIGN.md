# Design

## Source of truth

- Status: **Active** — implementation and scoped checks pass; exact scenario certification, saved-history recovery design, independent review and human/emulator acceptance remain open. [Current status](docs/design/cli-overhaul/README.md).
- Last refreshed: 2026-11-10.
- Primary product surfaces: Openbuff terminal CLI (React/OpenTUI), launch/setup/questions/sessions and command/install/update output, with embedded OAuth callback and SDK dashboard supporting surfaces.
- User brief: a clean, understandable interface that makes large or complicated content readable and lets people navigate expanded output comfortably.
- Current refinement: a compact wordmark/project header, quiet graphite surfaces, bright green primary headings and task boundaries, restrained composer borders and caret, text-based mode selection, and grouped structured results. Prefer readable field labels and outcomes over JSON syntax and protocol metadata; keep Inspect available for captured evidence. Short tool summaries share a single row when their complete text fits. Saved sessions and review choices use the same left-aligned hierarchy. [OpenTUI 0.8 refinement](docs/design/cli-overhaul/REFINEMENT.md).
- Evidence reviewed: [acceptance and source/test coverage](docs/design/cli-overhaul/ACCEPTANCE.json), [research](docs/design/cli-overhaul/RESEARCH.md), [implementation plan](docs/design/cli-overhaul/PLAN.md), [wireframes](docs/design/cli-overhaul/WIREFRAMES.md), existing [provider setup guidance](docs/openbuff-provider-model-setup-ux.md), CLI source and tests cited in those documents.
- Audit snapshot evidence: 160 primary sources / 44,072 lines across 19 groups; local hash/full-read coverage check, selected passing regression suites, offline OpenTUI fixture frames and injected probes. Limits: no live whole-CLI/browser/emulator/accessibility baseline or usability study; source coverage is distinct from visual validation.
- Current polish evidence: [green identity, readable inspection, compact decisions and validation](docs/design/cli-overhaul/UI-POLISH.md).
- Latest refinement evidence: [OpenTUI 0.8 checks and previews](docs/design/cli-overhaul/REFINEMENT.md): passing broad CLI/native schedules, final MCP display regressions, typechecks and compiled/native validation, plus light/dark fixtures at 100 and 60 columns.
- Earlier overhaul evidence: [validation snapshot](docs/design/cli-overhaul/README.md): 4,419 passing CLI tests, 148 passing isolated native checks, 1,530 fixture frames and 14 compiled CLI PTY phases. All 200 item IDs have review records; executed acceptance differs from source support. [Reference-machine performance](docs/design/cli-overhaul/PERFORMANCE.json). Historical generated evidence and duplicate implementation notes were removed before committing.

## Brand

- Personality: precise, calm, capable, approachable.
- Trust signals: clear action outcomes, accurate status, accessible evidence, truthful counts and explicit content availability.
- Retain the recognizable lime-green identity: the dark primary is `#a4e879`, between historical `#9EFC62` and the upgrade’s `#b0d98a`. Use green for primary headings, task boundaries, active mode and keyboard keys; keep ordinary prose neutral.
- Avoid decorative animation, repeated boxes around every item, unexplained abbreviations and walls of implementation metadata.

## Product goals

- Understand what the agent is doing, what changed, what failed and what needs a decision at a glance.
- Read an answer naturally; inspect its evidence without losing the conversation or draft prompt.
- Find a specific line, heading, file, diff hunk or structured field in a large output.
- Keep reading position stable during streaming, folding, loading history and resizing.
- Scope includes UI-facing dispatch, draft, producer-outcome and persistence fixes necessary for trustworthy behavior. Non-goals: general backend redesign, a replacement product platform or an unbounded full-content buffer.
- Success signals: task completion and navigation targets in [PLAN.md](docs/design/cli-overhaul/PLAN.md#acceptance-and-validation).

## Personas and jobs

- Primary: developers directing coding agents and reviewing their work.
- Secondary: developers unfamiliar with agent tool names who need understandable summaries.
- Jobs: launch in the right project; configure BYOK routing; compose and queue work safely; answer questions and review approvals; follow progress; assess changes/validation; inspect evidence; resume previous work.
- Contexts: keyboard-only use, mouse-assisted use, narrow terminal splits, SSH/tmux and long concurrent agent runs.
- Assumption: the terminal remains the primary work surface; confirm through prototype feedback.

## Information architecture

- Primary screen: minimal session identity, conversation, composer and one compact status area.
- Content hierarchy: outcome/action → relevant scope and state → preview → evidence/details.
- Disclosure levels: **summary → inline preview → focused output reader**. Short outputs can remain fully visible.
- Reader: persistent identity/breadcrumb, content, position, local find, structural outline and return action.
- Supporting destinations: Commands, Activity, Changes, Session details, Providers & models and saved sessions. Palette entrypoints can precede permanent navigation. Dashboard/replay share readable evidence patterns; command/install output remains readable plain text.
- Failure and permission summaries remain visible even when their evidence is folded.

## Design principles

1. **Show meaning before machinery.** Describe the action and outcome before raw fields.
2. **Disclosure must retain access.** Distinguish content hidden by the view from content unavailable in the captured result.
3. **Navigation is part of readability.** Long content needs landmarks, find, position and a clear way back.
4. **Protect the user's place.** Background activity never takes over a reading viewport or draft.
5. **Use terminal space deliberately.** Typography, grouping and spacing carry hierarchy; color supports it.
6. **Outcome is a data contract.** Input intent, running state, confirmed success, partial commit, rejected validation and unknown source are distinct.
7. **Preserve user work.** Async results are revision-bound; drafts, queue mode/attachments and unsent answers survive view changes.
8. **Recovery is an interaction.** Explain what Close, Skip, Cancel, Delete and Restore affect; show relevant next steps and available retained evidence.

Tradeoff: the reader introduces one deliberate transition for large content in exchange for predictable space and focus. Inline preview remains available for quick checks.

## Visual language

- Color: extend existing `ChatTheme` semantic roles in `cli/src/types/theme-system.ts`; use light/dark implementations in `cli/src/utils/theme-system.ts`. Keep ordinary content neutral. Pair status colors with text or symbols.
- Typography: inherit the user's terminal font. Use weight, spacing, indentation and short labels; do not assume variable font sizes or web typography.
- Spacing: one column for inline separation; two columns of content inset where available; one blank row between semantic groups. Reduce padding before truncating useful content.
- Shape/elevation: quiet separators and focused boundaries. Strong borders identify input or an active reading destination. No simulated shadows.
- Motion: static loading state with elapsed time; optional restrained animation. Provide a reduced-motion mode before making animation a design dependency.
- Iconography: small consistent text glyphs with words for critical actions; ASCII fallback where terminal glyph support is limited.
- Prose: target approximately 80–100 columns on wide terminals, while code/tables can use the full reader width. Validate this with real terminal captures.

## Components

- Reuse: Button, SelectableList, searchable-list hooks, MultilineInput, native Markdown, DiffViewer, existing tool registry, windowed transcript and centralized scroll management.
- Change: quiet inset inspect links with hover/focus emphasis; native Markdown task instructions; readable indented reader fields with an explicit Raw view, exact scalar copy and Enter for full values; segmented keyboard help with a complete command guide; compact status and responsive pickers. Mode popups sit one clear row above the composer boundary and paint above it.
- New: OutputReader, document adapters, reader outline/find/position controls, content-availability labels, explicit focus scopes, Activity/Session details destinations and shared list/detail flow patterns.
- Repair before style expansion: grapheme/cell-aware editing and truncation, draft revisions, command dispatch, producer-result adapters, typed question values, viewport selection, native media fallback and clipboard feedback.
- States: queued, running, succeeded, failed, cancelled, partial, empty and unavailable. Derive states from authoritative lifecycle/result fields.
- Ownership: themes in the existing theme system; content adapters under CLI utilities; reusable reader components under CLI components. Proposed file names and dependencies are in PLAN.md.

## Accessibility

- Target: WCAG-inspired readability and keyboard criteria adapted to terminals; do not claim blanket WCAG compliance for a TUI.
- Keyboard: visible focus and one event owner. Composer bindings retain existing semantics; reader navigation is scoped. Escape closes reader find before the reader; this must not accidentally cancel a run.
- Contrast: target 4.5:1 for normal text and 3:1 for meaningful boundaries on controlled surfaces. Built-in themes paint their own terminal background (`#151815` dark, `#fafbf7` light) and repaint it when switching themes. Validate main background, surfaces and actual rendered output.
- Screen readers: establish an actual terminal/screen-reader baseline; provide a linear plain-text reading/export route. Do not assume browser ARIA applies to OpenTUI.
- Reduced motion/sensory: static progress option, no color-only state and no rapid repeated flashing. All meaningful actions available without hover.

## Responsive behavior

- Existing global layout thresholds: 50/100/150 columns and 20/40 rows (`cli/src/hooks/use-terminal-layout.ts:23`). Current comments differ; code values are the baseline.
- Default reader replaces the conversation viewport and preserves it underneath.
- Proposed internal outline: visible when at least 120 columns and 24 rows are available; otherwise an explicit outline picker. This is a new reader capability threshold to validate, not a change to global layout labels.
- Below 20 rows: single compact reader header; optional metadata hidden; search/outline appear one at a time. Preserve content and return access.
- Tables: narrow layouts show a row-detail view or explicit horizontal viewport. Never silently drop columns.
- Code/diffs: unified diff by default; side-by-side only when both sides have adequate width. Keep source line numbers stable across visual wrapping.
- Touch is not a primary CLI interaction; mouse is an enhancement to the same keyboard-accessible actions.

## Interaction states

- Loading: action, state and elapsed time; distinguish loading from empty/unavailable. Use static “Waiting for provider” and “Receiving response” labels, retaining specific tool phases, elapsed time and Stop. Live reasoning labels its receiving state. Lifecycle and transient notices are independent, so retry/copy feedback cannot hide Stop/timing. Streaming stays readable without rearranging earlier sections.
- Empty: distinguish no matches, successful empty output and output not captured.
- Error: visible failure/partial summary and relevant excerpt, with access to retained evidence. Offer a next action only when it exists.
- Success: brief confirmed outcome, with validation counts only when authoritative. Unknown result fields never imply success; committed changes after cancellation remain committed with cancellation noted.
- Disabled: explain why an action is unavailable, particularly inspect/export of missing content. Publishing/feedback entrypoints reflect current local capabilities; dormant forms need design work only if enabled.
- Offline/slow provider: keep retained results and reader available; expose retry/stop through existing lifecycle semantics.
- Paused following: stable “Reading earlier · new updates · Latest” affordance; count meaningful updates, not tokens.
- Async flows: bind request/result to project, selected run and draft revision; discard stale responses without losing current work.
- Search: show actual shown/matched counts, explain presentation caps and retain a visible partial-source notice alongside results. Batched query/navigation/Enter uses the latest selection; repeated Enter activates once, and inventory refresh preserves selection identity or requires deliberate reselection.
- Decisions: panels spanning the available composer width with content-sized height, windowed choices with reserved description/custom-input space, and separate action controls. Use the full content width for questions, labels and descriptions; add space around controls when height permits. Preserve command line breaks. Full command/question inspection, typed answer identity and validation remain available; Back/Close, Skip and Stop have explicit effects.
- Commands/help: stretch to the available terminal width while keeping height bounded. Preserve command labels before allocating space to descriptions; help dismissal stays at the right edge. Help retains the conversation and composer.
- Result disclosure: make hidden captured rows directly expandable in the conversation with keyboard and mouse controls. Preserve expansion and page position when transcript rows remount; page large retained lists, and label producer omissions separately. Inspect remains available for focused reading.
- Command settings: bare settings commands open a themed picker with current values, descriptions, Apply and Back. Explicit arguments remain available. Permissions changes affect the next run; attached-server policy remains controlled by the server. Doctor and other local diagnostics show grouped human labels and inline details before raw evidence.
- History loading: mount each retained message and each Markdown body once. Reveal earlier messages without duplicating eager prose or leaving stale terminal cells, while retaining legitimate repeated messages and the user's reading anchor.
- Memory telemetry: count reused evidence and newly accepted decisions, with explicit reasons for full discovery. Zero reuse is valid for unscoped searches or absent fresh evidence; presentation must never invent saved reads or imply a scan failure is an empty memory store.
- Queue: FIFO next prompt, attachment identity and enqueue-time mode visible; failed send stays distinguishable from pause, with retained work.
- Queue recovery: per-item mode edits preserve prompt/attachments; clear confirmation fixes its scope to previewed IDs and offers full inspection. Undo restores the last removed item/batch paused, with its original order, mode and attachments. Recovery remains available until the next removal or session exit; clearing queued work leaves the current run running.
- Destructive actions: preview affected scope, preserve preview options exactly for apply, and expose recovery/confirmation according to actual capabilities.
- Freshness: show last successful source/check time where known; absent pending update or empty journal fallback cannot imply up to date or genuinely empty.

## Content voice

- Plain, specific, concise. Prefer “Searched 18 files” over an unexplained tool identifier.
- Status words remain consistent across transcript, reader and picker.
- “Preview” reveals a bounded excerpt; “Inspect” opens the reader; “Back” returns to the originating block.
- Hidden output: “Showing 50 of 180 captured results.” Missing output: “Only 50 results were captured.” Unknown totals: “More results may be available.”
- Summaries describe captured facts. Rendering should not make extra model calls to summarize output.
- Primary actions describe intent: “Skip question,” “Stop run,” “Inspect captured output,” “Restore these changes.” Avoid ambiguous “Close” when it changes execution.
- Plain command help exposes supported commands and examples; replay is labeled recorded. Install/update messages report phases/outcomes on the appropriate human channel without contaminating machine stdout.

## Implementation constraints

- React 19 + OpenTUI 0.8.3; Bun 1.4.4 for development, CI and renderer verification, as documented in `docs/testing.md` and `cli/package.json`.
- Native syntax resources belong to their renderer's scene. Cache per owner and palette; never reuse a style handle across renderers. Await renderer closure before exiting or reusing terminal streams.
- Reuse native Markdown/diff and existing semantic themes. Do not revive the removed legacy Markdown renderer.
- Preserve one scroll writer per viewport, width- and revision-aware message measurements, actual scrollbox chrome heights and user collapse intent. Restore logical anchors on resize and prevent queue activity from taking over paused reading.
- `ToolContentBlock.outputRaw` is retained UI data, including existing media sanitization; it is not a guarantee of the complete original tool payload (`cli/src/utils/message-block-helpers.ts:2269`).
- Content adapters must remain bounded/lazy. Large JSON, cycles, media, control sequences and incomplete Markdown need explicit handling.
- Reader view state is separate from serialized conversation data; stable identity and old-session compatibility require tests.
- Adapters follow real runtime shapes, including child envelope/value, salvage receipts and producer truncation. Share outcome/availability mapping; avoid substring verdict classifiers and success defaults.
- Keyboard editing is grapheme-safe; layout/truncation uses terminal cells. Browser supporting surfaces use their own platform semantics and accessibility checks.
- Document projections are bounded/lazy; avoid exponential DAG expansion, unbounded regex highlighting and full stringify/copy on each streaming frame.
- Verification: deterministic captured fixtures, focus/anchor integration tests, real tmux captures, performance measurements and a short usability study. The implementation plan defines the gates.

## Open questions

- [ ] Confirm reader-first versus an optional persistent side pane through prototype tasks; reader-first is the proposed default.
- [ ] Confirm default preview density with developers using 80×24 and wide terminals. The latest feedback favors quieter repeated inspect links and compact decision panels. The user’s trailing “Also” may introduce an additional issue.
- [ ] Establish supported screen-reader/emulator combinations and validate plain-text reading.
- [ ] Keep complete-output claims qualified by each adapter's retained source and limits; final family-level checks do not establish every original audit clause.
- [ ] Tune reader outline width and performance budgets with developer feedback; the current reference-machine reader measurements are recorded in PERFORMANCE.json.

## Whole-product flow contract

| Flow                     | Required behavior                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Launch/project           | One-time launch intent, recoverable selection error, loading/partial/no-match states and valid path navigation                          |
| Provider/model/OAuth     | Clear BYOK setup path, saved-versus-pending route, visible selection/error at narrow sizes, cancellable diagnostics and preserved draft |
| Compose/edit/queue       | Lossless Unicode editing, explicit edit/fork context, revision-bound draft recovery and FIFO work with fixed mode/attachments           |
| Question/approval        | Full bounded content, typed values/validation, request ownership and distinct close/skip/stop effects                                   |
| Output/change/review     | Authoritative outcome plus readable summary, retained evidence, file/hunk navigation and exact validation status                        |
| Status/help/health       | Persistent Stop/timing, inspectable details, accurate counts, combined health and known freshness, deliberate help dismissal            |
| History/dashboard/replay | Loading versus empty/unavailable, selection-bound content, scope/cap labels, source-aware reading and deletion recovery                 |
| Commands/install/update  | Complete discoverability, exact argument/preview scope, timely streaming, truthful completion and clean human/machine channels          |

The exhaustive [PLAN.md](docs/design/cli-overhaul/PLAN.md) defines dependencies and validation for every flow. A visual token change alone does not satisfy this design contract.
