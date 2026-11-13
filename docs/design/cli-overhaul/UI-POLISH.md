# CLI UI polish — 2026-11-10

The current UI keeps more of Openbuff’s green identity while making captured output and decisions easier to read. The design contract is [DESIGN.md](../../../DESIGN.md), particularly Brand, Components, Responsive behavior and Decisions.

- Dark primary green is `#a4e879`, between the historical `#9EFC62` and the upgrade’s muted `#b0d98a`. Primary headings, task boundaries, active modes and keyboard keys use it. Ordinary prose stays neutral.
- The reader displays indented field labels and distinct heading/value colors. Multiline values have an explicit Enter affordance. `V` switches to original paths; copy/export retain captured data. `/` searches exact captured text; `?` opens the complete keyboard guide.
- Repeated inspect links use quiet inset styling with hover/focus emphasis.
- Agent instructions and Markdown result summaries use the native renderer. Task prose appears immediately while highlighting initializes.
- Mode popups paint above composer boundaries with a clear row between their borders.
- Decision panels span the available composer width with content-sized height. Question and option text use the full content width; secondary actions and footer controls have additional separation on roomy terminals. Windowed choices reserve room for focused descriptions and custom input. Command line breaks, explicit truncation and full inspection remain available. Actions have spacing, and Submit uses one row.
- Opening a reader detail resets horizontal offset and wrapping; returning restores the parent. Batched arrow keys retain the latest choice index.
- Help and command panels use the available terminal width. Command labels stay intact before descriptions shrink. Light and dark themes paint controlled main backgrounds, including theme switches. Waiting and streaming status uses clear static phase text alongside elapsed time and Stop; reasoning labels its receiving state.
- Memory telemetry reports evidence actually reused and newly accepted decisions, with explanations when discovery must run in full. Complete native reads and confirmed mutations retain actual file digests, and retrieval crosses task boundaries without weakening freshness checks.
- Result lists offer Show more and Show less inside the conversation. Large lists page in groups of 50; expansion survives transcript remounts and paging keeps keyboard focus at boundaries. Search, index, discovery, jobs, recall, findings and command reports share the control. Producer omissions remain visible separately.
- Bare `/permissions` opens a themed picker for Balanced, Strict, Allow all and configuration inheritance. Mouse and keyboard selection preview the policy; Apply changes the next run through the existing permissions handler. Explicit arguments remain available, and attached-server policy remains read-only.
- Doctor, context, index, memory and plan reports use readable sections with inline disclosure. Command inspection offers a readable report and access to original captured fields. Malformed, accessor-bearing or oversized saved captures fall back to bounded raw inspection.
- Saved-history loading and unavailable states have one status row. Completed eager Markdown leaves its initial preview mode, and local command feedback marks pending and completed rows explicitly. Reveal tests preserve legitimate repeated message content.

## Validation

- Result disclosure, command reports, permissions and history follow-up: final CLI schedule 4,640 passed, 187 skipped, zero failures; separate native schedule 193 passed across 43 suites with zero skips or failures. CLI typecheck, CI-local guards and full agents/common suites passed. Compiled OpenTUI/tree-sitter probes passed. A fresh compiled tmux session verified keyboard permission application, 60×18 layout, doctor inline expansion and offline saved-history restoration through resizing; the session was closed. The existing local executable was updated with a retained backup.
- CLI: 4,610 passed, 160 skipped, zero failures.
- Native UI: 165 passed, zero skipped or failed across 39 suites.
- Final compact-dialog adjustment: 27 focused checks passed, including validation ownership, retained answers and keyboard navigation.
- Full-width approval correction: 22 focused checks passed, including the actual approval component at 60×18, 100×24 and 160×32.
- Follow-up help, command and theme fixtures passed at 60×18, 100×24 and 160×32 in both themes. Full CLI schedule: 4,613 passed, 162 skipped, zero failures; native UI: 167 passed across 39 suites, zero skipped or failed. The installed binary's live 100×24 help panel spans the terminal with Dismiss at the right edge.
- On the live memory database, two synchronous health scans produced a 9,938 ms main-thread pause. The shared worker scan kept the measured maximum pause at 11 ms. Cache warming affects total-duration comparison; the event-loop measurement establishes responsiveness.
- CLI typecheck and compiled OpenTUI/tree-sitter smoke checks passed.
- Installed `openbuff --smoke-opentui` passed. A separate tmux CLI session verified complete Plan-menu borders at 100×24 and a clean resize to the compact 60×18 composer. The temporary session was closed.
- No provider request was needed for UI verification. Earlier memory/listener and responsiveness fixes remain included.

Native fixture frames and color spans: `/tmp/openbuff-ui-polish-frames/`. The PNG previews below render those captured spans with a monospace font on a dark terminal background.

![Captured output reader](polish-previews/reader.png)

![Full-width approval panel](polish-previews/choices.png)

![Agent task presentation](polish-previews/agent.png)
