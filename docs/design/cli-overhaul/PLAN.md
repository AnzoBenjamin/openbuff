# Openbuff CLI UI overhaul plan

Status: **Implemented with scoped automated checks; complete acceptance remains open**, refreshed 2026-11-05. See the [current validation and remaining work](README.md) and [per-item acceptance](ACCEPTANCE.json).

Design contract: [DESIGN.md](../../../DESIGN.md). [Award research](RESEARCH.md) · [Wireframes](WIREFRAMES.md) · [Acceptance and source/test coverage](ACCEPTANCE.json).

## Recommended direction

Build a calm coding workspace with trustworthy outcomes, safe drafting and predictable navigation. Keep the conversation readable; present an action's outcome, affected scope and attention needed before technical detail. Long content uses **summary → bounded preview → focused output reader**, with structural navigation, find, logical position and a reliable return to the conversation.

The exhaustive audit extends this direction to the entire product: launch/project selection, BYOK setup, composer/history/queue, questions/approval, tool and agent outputs, diffs/review, status/help, saved sessions, dashboard/replay and install/update. Correctness and state preservation are part of the UI overhaul: an elegant summary must accurately report what happened, and moving between views must preserve the user's work.

The visual language adapts Things' quiet hierarchy, Bear's folding/outline/find, Flighty's persistent live context, Gentler Streak's readable metrics, Notion's mixed-content structure and NBC Big Board's understandable evidence. Recognition and documented interaction patterns are distinguished in RESEARCH.md. These are design references, not a promise of an award or a pixel imitation.

## Evidence and scope

The original three-lane review focused on reading, navigation and visual hierarchy. The user's request for exhaustive coverage prompted a separate audit: **160 primary sources / 44,072 lines / 19 groups**, with five completed discovery tasks, eight engineering domains per group and **200 raw observations**. Primary sources and selected producer, persistence, command and test contracts were traced. The retained acceptance record maps every item to its surface group and relevant source/tests; historical inventory hashes and generated captures were removed during cleanup.

The inventory includes dormant/restored-only code as well as active UI. The embedded SDK dashboard, OAuth callback page and canonical npm wrapper are included. Backend packages are selected UI-contract context, not a whole-repository backend/security audit. Local filesystem discovery and a local coverage checker were used because native index/inventory/audit tools were unavailable; no native coverage receipt is claimed.

Existing strengths to preserve: native Markdown and diff rendering, usable inline excerpts, focused button primitives, windowed history, centralized scroll writing, semantic themes, BYOK configuration, existing provider persistence, output sanitization and separate human/machine channels. Current headless OpenTUI frames and injected probes confirm selected defects; they do not establish full live-terminal usability. See README.md for executed checks and limits, and ACCEPTANCE.json for clause-level evidence.

## Information architecture

The main screen has session identity, the conversation, a composer and one compact status area. It offers named destinations for **Inspect output**, **Activity**, **Changes**, **Session details**, **Commands**, **History** and **Providers & models**. These may begin as palette destinations; a permanent sidebar is optional after task testing.

| Destination | Primary content | Return behavior |
| --- | --- | --- |
| Conversation | User intent, readable answer, outcome rows, active decision | Preserve transcript anchor and composer draft |
| Output reader | One retained output with title, outline/find, position and availability | Return to the originating result and focus |
| Activity | Running/queued/completed jobs and child agents | Return without enabling transcript auto-follow |
| Changes | Files → hunks → validation, mutation outcome and recovery details | Retain selected file/hunk and review context |
| Session details | Actual provider/model, context/memory/index health, known freshness | Retain composer and conversation |
| Commands/history | Searchable actions and saved work with scope/cap labels | Preserve previous focus; activation follows command semantics |
| Providers & models | Setup, connection checks and route editing | Save/discard/cancel is explicit; validation retains draft |

No extra model call is required to generate UI summaries. Summaries use authoritative structured facts; an unknown outcome remains unknown.

## Shared interaction contract

- **Summary:** one or two rows: action, scope, authoritative lifecycle/outcome and count when known. Failure, partial apply and pending decisions remain visible when folded.
- **Preview:** initially 4–12 *visual* rows, bounded by available height. Logs expose useful head/tail context; search shows file/match grouping; diffs show representative hunks. Tune the default density through tasks.
- **Inspect:** a separate reading viewport for retained content, with Back, identity, current logical position, find and outline. Short content can remain fully visible.
- **Availability:** distinguish display omission, producer truncation, captured excerpt, missing historical source and unknown totals. “Showing 50 of 180 captured” differs from “Only 50 were captured.” Inspect never fabricates omitted source.
- **Focus:** one action owner per key event. Composer, palette, question, reader, local find/outline and confirmation have explicit scopes. Escape dismisses the current scope before any global interruption action.
- **Draft ownership:** navigation and local async commands cannot replace newer edits. Queue entries retain their text, attachments and agent/mode at enqueue. Edit-and-resend clearly describes context branching and keeps visible and SDK history consistent.
- **Status:** lifecycle, transient notice and source health are separate data. Running/retrying retains timing and Stop. A write proposed by input is not a confirmed write; cancellation after a confirmed commit remains committed with cancellation noted.
- **Recovery:** Close, Skip, Cancel, Delete and Restore describe their actual effect. Protect unsent edits and show preview/recovery for destructive operations using existing capabilities.

## Reader layout choice

| Option | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| Inline expansion | Familiar for quick checks | Very large content competes with transcript scroll | Keep bounded preview |
| Reader replacing conversation viewport | Predictable width, focus and return on terminal splits | Explicit transition to inspect | **Default** |
| Persistent conversation/reader split | Convenient repeated comparison | Two focus scopes and reduced width | Optional after task testing |

The reader can have its own outline beside the body at a proposed minimum 120 columns × 24 rows; narrower terminals use an outline picker. Global current thresholds remain 50/100/150 columns and 20/40 rows (`cli/src/hooks/use-terminal-layout.ts`). Below 20 rows, compact chrome and one temporary panel at a time preserve body space and Back. Width thresholds are prototype hypotheses, not established usability results.

## Improvements across every surface

| Surface | Planned improvement | Evidence groups |
| --- | --- | --- |
| Launch/project chooser | Recoverable inline errors, explicit loading/partial/empty states, valid path actions, stable project-switch generation and one-time launch intent | 01 |
| Provider/OAuth/model setup | Guided BYOK onboarding, searchable bounded list/detail, visible selection and save/error feedback, preserved custom draft, cancellable connection checks and manual OAuth recovery | 02 |
| Composer/shell preview | Grapheme-safe selection/editing, draft undo/recovery, accurate width after mode expansion, stdout/stderr visibility, cursor/scroll position and inspectable shell result | 03 |
| Palette/files/history/attachments | Command insert-versus-execute semantics, honest search scope, responsive geometry, full attachment identity/preview and retry/remove | 04 |
| Queue | FIFO head and attachments visible; mode captured at enqueue; edit/reorder/restore actions; distinct rejected/paused/cancelled state | 04, 14a |
| Conversation/edit/copy | Explicit edit/fork state, SDK/transcript consistency, retained draft/anchor, keyboard copy with exact scope and visible failure | 05a |
| Markdown/reasoning/nested agents | Outcome-first child rows, retained structured/media content, stable IDs, chunk-independent parsing and recoverable fallback | 05b |
| Navigation | Logical anchors across resize/revisions/prepend, correct chrome measurement, selected-result actions, local find, outline and Latest | 06 |
| Search/index/LSP/read tools | Producer metadata-aware grouping, exact path parsing, bounded safe highlighting, partial/stale/cached labels and retained-source inspection | 07 |
| Changes/diffs/validation/review | Canonical mutation outcome and counts, file/hunk associations, stdout/stderr evidence, partial commits and failed preflights visible, next-change navigation | 08 |
| Jobs/plan/recall/coverage/harness tools | Typed producer adapters, visible failure/timeout/availability, structured evidence and deep links rather than opaque counters | 09a |
| Spawn/custom/MCP/terminal/receipts | Preserve child value/envelope, literal JSON stdout, exit/outcome, pending/salvage receipt state and inspection beyond display projections | 09b |
| Questions/command approval | Full bounded question/option/command reader, typed answer identity, validation, concurrent request ownership and distinct Close/Skip/Stop semantics | 10 |
| Publish/feedback | Capability-aware command/action availability with a useful existing issue route; dormant form polish is conditional on feature enablement | 10 |
| Status/help/memory/index/errors | One status hierarchy with inspectable details, correct diagnostic counts, combined source health/freshness, persistent help and readable recovery | 11 |
| Shared primitives/themes/media | Keyboard/mouse parity, viewport-aware selection, cell-aware truncation, normal-text contrast, static motion and native image failure fallback | 12 |
| Saved chat/plan sessions | Loading versus empty, workspace/task/outcome identity, narrow list/detail, explicit New Chat and deletion recovery | 13 |
| Dashboard | Selection-bound requests, freshness/refresh/retry, disclosed timeline cap and structured event/gate/receipt reader | 13, 14c |
| Slash commands/diagnostic artifacts | Common busy dispatch, immediate unknown-command help, preview-bound apply, lossless arguments/drafts and navigable artifacts | 14a, 14b |
| Help/headless/replay/serve | Complete public command directory, bounded numeric errors, timely human streaming, recorded replay inspector and separate protocol stdout | 14c |
| Install/update/compatibility | Compact relevant onboarding, accurate update freshness/outcome, phase-aware recovery, width-aware TTY and clean redirected/protocol output | 15 |

Each group has full finding details and acceptance criteria in the audit. The [backlog](ACCEPTANCE.json) maps every raw ID to an owner, phase and dependency. Shared repairs should fix related surfaces together; avoid independently patching several verdict or truncation classifiers.

## Implementation sequence

### Phase 0 — Reproduce and repair high-impact state/outcome failures

Create deterministic fixtures for the confirmed problems before changing layout. Prioritize: busy review/interview/mode queue bypass; compaction apply losing preview options; dashboard stale-response race; invisible edit latch; launch prompt resubmission; failed preflight appearing passed; spawn/salvage output loss. Add meaningful regression coverage to the actual boundary involved.

Separate launch intent from remount state, bind async work to a generation/revision, route every execution command through common busy handling, and align edit history with SDK context. Preserve drafts during Execute Plan, route changes, attachments and local commands. Keep failed project selection inside the picker with a recovery action.

**Exit:** reproduced state/outcome defects have targeted passing regression checks; no silent draft replacement, duplicate initial submission or mismatched preview/apply scope in these fixtures. Design prototypes consume trustworthy state.

### Phase 1 — Establish contracts and reusable fixture baseline

Trace every result family from producer through retained block and saved-session restoration. Define a common display contract for lifecycle/outcome, result payload, retained version, content availability, counts/limits, diagnostics and media. Parse only actual tool envelopes; literal command JSON stays literal. Renderers do not invent fresh/active/success state from missing fields.

Extend existing CLI boundaries rather than creating a second theme/state system. Suggested new utilities: `output-document.ts` for document identity/kind/coverage/outline/ranged access and `reading-state.ts` for logical anchors, focus and disclosure. Confirm file names during implementation. Share status/verdict/availability mapping and character-cell measurement where practical; do not leak transport details into user labels.

Capture real current-component fixtures in both themes at 80×24, 100×30, 120×32 and 160×40, plus 60×18: launch, setup, Unicode draft, queue, active/retrying/failed run, long Markdown/log/diff/search/JSON, nested agents, questions/approval, history, diagnostics and dashboard. Use local fixtures without provider calls. The existing five character frames are partial starting evidence.

**Exit:** every surface has fixture/state ownership; shared contracts cover active/legacy/custom inputs; baseline task timings and keyboard map are recorded.

### Phase 2 — Repair primitives, draft safety and focus ownership

Fix selection visibility on height-only resize, cell-aware path/filename truncation, grapheme-safe editing and selection replacement. Keyboard actions must be reachable without hover, including copy, inspect, remove attachment, retry and New Chat. Clipboard failure shows an actionable status; success is reported only after completion. Image cards use native image rendering with explicit fallback and useful alt/source information.

Apply semantic colors/spacing to the existing theme system. Improve controlled normal-text contrast, selected/focused states and static motion. Separate capacity bars from task-progress bars. Keep action controls visible on compact screens and budget headers, borders, gaps and wrapped options using actual visual height.

Introduce scoped Escape/Tab/Enter behavior and revision-bound draft restoration. Do not repurpose composer Ctrl+F globally; Ctrl+P/R/T retain their established semantics unless a deliberate documented migration is warranted.

**Exit:** keyboard-only operations, Unicode drafting, short-height lists and light/dark fixture checks pass. No hidden composer submission when another scope owns input.

### Phase 3 — Build the text/log reader and transcript navigation

Start with Markdown/text and terminal logs to validate Inspect → Find → Jump → Back. Keep title/Back/position visible, provide logical line/heading locations and freeze/follow state for streamed logs. Unknown log structure uses lines/find rather than invented sections.

Use stable message/tool-call/block identity plus logical line/character, heading, hunk or field path. Track content revision and width for measurements; include actual scrollbox header/control heights. Mounted remeasurement, width-invalidated estimates and same-width ID anchoring already exist; repair their specific gaps rather than discarding the centralized scroll design.

Preserve reading anchors through 160→80-column resize, offscreen same-width result updates, history prepend and folding. Queue starts cannot reclaim a paused viewport. A stable “Reading earlier · N new updates · Latest” action indicates meaningful new results/messages.

Add Browse output, Inspect selected output, Find in conversation, Activity and Session details to the palette. Conversation search includes retained collapsed/offscreen content within an honestly stated history scope. Materialize a hit and land at its logical location through existing windowing APIs.

**Exit:** a unique failure near line 9,800 is reachable by keyboard; Back restores transcript focus/position and exact draft/cursor. Reader Escape does not cancel the run.

### Phase 4 — Add content-specific readers and shared evidence navigation

| Adapter | Landmarks and actions | Existing implementation |
| --- | --- | --- |
| Markdown/plan | Headings, repeated-section identity, fold, find, copy section | Native Markdown and block renderer |
| Terminal log | Logical line/range, stdout/stderr provenance when known, find, tail/freeze | TerminalCommandDisplay, TerminalOutput |
| Diff/change | File → hunk, next change, context folding, unified/split, validation details | DiffViewer, edit-transaction, implementor/review |
| Search/read/index | File → match/location, filters, captured range and source identity | Discovery/read/LSP/index components |
| JSON/custom/MCP | Key/value paths and array ranges, exact scalar copy, safe fallback | Tool registry, generic fallback |
| Table/receipt/status | Headers, row details, horizontal view, diagnostics/artifacts | Status/receipt/coverage/harness cards |
| Agent/job/replay | Child/job/step → output/artifact, next issue, source freshness | Agent branches, job tools, journal/replay |

Use retained source rather than capped display strings. Where the producer omitted data, label the limitation and expose only valid available routes. A new current-file read is a new snapshot, never historical evidence. Preserve media sanitization and existing bounded payload policies.

Avoid deep eager traversal, full copies on every streaming frame and exponential dependency-tree expansion. Cache bounded projections by document identity/version and lazily materialize ranges. Profile real parse/layout/search costs; viewport culling alone does not guarantee bounded work. Use safe literal highlighting or bounded matching for untrusted search patterns.

**Exit:** each adapter reaches retained content beyond current UI-only caps, preserves provenance and handles unknown/partial/legacy data without misleading success or blank failure.

### Phase 5 — Overhaul setup, decisions, queue and recovery flows

Use a shared searchable list/detail pattern for projects, providers/models and sessions. At narrow widths, show one pane with explicit Back; retain search/selection/draft. Save/error status remains visible at every size. Setup explains the minimum BYOK steps and optional model routes separately, with cancellable diagnostics and manual OAuth recovery when browser flow fails.

Queue shows the next FIFO prompt, attachments and pinned mode, with an explicit action list for edit/reorder/cancel/restore when supported. Failed-send state names the failure and preserves work. Execute Plan offers a separate action or protects an existing draft.

Questions keep full content in a bounded viewport, validate typed structured answers and distinguish Skip, Back/Close and Stop run. Concurrent questions have explicit ownership/queue/cancellation. Command approval lets the user inspect the complete target before approval. History deletion and tracked-file restore show affected scope and recovery capabilities accurately; use guarded confirmation where restoration is unavailable.

**Exit:** startup, setup, queue, decision and session tasks work at 60×18 and 80×24 without losing work or hiding required controls.

### Phase 6 — Unify status, commands and secondary surfaces

Keep lifecycle, elapsed time/Stop and notices independent. Session details explains model routing, memory/index health and known freshness, with inspected diagnostics/artifact links. Help stays open until dismissed and has bounded reading navigation. Disabled publishing/feedback entrypoints reflect local capabilities rather than leading into a doomed form.

Make top-level and slash help a coherent directory with examples and insert/execute semantics. Artifact, snapshot and memory lists disclose caps and provide a reader. Preview/apply commands bind the exact selected options. Numeric argument errors state bounds and units.

Dashboard uses selection-bound fetches, accessible refresh/empty/error/retry/freshness states and structured trace details. Replay distinguishes recorded events from new inference. Headless human output flushes within a bounded time; NDJSON/protocol output remains complete and clean. Install/update progress uses TTY-aware phases, stdout separation, actual completion/freshness and relevant recovery.

**Exit:** every supporting surface has clear active/empty/unknown/error/cancel behavior and truthful data availability; machine contracts stay compatible.

### Phase 7 — Validate and deliver reviewable slices

Deliver state/outcome repairs, shared primitives/contracts, first reader, adapter families, flow updates and shell polish in separate reversible changes. Each slice carries representative fixtures and meaningful boundary tests. Update DESIGN.md when prototype evidence changes a decision.

The first implementation slice is Phase 0 regression fixtures and the shared draft/outcome repairs, followed by the text/log reader prototype. A static attractive screen does not complete the overhaul; completion requires readable information, discoverable interaction and measured stability across surfaces.

## Acceptance and validation

These targets are proposed, not measured results of the current audit.

| Area | Acceptance |
| --- | --- |
| Draft/history | Emoji/combining text edit losslessly; Navigate/Execute Plan/async command never replaces newer work; edit-and-resend context matches displayed history |
| Dispatch/queue | All execution commands share busy handling; queued mode/attachments remain fixed; FIFO preview, rejected-send feedback and restoration are accurate |
| Decisions | Full long command/question is inspectable; structured answer values survive commas and literal Skipped; close/skip/cancel preserve intended semantics |
| Outcomes | Failed preflight/write/child/partial apply never shows unqualified success; committed changes after cancellation stay committed; diagnostic counts agree |
| Long log | Find failure near line 9,800, move to another match and return to the same transcript/draft with keyboard only |
| Captured search | A retained 300-match result exposes match 251; displayed/captured/producer-limited counts are distinguished |
| Markdown/JSON | Navigate repeated headings and deep fields, copy exact scalar; malformed/partial streams and cycles remain readable with honest limits |
| Diff/table/agent | Traverse 12 hunks across three files; reach hidden columns; inspect failed child without unfolding siblings; preserve file/hunk identity on resize |
| Scroll/focus | Resize, content revision, sibling fold and history prepend preserve logical place; at-tail follows; reader keys cannot submit hidden composer or cancel accidentally |
| Responsive/recovery | Setup, queue, approval and sessions remain usable at 60×18; save/failure/Back remains reachable; clipboard/media/local errors have feedback |
| Secondary surfaces | Dashboard response matches selection and shows freshness; replay finds retained evidence; install/headless output preserves protocol stdout |
| Accessibility | Controlled normal text target 4.5:1; critical boundaries 3:1; terminal-default backgrounds separately tested; no color/hover-only actions; static progress path |
| Performance | Recorded reference hardware: proposed p95 reader key-to-frame ≤100 ms, cached open ≤300 ms; exercise 10,000/100,000 lines, deep JSON and shared agent DAGs while streaming |
| Human task testing | At least 4 of 5 developers find the failure within 20 s and inspect multiple files within 30 s after brief orientation; compare task time, errors and confidence against baseline |

Use regression tests for state/producer boundaries, adapter availability/location tests and integration tests for focus/draft/anchor restoration. Use real fixture-driven tmux captures for terminal geometry, plus browser checks for dashboard/OAuth and an actual screen-reader/plain-text baseline. Cover ASCII/wide glyphs, long lines, combining characters, ANSI/control sequences, missing source and interrupted/partial results.

Run relevant renderer suites with the current pinned Bun runtime (1.4.4) from the CLI package (`bun run test`), and CLI typecheck (`bun run typecheck`). Use the actual documented workspace invocation (`bun run --cwd cli <script>`) where appropriate. Broaden checks when a slice changes shared/runtime/persistence contracts. No additional full suite is required for these planning documents alone.

If measured rendering misses targets, introduce lazy/ranged access and retain a readable fallback. Do not advertise complete content access by removing limits without resource bounds and provenance.

## Remaining design tuning

Assumptions: keyboard-first terminal workspace, existing green accent, reader-first default. Prototype feedback will tune preview density, outline width, optional wide split, supported terminal/screen-reader combinations and performance budgets. These open design questions do not block delivery of the exhaustive audit and plan.
