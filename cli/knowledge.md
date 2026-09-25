# CLI Package Knowledge

## Long-running Agent UX

- Productive agent runs are unlimited by default. `maxAgentSteps` is an optional fixed cap; `-1` selects unlimited mode.
- The runtime stops repeated no-progress patterns separately, and the CLI renders the resulting resumable checkpoint instead of treating it as a missing agent response.
- Completion summaries count final file outcomes, terminal top-level failures, and auxiliary-agent failures without duplicating recovered nested tool errors.
- Regenerate bundled agents and starter type sources with `bun run prebuild:agents` after changing shipped agents or public tool schemas.
- Public agent/tool type changes must also run the repository-root generator (`bun scripts/generate-tool-definitions.ts`); CI verifies `cli/src/data/initial-agent-type-sources.generated.ts` is committed.
- `read_files` selector caps (window `windowSize` ≤ 5000, `around` `contextLines` ≤ 2000) are reflected in generated tool type sources; regenerate after any public read-tool param change so CI's tool-definition freshness check stays green. (The `read_blocks` tool was removed; its selectors are now read_files `windows`/`around`/`symbols`.)

## Memory V2 and Discovery Coverage

- Cross-session task memory lives in `.openbuff/memory/task-memory.json` (gitignored local state) and is backed by an append-only event store; the Bun SQLite repository (`cli/src/services/memory-v2/bun-sqlite-memory-repository.ts`) implements append/query/verify/rebuild/health/export with schema-validated outcomes, hardened local storage (contained DB path, symlink/ownership rejection, `0700`/`0600` perms), and generic fail-closed error classification that never leaks paths. `BunSQLiteMemoryRepository.open()` accepts a strict opt-in `requireSecureOpen`: when true it fails closed with a typed non-retryable `unsupported-open` error and performs zero SQLite/filesystem mutation, because bun:sqlite opens the DB and its `-wal`/`-shm` sidecars by derived pathname only (no fd/dirfd), so a race-free open is provably impossible in pure JS — the default open is unchanged and honestly reports `openPosture: 'pathname-best-effort-unverified-open'` on the open result and in `kernelHealth`, never claiming race resistance. Projection replay is bounded by `MAX_REPLAY_EVENTS` (10,000) with existing `PAGE_SIZE` (250) batching; on truncation `replayProjections` sets the projection cursor to the last replayed sequence and returns `truncated: true` (an honest cursor, never falsely claiming the canonical tail), `rebuildProjections()` surfaces `truncated: boolean`, and the v1→v2 migrate passes `Number.MAX_SAFE_INTEGER` so migration replay stays complete.
- `evaluate_audit_coverage` tool results are recorded as `coverage.recorded` events by the Memory V2 coordinator (`sdk/src/services/memory-v2/coordinator.ts`), bound to the current workspace revision/snapshot so stale coverage is never reused across edits.
- The SQLite repository projects the latest `coverage.recorded` event per `(taskId, dimension)` into the `currentCoverage` retrieval category, filtered by exact workspace revision/snapshot freshness and optional `taskId` narrowing.
- The `query_index` tool handler (`packages/agent-runtime/src/tools/handlers/tool/query-index.ts`) records its results into `agentState.discoveryCoverage` via `recordDiscoveryResult` with a bounded (4000-char) question string; recording is wrapped in try/catch so a coverage failure can never break the tool call.
- When testing tool handlers that import a function to spy on, prefer `spyOn(namespaceImport, 'fn')` over `mock.module()` (repo convention in `docs/testing.md`/`CONTRIBUTING.md`); a relative `mock.module` specifier resolves from the test file's directory and silently misses the module the subject under test imports when the two live at different depths.
- Memory V2 authority is selected by `OPENBUFF_MEMORY_AUTHORITY` via `getMemoryAuthoritySelection` (`cli/src/utils/env.ts`); the default is `sqlite-v2-opt-in` (fail-closed — no V1 fallback), with `json-v1` as an explicit opt-out escape hatch and `shadow-v2` as an explicit shadow mode. Release N keeps `json-v1` and `shadow-v2` supported but deprecates both compatibility modes; `sqlite-v2-opt-in` is the default and replacement. Authority selection, degradation, and fallback behavior are unchanged in this release, no removal date/version is implied, and migration is not claimed complete. Follow the normative [Memory V1 removal readiness plan](../docs/memory-v1-removal-readiness.md) before any later removal decision.
- _Knowledge refresh 2026-09-16: prettier formatting pass over the cli memory-v2 services (`provider.ts`, `contained-file-io.ts`), cli utils (`codebuff-client.ts`, `env.ts`, `status-bar-chips.ts`), `memory-box.tsx`, `data/slash-commands.ts`, and their suites — line re-wraps only, no behavior change._

- _Knowledge refresh 2026-09-17: record_decision tool, memory-first skip/narrow in glob/list-directory/code-search/find-files-matching-content, indexer chunk-freshness sidecar, coordinator deterministic kinds, two-session cold-start test._

- _Knowledge refresh 2026-09-23: ask-user Esc data-loss guard (`components/ask-user/skip-guard.ts` — first Esc with in-progress drafts warns, second confirms), exit drain extracted to `hooks/helpers/exit-queue-drain.ts` (`createQueuedPromptDrainer`, partial-failure semantics unit-testable), and `utils/tool-result-normalizer.ts` error-scan restricted to the tool-result envelope so nested payload errors no longer flip successful tools to failed._

- _Knowledge refresh 2026-09-24b (staleness guard touch): M3-T3 reliability wave landed test-only changes under `src/` — the /exit drain test now mirrors the one-at-a-time `clearQueue(1)` splicing contract (plus a partial-failure persistence test), three guarded-submit busy-path tests exercise `/resume-plan` queueing via `commands/__tests__/command-args.test.ts`, and `components/__tests__/build-mode-buttons.test.tsx` restores its mockLayout in `afterAll` so the xs layout no longer bleeds into status-bar tests; this entry keeps `cli/knowledge.md` newer than `src/` for the pre-push memory-drift guard._

- _Knowledge refresh 2026-09-25 (staleness guard touch): release-wrapper auto-update hardening landed under `src/` — the release/release-staging npm wrappers gained poisoned-pendingVersion recovery with a 24h `failedPendingVersion` backoff, an async binary-version probe (2s timeout) that self-heals lost metadata, an offline in-memory-only packaged-version fallback that persists no unverified platform claim, crash-signature quarantine with a crashHeal budget preserved across reinstalls, `--update` exit(1) on failed apply, a wrapper-skew stderr notice at child exit, a bounded background update check with backoff, `OPENBUFF_UPDATE_DEBUG` logging, and the atomic `writeMetadataPatch` helper; this entry keeps `cli/knowledge.md` newer than `src/` for the pre-push memory-drift guard._

## Slash Commands and Plan Mode

- Durable planning is entered through `mode:plan`; the standalone `/plan` command is intentionally absent from `COMMAND_REGISTRY` and `SLASH_COMMANDS` so there is one plan-entry path.
- Keep the durable-plan quartet registered: `/resume-plan` (`rp`), `/update-plan` (`up`), `/plan-status` (`ps`), and `/lessons` (`lesson`). These commands operate on `.agents/sessions/<slug>/` artifacts and fall back to the plan-session picker when no target is provided.
- `/plans` (`plan-ls`) lists the artifact-bearing sessions returned by `listPlanSessions()` and never prompts the agent, while `/plan-use` (`plan-active`, `use-plan`) writes the `ACTIVE_SESSION` pointer file under `.agents/` and only accepts a bare slug or `.agents/sessions/<slug>` — the resolved directory must be exactly one segment under `.agents/sessions/` because the pointer stores bare slugs, so nested paths, non-session paths, missing directories, and artifact-less directories are all rejected before any write. Both share `formatPlanSessionListRow` / `PLAN_SESSIONS_DIR_PREFIX` from `cli/src/commands/plan-artifacts.ts` so the rendered box and the text report cannot drift.
- `/memory` (alias `/mem`, `cli/src/commands/memory-command.ts`, registered in `command-registry.ts` and listed in `data/slash-commands.ts`) inspects the persisted cross-session task memory for the current project (`.openbuff/memory/task-memory.json`). `/memory status` (the default) reports the record's revision and age, its goal and per-list counts, and how much of its evidence still verifies against disk, listing up to five stale paths; `/memory prune` drops evidence that no longer verifies. Both subcommands are move-aware via `collectWorkspaceMoves` + `WorkspaceJournalService` so a renamed file's evidence rebinds rather than being reported stale and deleted. `/memory audit-migration` is dedicated and read-only: before acquiring V2 it calls `inspectPersistedTaskMemoryV1`, blocks absent/invalid/unreadable states with bounded distinct reports, and passes the exact checksum-verified memory to the SDK audit without a second read. An `exact` audit reconstructs and compares every deterministic source-derived task/observation header and payload plus marker metadata; it is lossless only when `omittedFields === 0`, `(truncatedFields ?? 0) === 0`, and `warnings.length === 0`. The legacy loader still collapses non-valid inspection states to `undefined` for compatibility. `not-migrated` means removal is not ready and is not a product defect; all outcomes are rendered distinctly with bounded reason text. The audit's exactness check is order-insensitive (canonicalized before comparison) because the SQLite backend persists payloads via key-sorted `stableJson` and re-parses them on export; this is covered end-to-end by `cli/src/services/memory-v2/__tests__/memory-v1-migration-sqlite-roundtrip.test.ts`.
- Slash-command descriptions should stay model-agnostic under BYOK/local mode. Use wording such as "configured reviewer" rather than naming hosted models.

## Test Conventions

- OpenTUI reconciler tests (e.g. `status-bar.test.tsx`) must wrap `testRender` and `renderOnce` calls in an explicit `act()` using the dev/prod-safe shim defined at module scope in the test file. `@opentui/react/test-utils` resolves production React whose built-in `act` is a throwing stub, so the renderer's internal act-wrapping silently no-ops under load. Set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` at module scope before the first render.
- Timing-sensitive tests must tolerate early timer fire: assert fallback behavior with a lower-bound margin (e.g. `>= 90` for a 100ms timeout) rather than an exact bound — CI runners fire timers a few ms early under load, which broke the prod release gate at 99 vs 100.

## Import Guidelines

**Never use dynamic `await import()` calls.** Always use static imports at the top of the file.

```typescript
// ❌ WRONG: Dynamic import
const { someFunction } = await import('./some-module')

// ✅ CORRECT: Static import at top of file
import { someFunction } from './some-module'
```

Dynamic imports make code harder to analyze, break tree-shaking, and can hide circular dependency issues. If you need conditional loading, reconsider the architecture instead.

**Exceptions** (where dynamic imports are acceptable):

- **WASM modules**: Heavy WASM binaries that need lazy loading (e.g., QuickJS)
- **Test utilities**: Mock module helpers that intentionally use dynamic imports

## Test Naming Conventions

**IMPORTANT**: Follow these naming patterns for automatic dependency detection:

- **Unit tests:** `*.test.ts` (e.g., `cli-args.test.ts`)
- **E2E tests:** `e2e-*.test.ts` (e.g., `e2e-cli.test.ts`)
- **Integration tests:** `integration-*.test.ts` (e.g., `integration-tmux.test.ts`)

**Why?** The `.bin/bun` wrapper detects files matching `*integration*.test.ts` or `*e2e*.test.ts` patterns and automatically checks for tmux availability. If tmux is missing, it shows installation instructions but lets tests continue (they skip gracefully).

**Benefits:**

- Project-wide convention (not CLI-specific)
- No hardcoded directory paths
- Automatic dependency validation
- Clear test categorization

## Testing CLI Changes with tmux

Use tmux to test CLI behavior in a controlled, scriptable way. This is especially useful for testing UI updates, authentication flows, and time-dependent behavior.

### Recommended: Use Helper Scripts

**Use the helper scripts in `scripts/tmux/`** for reliable CLI testing:

```bash
# Start a test session
SESSION=$(./scripts/tmux/tmux-cli.sh start)

# Send commands and capture output
./scripts/tmux/tmux-cli.sh send "$SESSION" "/help"
./scripts/tmux/tmux-cli.sh capture "$SESSION" --wait 2 --label "after-help"

# View session data
bun scripts/tmux/tmux-viewer/index.tsx "$SESSION" --json

# Clean up
./scripts/tmux/tmux-cli.sh stop "$SESSION"
```

Session logs are saved to `debug/tmux-sessions/{session}/` in YAML format for easy debugging.

See `scripts/tmux/README.md` for full documentation or `cli/tmux.knowledge.md` for low-level details.

### Manual Pattern (Legacy)

```bash
tmux new-session -d -s test-session 'cd /path/to/openbuff && bun --cwd=cli run dev 2>&1' && \
  sleep 2 && \
  echo '---AFTER 2 SECONDS---' && \
  tmux capture-pane -t test-session -p && \
  sleep 3 && \
  echo '---AFTER 5 SECONDS---' && \
  tmux capture-pane -t test-session -p && \
  tmux kill-session -t test-session 2>/dev/null
```

### How It Works

1. **`tmux new-session -d -s test-session '...'`** - Creates a detached tmux session running the CLI
2. **`sleep N`** - Waits for N seconds to let the CLI initialize or update
3. **`tmux capture-pane -t test-session -p`** - Captures and prints the current terminal output
4. **`tmux kill-session -t test-session`** - Cleans up the session when done

### Use Cases

- **Authentication flows**: Capture login screen states at different intervals
- **Loading states**: Verify shimmer text, spinners, and status indicators
- **Auto-refresh behavior**: Test components that update over time
- **Error states**: Capture how errors appear in the TUI
- **Layout changes**: Verify responsive behavior based on terminal dimensions

### Tips

- Use unique session names (e.g., `login-url-test`, `auth-check-test`) to run multiple tests in parallel
- Redirect stderr with `2>&1` to capture all output including errors
- Add `2>/dev/null` to `tmux kill-session` to suppress errors if session doesn't exist
- Adjust sleep timings based on what you're testing (auth checks, network requests, etc.)

### Sending Input to the CLI via tmux

**See [`tmux.knowledge.md`](./tmux.knowledge.md) for comprehensive tmux documentation.**

**Key point:** Standard `tmux send-keys` does NOT work - you must use bracketed paste mode:

```bash
# ❌ Broken: tmux send-keys -t session "hello"
# ✅ Works:  tmux send-keys -t session $'\e[200~hello\e[201~'
```

## Migration from Custom OpenTUI Fork

**October 2024**: Migrated from custom `CodebuffAI/opentui#codebuff/custom` fork to official `@opentui/react@^0.1.27` and `@opentui/core@^0.1.27` packages. Updated to `^0.1.28` in February 2025.

**Lost Features from Custom Fork:**

- `usePaste` hook - Direct paste event handling is no longer available. Terminal paste (Ctrl+V/Cmd+V) now appears as regular key input events.

**Impact:**

- Paste functionality still works through the terminal's native paste mechanism, but we can no longer intercept paste events separately from typing.
- If custom paste handling is needed in the future, it must be reimplemented using `useKeyboard` hook or by checking the official OpenTUI for updates.

## OpenTUI Flex Layouts

### Multi-Column / Masonry Layouts

For columns that share space equally within a container, use the **flex trio pattern**:

```tsx
<box style={{ flexDirection: 'row', width: '100%' }}>
  {columns.map((col, idx) => (
    <box
      key={idx}
      style={{
        flexDirection: 'column',
        flexGrow: 1, // Take equal share of space
        flexShrink: 1, // Allow shrinking
        flexBasis: 0, // Start from 0 and grow (not from content size)
        minWidth: 0, // Critical! Allows shrinking below content width
      }}
    >
      {/* Column content */}
    </box>
  ))}
</box>
```

**Why not explicit width?** Using `width: someNumber` for columns causes OpenTUI to overflow beyond container boundaries. The flex trio pattern respects the parent container's width constraints.

**Key points:**

- `minWidth: 0` is essential - without it, content won't shrink below its natural width
- Use `width: '100%'` (string) for parent containers, not numeric values
- `alignItems: 'flex-start'` prevents children from stretching to fill row height

### Resize Transitions: Unified DOM Structure

**Problem**: When terminal resizes cause column count changes (e.g., 2→1 columns), content can disappear if the component renders different DOM structures for different column counts.

**Root cause**: When transitioning from multi-column to single-column:

1. The multi-column flex structure renders with shrinking width
2. Flex columns with `minWidth: 0` collapse to zero width
3. Content disappears before React can re-render with the new single-column structure

**Solution**: Use a **unified DOM structure** for all column counts + defensive `minWidth`:

```tsx
// ✅ CORRECT: Same structure for 1, 2, 3, or N columns
const isMultiColumn = columns > 1

<box style={{ flexDirection: 'row', gap: isMultiColumn ? 1 : 0, width: '100%' }}>
  {columnGroups.map((columnItems, idx) => (
    <box
      key={idx}
      style={{
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: MIN_COLUMN_WIDTH,  // Use constant, NOT 0!
      }}
    >
      {/* Column content */}
    </box>
  ))}
</box>
```

**Why this works:**

1. **Unified structure** = React doesn't need to reconcile different DOM trees during transitions
2. **`minWidth: MIN_COLUMN_WIDTH`** = columns can't collapse to zero during the brief resize window
3. Overflow protection in the layout hook handles edge cases by reducing columns when needed

**Anti-pattern:**

```tsx
// ❌ WRONG: Different DOM structures for different column counts
if (columns === 1) {
  return <SingleColumnLayout /> // Different structure!
} else {
  return <MultiColumnLayout /> // React must reconcile between these
}
```

The key insight: during resize, there's a timing window where the old structure is rendered with new (smaller) dimensions. A unified structure with defensive `minWidth` survives this window gracefully.

## OpenTUI Text Rendering Constraints

**CRITICAL**: OpenTUI has strict requirements for text rendering that must be followed:

### JSX Content Rules

**DO NOT use `{' '}` or similar JSX expressions for whitespace in OpenTUI components.** This will cause the entire app to go blank.

```tsx
// ❌ WRONG: Will break the app
<text>Hello{' '}World</text>
<text>{'Some text'}</text>

// ✅ CORRECT: Use plain text or template literals
<text>Hello World</text>
<text content="Hello World" />
```

OpenTUI expects plain text content or the `content` prop - it does not handle JSX expressions within text elements.

### A `<text>` May Only Contain Inline Children

`TextNodeRenderable.add()` accepts strings, `TextNodeRenderable` instances and `StyledText` — nothing else. OpenTUI maps only `span`, `b`, `i`, `u`, `strong`, `em`, `br` and `a` onto text nodes; every other element (`box`, `text` itself, custom block renderables) throws during the reconciler's commit phase.

That throw is not local. `@opentui/react`'s `createRoot` installs one root error boundary whose fallback replaces the entire tree, and a production React build paints that fallback as nothing — the terminal goes blank, message list, status line and input bar included. Typed content blocks persist to `chat-messages.json` and are replayed on reload, so one bad block blanks that session permanently.

```tsx
// ❌ WRONG: nested <text> throws at commit → whole app blanks
<text style={{ fg: theme.foreground }}>
  <text style={{ fg: theme.muted }}>{label}</text>
  {value}
</text>

// ✅ CORRECT: inline segments are <span>
<text style={{ fg: theme.foreground }}>
  <span style={{ fg: theme.muted }}>{label}</span>
  <span>{value}</span>
</text>
```

`cli/src/components/__tests__/text-nesting.test.tsx` guards this with a TypeScript-AST scan of every `cli/src/**/*.tsx`, so it keeps running under the package's `NODE_ENV=production` test script (where `@opentui/react/test-utils` cannot be imported at all — it needs react's `act`, absent from the production build). Reconciler-backed confirmations in the same file use the repo's `renderTest` skip convention.

Note that `renderToStaticMarkup` accepts the invalid nesting silently: per-renderer markup tests cannot catch it, only the real reconciler or the static guard can.

## Interactive Clickable Elements and Text Selection

When building interactive UI in the CLI, text inside clickable areas should **not** be selectable. Otherwise users accidentally highlight text when clicking buttons, which creates a poor UX.

### Components

**`Button`** (`cli/src/components/button.tsx`) - Primary choice for clickable controls:

- Automatically makes all nested `<text>`/`<span>` children non-selectable
- Implements safe click detection via mouseDown/mouseUp tracking (prevents accidental clicks from hover events)
- Use for standard button-like interactions

**`Clickable`** (`cli/src/components/clickable.tsx`) - For custom interactive regions:

- Also makes all nested text non-selectable
- Gives you direct control over mouse events (`onMouseDown`, `onMouseUp`, `onMouseOver`, `onMouseOut`)
- Use when you need more control than `Button` provides

**`makeTextUnselectable()`** - Exported utility for edge cases:

- Recursively processes React children to add `selectable={false}` to all `<text>` and `<span>` elements
- Use when building custom interactive components that can't use `Button` or `Clickable`

### Usage Examples

```tsx
// ✅ CORRECT: Use Button for clickable controls
import { Button } from './button'

<Button onClick={handleClick}>
  <text>Click me</text>
</Button>

// ✅ CORRECT: Use Clickable for custom mouse handling
import { Clickable } from './clickable'

<Clickable
  onMouseDown={handleMouseDown}
  onMouseOver={() => setHovered(true)}
  onMouseOut={() => setHovered(false)}
>
  <text>Hover or click me</text>
</Clickable>

// ❌ WRONG: Raw <box> with mouse handlers (text will be selectable!)
<box onMouseDown={handleClick}>
  <text>Click me</text>  {/* Text can be accidentally selected */}
</box>
```

### When to Use Which

| Scenario                             | Use                      |
| ------------------------------------ | ------------------------ |
| Standard button                      | `Button`                 |
| Link-like clickable text             | `Button`                 |
| Custom hover/click behavior          | `Clickable`              |
| Building a new interactive primitive | `makeTextUnselectable()` |

### Why This Matters

These patterns:

1. **Prevent accidental text selection** during clicks
2. **Provide consistent behavior** across all interactive elements
3. **Give future contributors clear building blocks** - no need to remember to add `selectable={false}` manually

## Screen Mode and TODO List Positioning

The CLI chat interface adapts its layout based on terminal dimensions:

### Canonical Breakpoints

- **Width**: xs below 50 columns, sm from 50–100, md from 101–150, and lg above 150.
- **Height**: xs below 20 rows, sm from 20–40, and md above 40.
- **Grid columns**: additional columns become eligible at 100, 150, and 200 columns, subject to the minimum column width.

Use the exported constants from `use-terminal-layout.ts`; do not introduce component-local breakpoint values for shared responsive behavior.

### TODO List Positioning

- **Right side**: Medium and large width layouts when there is sufficient horizontal space.
- **Top**: Extra-small and small layouts when the terminal is narrow.

The TODO list automatically repositions based on available space to ensure optimal visibility and usability.

### Text Styling Components Must Be Wrapped in `<text>`

All text styling components (`<strong>`, `<em>`, `<span>`, etc.) **MUST** be nested inside a `<text>` component. They cannot be returned directly from render functions.

**INCORRECT** ❌:

```tsx
// This will cause a black screen!
function renderMarkdown(content: string) {
  return (
    <>
      <strong>Bold text</strong>
      <em>Italic text</em>
    </>
  )
}
```

**CORRECT** ✅:

```tsx
// All styling must be inside <text>
function renderMarkdown(content: string) {
  return (
    <text wrap>
      <strong>Bold text</strong>
      <em>Italic text</em>
    </text>
  )
}
```

### Why This Matters

- Returning styling components without `<text>` wrapper causes the entire app to render as a black screen
- No error messages are shown - the app just fails silently
- This applies to ALL text styling: `<strong>`, `<em>`, `<span>`, `<u>`, etc.

### Available OpenTUI Components

**Core Components**:

- `<text>` - The fundamental component for displaying all text content
- `<box>` - Container for layout and grouping
- `<input>` - Text input field
- `<select>` - Selection dropdowns
- `<scrollbox>` - Scrollable container
- `<tab-select>` - Tab-based navigation
- `<ascii-font>` - ASCII art text rendering

**Text Modifiers** (must be inside `<text>`):

- `<span>` - Generic inline styling
- `<strong>` and `<b>` - Bold text
- `<em>` and `<i>` - Italic text
- `<u>` - Underlined text
- `<br>` - Line break

### Markdown Rendering Implementation

**SUCCESS**: Rich markdown rendering has been implemented using `unified` + `remark-parse` with OpenTUI components.

**Key Insight**: OpenTUI does **not support nested `<text>` components**. Since `chat.tsx` already wraps content in a `<text>` component, the markdown renderer must return **inline JSX elements only** (no `<text>` wrappers).

**Correct Implementation Pattern**:

```tsx
// ✅ CORRECT: Return inline elements that go INSIDE the parent <text>
export function renderMarkdown(markdown: string): ReactNode {
  const inlineElements = [
    <strong>Bold text</strong>,
    ' and ',
    <em>italic text</em>,
  ]
  return <>{inlineElements}</>
}

// In chat.tsx:
;<text wrap>{renderMarkdown(message.content)}</text>
```

**Incorrect Pattern** (causes black screen):

```tsx
// ❌ WRONG: Returning <text> components creates nested <text>
export function renderMarkdown(markdown: string): ReactNode {
  return (
    <text wrap>
      <strong>Bold text</strong>
    </text>
  )
}
```

The implementation uses:

- `markdownToInline()`: Converts markdown AST to array of inline JSX elements
- `renderInlineContent()`: Renders inline styling (`<strong>`, `<em>`, `<span>`)
- Returns a fragment `<>{inlineElements}</>` that can be safely placed inside parent `<text>`

## React Reconciliation Issues

### The "Child not found in children at remove" Error

OpenTUI's React reconciler has **critical limitations** with certain conditional rendering patterns that can cause the error:

```
Error: Child not found in children
  at remove (/path/to/TextNode.ts:152:17)
  at removeChild (/path/to/host-config.ts:60:12)
```

### Root Cause

OpenTUI's reconciler struggles when:

1. **Conditionally rendering elements at the same level** using `{condition && <element>}`
2. **The parent `<text>` element switches between different child structures**
3. Components that dynamically create/remove `<span>` elements (like ShimmerText)
4. **Conditionally rendering text nodes** (including spaces like `{showText ? ' ' : ''}`)

This happens because OpenTUI's reconciler doesn't handle React's reconciliation algorithm as smoothly as standard React DOM.

### The Text Node Problem

**CRITICAL INSIGHT**: The issue isn't just about conditionally rendering elements - it also affects **TEXT NODES**. Even something as simple as a conditional space can trigger the error:

```tsx
// ❌ PROBLEMATIC: Conditionally adding/removing text nodes (including spaces)
<span>■{showText ? ' ' : ''}</span>

// ✅ WORKING: Put the conditional text inside the span content itself
<span>{showText ? '■ ' : '■'}</span>
```

In React, spaces and other text are represented as text nodes in the virtual DOM. When you write `{showText ? ' ' : ''}`, you're conditionally adding/removing a text node child, which causes OpenTUI's reconciler to fail when trying to match up children.

**Key takeaway**: Always include text content (including spaces) as part of the string literal, not as separate conditional expressions.

### ❌ PROBLEMATIC PATTERNS

**Pattern 1: Shared parent with conditional children**

```tsx
// This causes reconciliation errors!
<text wrap={false}>
  {isConnected ? (
    <>
      <span>■ </span>
      {showText && <span>connected</span>}
    </>
  ) : (
    <ShimmerText text="connecting..." />
  )}
</text>
```

**Pattern 2: Conditionally rendering entire span elements**

```tsx
// Also problematic!
<text wrap={false}>
  <span>■ </span>
  {showText && <span>connected</span>}
</text>
```

**Pattern 3: Conditionally rendering text nodes (spaces, strings, etc.)**

```tsx
// Triggers reconciliation errors!
<span>■{showText ? ' ' : ''}</span>
<span>{condition ? 'text' : ''}</span>
```

### ✅ WORKING SOLUTION

**Keep each conditional state in its own stable `<text>` wrapper:**

```tsx
// This works reliably!
{
  isConnected ? (
    <text wrap={false}>
      <span>{showText ? '■ ' : '■'}</span>
      {showText && <span>connected</span>}
    </text>
  ) : (
    <text wrap={false}>
      <ShimmerText text="connecting..." />
    </text>
  )
}
```

**Key principle:** Each major UI state (connected vs disconnected) should have its own `<text>` element. The `<text>` element itself should not change during state transitions within that UI state.

### Why This Works

- The `<text>` element for each state remains **stable**
- Only the _children_ inside each `<text>` change
- React never tries to reconcile between the connected and disconnected `<text>` elements
- The reconciler doesn't get confused trying to match up old and new children

### Best Practices

1. **Separate `<text>` elements for different UI states** - Don't try to share a single `<text>` element across major state changes
2. **Keep element structure stable** - If you need conditional content, prefer changing text content over conditionally rendering elements
3. **Avoid complex conditional rendering within OpenTUI components** - What works in React DOM may not work in OpenTUI
4. **Test thoroughly** - Reconciliation errors often appear only during specific state transitions

### Alternative Approach: Stable Element Structure

If you must use a single `<text>` element, keep the child element structure completely stable:

```tsx
// This also works - elements are always present
<text wrap={false}>
  <span>{getIndicatorText()}</span>
  <span>{getStatusText()}</span>
</text>
```

But this approach is less flexible and harder to read than using separate `<text>` elements for each state.

### Best Practice: Direct Ternary Pattern

The cleanest solution is to use a direct ternary with separate `<text>` elements:

```tsx
{
  isConnected ? (
    <text wrap={false}>
      <span>{showText ? '■ ' : '■'}</span>
      {showText && <span>connected</span>}
    </text>
  ) : (
    <text wrap={false}>
      <ShimmerText text="connecting..." />
    </text>
  )
}
```

**Why this is the best approach:**

- Clear and explicit about the two states
- Minimal abstraction - easy to understand at a glance
- Each state's `<text>` wrapper is clearly visible
- No need for additional helper components

**Note:** Helper components like `ConditionalText` are not recommended as they add unnecessary abstraction without providing meaningful benefits. The direct ternary pattern is clearer and easier to maintain.

### Combining ShimmerText with Other Inline Elements

**Problem**: When you need to display multiple inline elements alongside a dynamically updating component like `ShimmerText` (e.g., showing elapsed time + shimmer text), using `<box>` causes reconciliation errors.

**Why `<box>` fails:**

```tsx
// ❌ PROBLEMATIC: ShimmerText in a <box> with other elements causes reconciliation errors
<box style={{ gap: 1 }}>
  <text fg={theme.secondary}>{elapsedSeconds}s</text>
  <text wrap={false}>
    <ShimmerText text="working..." />
  </text>
</box>
```

The issue occurs because:

1. ShimmerText constantly updates its internal state (pulse animation)
2. Each update re-renders with different `<span>` structures
3. OpenTUI's reconciler struggles to match up the changing children inside the `<box>`
4. Results in "Component of type 'span' must be created inside of a text node" error

**✅ Solution: Use a Fragment with inline spans**

Instead of using `<box>`, return a Fragment containing all inline elements:

```tsx
// Component returns Fragment with inline elements
if (elapsedSeconds > 0) {
  return (
    <>
      <span fg={theme.secondary}>{elapsedSeconds}s </span>
      <ShimmerText text="working..." />
    </>
  )
}

// Parent wraps in <text>
;<text style={{ wrapMode: 'none' }}>{statusIndicatorNode}</text>
```

**Key principles:**

- Avoid wrapping dynamically updating components (like ShimmerText) in `<box>` elements
- Use Fragments to group inline elements that will be wrapped in `<text>` by the parent
- Include spacing as part of the text content (e.g., `"{elapsedSeconds}s "` with trailing space)
- Let the parent component provide the `<text>` wrapper for proper rendering

This pattern works because all elements remain inline within a single stable `<text>` container, avoiding the reconciliation issues that occur when ShimmerText updates inside a `<box>`.

### The "Text Must Be Created Inside of a Text Node" Error

**Error message:**

```
Error: Text must be created inside of a text node
  at createTextInstance (/path/to/host-config.ts:108:17)
```

**Root cause:** This error occurs when a component returns Fragment with `<span>` elements containing text, but the parent doesn't wrap it in a `<text>` element.

**What triggers it:**

```tsx
// Component returns Fragment with spans
const ShimmerText = ({ text }) => {
  return (
    <>
      {text.split('').map((char) => (
        <span>{char}</span> // Text nodes created here!
      ))}
    </>
  )
}

// ❌ INCORRECT: Using component without <text> wrapper
;<box>
  <ShimmerText text="hello" />
</box>
```

**The solution:** Parent components must wrap Fragment-returning components in `<text>` elements:

```tsx
// ✅ CORRECT: Parent wraps in <text>
<box>
  <text wrap={false}>
    <ShimmerText text="hello" />
  </text>
</box>
```

**Why components shouldn't self-wrap in `<text>`:**

1. Creates composition issues - you can't combine multiple components in one `<text>` element
2. Prevents flexibility in how the component is used
3. Can cause reconciliation errors when the component updates
4. Goes against React's composition principles

**Best practice:**

- Child components that render styled text should return Fragments with `<span>` elements
- Parent components are responsible for providing the `<text>` wrapper
- This follows React's pattern of "dumb" presentational components

**Component design pattern:**

```tsx
// Child component - returns Fragment
export const StyledText = ({ text, color }) => {
  return (
    <>
      <span fg={color}>{text}</span>
    </>
  )
}

// Parent component - provides <text> wrapper
const Parent = () => {
  return (
    <text wrap={false}>
      <StyledText text="hello" color="#ff0000" />
      <StyledText text="world" color="#00ff00" />
    </text>
  )
}
```

This pattern allows multiple styled components to be composed together within a single `<text>` element while avoiding the "Text must be created inside of a text node" error.

### Markdown Renderer Fragment Issue

**CRITICAL**: When `renderMarkdown()` returns a Fragment, it contains a **mix of JSX elements AND raw text strings** (newlines, text content, etc.). These raw strings become text nodes that violate OpenTUI's reconciler rules if not wrapped properly.

**The problem:**

```tsx
// renderMarkdown() returns something like:
<>
  <strong>Bold text</strong>
  '\n'                          // ⚠️ Raw string!
  <span>More content</span>
  '\n'                          // ⚠️ Raw string!
</>

// ❌ WRONG: Passing directly to <box>
<box>
  {renderMarkdown(content)}     // Raw strings create text nodes outside <text>
</box>
```

**The solution:**

```tsx
// ✅ CORRECT: Always wrap markdown output in <text>
<box>
  <text wrap>
    {renderMarkdown(content)}   // Raw strings now inside <text> element
  </text>
</box>
```

**Real-world example from BranchItem component:**

The bug occurred when tool toggles were rendered. Agent toggles worked fine, but tool toggles crashed.

**Why agents worked:**

```tsx
// Agent content always wrapped in <text>
<text wrap style={{ fg: theme.agentText }}>
  {nestedBlock.content}
</text>
```

**Why tools failed before fix:**

```tsx
// Tool content passed directly to <box> - raw strings violated reconciler rules!
<box>{displayContent} // Could be renderMarkdown() output with raw strings</box>
```

**The fix:**

```tsx
// Always wrap ALL content in <text>, whether string or ReactNode
<box>
  <text wrap fg={theme.agentText}>
    {content} // Safe for both strings and markdown Fragments
  </text>
</box>
```

**Key lesson:** Any component that receives content from `renderMarkdown()` or `renderStreamingMarkdown()` MUST wrap it in a `<text>` element, even if the content might be ReactNode. The Fragment can contain raw strings that need the text wrapper to be valid.

## Toggle Branch Rendering

Agent and tool toggles in the TUI render inside `<text>` components. Expanded content must resolve to plain strings or StyledText-compatible fragments (`<span>`, `<strong>`, `<em>`). Any React tree we pass into a toggle must either already be a `<text>` node or be wrapped in one so that downstream child elements never escape a text container. If we hand off plain markdown React fragments directly to `<box>`, OpenTUI will crash because the fragments often expand to bare `<span>` elements.

Example:
Tool markdown output (via `renderMarkdown`) now gets wrapped in a `<text>` element before reaching `BranchItem`. Without this wrapper, the renderer emits `<span>` nodes that hit `<box>` and cause `Component of type "span" must be created inside of a text node`. Wrapping the markdown and then composing it with any extra metadata keeps OpenTUI happy.

```tsx
const displayContent = renderContentWithMarkdown(fullContent, false, options)

const renderableDisplayContent = displayContent ? (
  <text
    fg={resolveThemeColor(theme.agentText)}
    style={{ wrapMode: 'word' }}
    attributes={theme.messageTextAttributes || undefined}
  >
    {displayContent}
  </text>
) : null

const combinedContent = toolRenderConfig.content ? (
  <box
    style={{ flexDirection: 'column', gap: renderableDisplayContent ? 1 : 0 }}
  >
    <box style={{ flexDirection: 'column', gap: 0 }}>
      {toolRenderConfig.content}
    </box>
    {renderableDisplayContent}
  </box>
) : (
  renderableDisplayContent
)
```

### TextNodeRenderable Constraint

**Problem**: Markdown-rendered content that returned arbitrary React elements (e.g., nested `<box>` containers) under `<text>` caused errors when toggling branches:

```
Error: TextNodeRenderable only accepts strings, TextNodeRenderable instances, or StyledText instances
```

**Solution**: `cli/src/components/blocks/agent-branch-wrapper.tsx` inspects expanded content:

- If text-renderable → stays inside `<text>`
- Otherwise → renders the raw element tree directly

This prevents invalid children from reaching `TextNodeRenderable` while preserving formatted markdown.

**Related**: `cli/src/components/message-with-agents.tsx` renders toggle headers within a single `<text>` block for StyledText compatibility.

## Command Menus

### Slash Commands (`/`)

Typing `/` opens a five-item slash menu above the input.

**Navigation**:

- Arrow keys or Tab/Shift+Tab to move highlight
- Enter to insert selected command
- List scrolls when moving beyond first five items

### Agent Mentions (`@`)

Typing `@` scans the local `.agents` directory and surfaces agent `displayName`s (e.g., `@Codebase Commands Explorer`).

**Navigation**:

- Same as slash menu (arrows/Tab to navigate, Enter to insert)
- Both menus cap visible list at five entries

## Streaming Markdown Optimization

Streaming markdown renders as plain text until the message or agent finishes. This prevents scroll jitter that occurred when partial formatting changed line heights mid-stream.

## Recent Runtime State Notes

- Queue processing uses a single-owner lock in `cli/src/hooks/use-message-queue.ts` so stale async cleanup cannot release a newer queue-processing run. The lock is cleared only when a settled send's finally-cleanup runs (no timing-based watchdog; the earlier 60s force-release was removed because a normal LLM turn exceeds 60s and the watchdog force-reset could interleave two turns).
- Plan blocks render known and custom artifact paths as static text, while plan command strings render as `Button` controls that call `onInsertCommand` to prefill the chat input without submitting. Keep this callback threaded through `MessageWithAgents`, `MessageBlock`, `BlocksRenderer`, `SingleBlock`, and nested `AgentBranchWrapper` when changing plan or agent rendering.
- Status indicators in `cli/src/utils/status-indicator-state.ts` distinguish retrying, reconnecting, paused ask_user prompts, and phase-aware waiting/streaming labels.
- Re-render performance tests rely on debug rerender logs from `CODEBUFF_PERF_TEST=true`; tmux global env propagation is best-effort because `new-session` can start the server and inherit the current process environment.
- Slash-command and agent-mention menu behavior is covered by focused CLI tests; keep the knowledge notes in sync when changing menu navigation, visible-item caps, or insertion semantics.
- Release validation runs `bun --cwd=scripts run guard:memory-drift`; if CLI `src/` or tmux interaction behavior changes, refresh `cli/knowledge.md` and/or `cli/tmux.knowledge.md` in the same commit so the staleness guard stays green.
- Gate vs Specialist routing canonical matrix lives in `agents/base2/quality-prompt-section.ts` (`specialistRoutingSection`) and `agents/guides/specialist-routing.md`; `docs/agents-and-tools.md` links there for the Params Contract (`snapshot_id` vs `snapshot_fingerprint`).
- Index workspace watching now classifies file changes before notifying the index manager: ignored top-level build/cache directories and the configured cache dir are skipped, file updates and deletes are batched as path-specific deltas, ambiguous directory/watch errors mark the index stale, and at most four project roots keep active recursive watchers.
- `cli/src/components/renderers/gate-state-box.tsx` renders `<gate-state>` blocks as a bordered box supporting exactly the four `GateStateStatus` values from `cli/src/types/chat.ts` — `pending` (`…`, warning), `passed` (`✓`, success), `failed` (`✗`, error), and `skipped` (`–`, warning) — with the heading format `<icon> <origin ?? 'Gate'> · <gate> · <STATUS_LABEL>`; keep `STATUS_LABEL`, `STATUS_ICON`, and `statusColor` exhaustive when adding a status. The block schema is `gate`/`status` (required) plus optional `details`, `origin`, `advisories`, and `workflow`: `advisories` is an additive array of non-empty reviewer observations that never changes the gate status, is dropped entirely by `parseGateStateBlock` unless every entry is a non-empty string, and renders under an "Advisory (non-blocking):" bulleted list after `details`. base2 bounds it to 8 entries of ≤240 chars per block, so downstream consumers must treat it as optional and already-truncated. `workflow` is an additive `{ completedCount, totalCount, nextWorkflowAction }` object reporting declared `write_todos` progress that was still incomplete when the gate PASSED, so a turn finalizing with outstanding declared work is machine-detectable rather than only discouraged in prose; like `advisories` it is observability only and never changes the gate status. base2 emits it ONLY on the three gate-pass paths (fresh pass, conversation reuse, durable-fingerprint reuse) and only when the counts are finite non-negative integers with `totalCount > 0` and `completedCount < totalCount` and the sanitized action is non-empty — a completed workflow omits the key entirely, so its absence never means "no todos were declared". `nextWorkflowAction` is model-authored text bounded to 240 chars with whitespace collapsed and C0/DEL stripped; `parseGateStateWorkflow` re-enforces every one of those bounds independently (it also parses hand-authored assistant text) and drops the whole object when any fails. It is JSON-payload-only: the legacy `key: value` line form never carries it.
- `cli/src/commands/git-command-args.ts` parses user-supplied `/diff` and `/status` arguments with `parseSafeGitArgs`, which rejects shell operators and expansions (newline, `;`, `$`, backtick, `|`, `&`, `<`, `>`, `\`) and unclosed quotes while intentionally allowing `()[]{}` so git pathspec magic such as `:(exclude)` still works; `quoteShellArgument` single-quotes each argument (escaping embedded single quotes) and `buildSafeGitCommand` assembles the final command with a fallback argument list, so route any new git-backed slash command through these helpers instead of interpolating raw input.
- `cli/src/utils/sdk-event-handlers.ts` consumes the additive `job_update` print-mode event through a catch-all branch, so unknown future event variants stay no-ops rather than throwing.
- `cli/src/data/initial-agent-type-sources.generated.ts` is regenerated by the repository-root `bun scripts/generate-tool-definitions.ts`, so any new public tool schema (e.g. the `occurrence` selector on `replace_range`, or the `windows`/`around`/`symbol` selectors on `read_files`) must land with a regenerated, committed copy of that file — CI verifies it is current. The same freshness check gates the three `tools.ts` type sources (`agents/`, `.agents/`, `common/src/templates/`), so a `list_jobs` description/schema change also requires regenerating and committing those.
- `cli/src/data/initial-agent-type-sources.generated.ts` is a generated mirror (its `toolsSource` / `agentDefinitionSource` exports embed the starter type sources under `common/src/templates/initial-agents-dir/types/`) refreshed by `bun run scripts/generate-tool-definitions.ts`, which delegates to `cli/scripts/generate-init-type-sources.ts`; never hand-edit it.
- `list_jobs` returns an owner-scoped digest of background jobs (process + agent) with bucketed pending output relative to the `check_job` cursor, a `gap` flag, terminal tails, and a 10-row cap; when nothing changed this turn the SDK change-gate in `sdk/src/run.ts` (`applyListJobsDigestGate`) swaps it for a suppressed `{ unchanged: true, note }` payload. See `common/docs/list-jobs.md` for both output variants.
- `scripts/measure-context-baseline.ts` measures the per-turn fixed context cost (system prompt, file tree, knowledge files, injections) and is the baseline for the context-budget ledger in `packages/agent-runtime/src/util/context-budget.ts`.
- The built-in `query_index` result JSON carries an additive optional `indexMutationEpoch` (the IndexManager's in-process epoch, incremented on `markStale`/`markPathsChanged`). base2's proactive-retrieval cache uses it to invalidate a cached result when an external index mutation did not advance the workspace revision. The disabled-index result path omits the field, which base2 treats as a match (pre-epoch behavior).
- `spawn_agents` tool results may surface a nested `agentReceipt` (including `status: 'partial'`). `cli/src/utils/sdk-event-handlers.ts` narrows that receipt without `any` and marks the corresponding agent block partial even when only the receipt is present, so incomplete specialist turns stay visible in the TUI.
- BACKGROUND terminal cards wire `backgroundJobId` from the launch `tool_result` so live `job_update` events settle lifecycle/output in place without a `check_job` poll; keep frozen JSON status from being treated as authoritative after settle.
- `cli/src/utils/create-run-config.ts` and regenerated agent type sources track content-search/glob `cwd` ergonomics (file-as-cwd coercion, paths param, flag allowlist). After public tool schema changes, regenerate `cli/src/data/initial-agent-type-sources.generated.ts` via the root tool-definition generator.
- `cli/src/components/blocks/blocks-renderer.tsx` wraps every block and block group in its own nested `ErrorBoundary` (`isolateBlock`), with the React key on the boundary. Keep new block handlers routed through it: `@opentui/react`'s root boundary is app-wide, so an unguarded render throw in one persisted block blanks the whole session on every reload.

- _Knowledge refresh 2026-09-03: agent-branch status display (`cli/src/components/blocks/agent-branch-wrapper.tsx`), status-label/chip utilities (`cli/src/utils/status-label.ts`, `cli/src/utils/status-bar-chips.ts`), and code-search summary rendering (`cli/src/utils/code-search-summary.ts`) changed alongside the code-searcher removal; regenerated agent type sources kept in sync._

- _Knowledge refresh 2026-09-03 (test isolation): `cli/src/utils/__tests__/logger.test.ts` and `chat-history.test.ts` stub `project-files` with `spyOn` plus `mock.restore()` instead of `mock.module`, which leaks across every test file in the same bun process and misdirected `turn-checkpoint.test.ts` checkpoint paths in CI; `turn-checkpoint.test.ts` also restores defensively in `beforeEach`._

- `cli/src/components/renderers/compaction-box.tsx` derives the pending/interrupted/unsettled triple in one `derivePresentation` helper that both `deriveTone` and the render path consume, so the chosen tone and the rendered lines cannot drift. A `status: 'pending'` block is only presented as live when `isLiveCompaction` confirms it belongs to THIS process (matching `liveSessionId`); a replayed pending block from a persisted transcript renders as "Interrupted before this pass reported a result." rather than a permanently spinning "Compacting context…" card. `cli/src/utils/sdk-event-handlers.ts` consumes the additive `context_compaction_status` event and pairs `started`/`settled` strictly by the event's required `runId` — never by `agentId`, which subagent forwarding rewrites — so a nested agent loop's settle cannot clear the root turn's live card; `handleFinish` rewrites any stray pending block as interrupted so an aborted turn leaves an honest terminal record.

- _Knowledge refresh 2026-08-23: add `/memory` (alias `/mem`) slash command; staleness guard touch._

- _Knowledge refresh 2026-09-12: Memory V2 implementation across `cli/src/services/memory-v2/` (SQLite kernel with WAL/append-only triggers/canonical projections/project binding, contained file I/O with O_NOFOLLOW/proc-fd anchoring, lease-based provider with opt-in fail-closed), `/memory` expanded with authority/diagnose/query/inspect/consolidate/repair/revalidate/correct/forget/pin/export/import and the read-only SDK-backed `audit-migration` command plus existing status/prune, all with sanitized error boundaries and preview-by-default mutators; `cli/src/utils/codebuff-client.ts` gained `ManagedOpenbuffClient` with lease-based lifecycle and `memoryV2ClientConfigFromProvider` wiring, `cli/src/utils/env.ts` gained `getMemoryAuthoritySelection` for the `OPENBUFF_MEMORY_AUTHORITY` env var, `cli/src/types/chat.ts` gained `MemoryReportContentBlock` and `v2Lines` additive fields, and `cli/src/components/renderers/memory-box.tsx` gained the `report` state renderer with insert-command buttons._

- _Knowledge refresh 2026-08-31: live compaction status rendering (`context_compaction_status` consumption, run-correlated pending/settled pairing, replayed-pending-as-interrupted) in `cli/src/utils/sdk-event-handlers.ts` and `cli/src/components/renderers/compaction-box.tsx`._

- _Knowledge refresh 2026-08-31 (followups): `handleRuntimeError` in `cli/src/utils/sdk-event-handlers.ts` now splits runtime error events by `autoRecovering` — auto-recovering notices log at `debug` (`'SDK auto-recovering runtime notice'`) with no visible error banner, while genuine failures still log at `error` (`'SDK runtime error event'`) and render. Tool-ordering rejections (the `suggest_followups` gate/ordering rejections and the pre-gate `git-committer withheld` chunk) arrive with a concise `userMessage` plus `autoRecovering: true`, so the model still receives the full `message` via the `TOOL_CALL_ERROR` path in `packages/agent-runtime/src/tools/stream-parser.ts`; `git-committer blocked by unvalidated dirty file(s)` deliberately stays user-visible because it asks the user to reply `COMMIT ANYWAY`._

- _Knowledge refresh 2026-08-31 (UI polish): `cli/src/components/status-bar.tsx` is now three regions — status label left, chip cluster left-aligned in the growing middle (`flexGrow: 1` + `flexBasis: 0`), and every width-varying control (scroll-to-bottom, then the `■ Esc` stop hint) in a `flexShrink: 0` right region with no `minWidth: 0`, so a hover cannot reflow the label or the chips. `cli/src/components/scroll-to-bottom-button.tsx` exports `SCROLL_HINT_LABEL`/`SCROLL_GLYPH` plus `string-width`-derived `SCROLL_BUTTON_WIDTH` (10) and `SCROLL_BUTTON_COMPACT_WIDTH` (3) and renders at a fixed width in both hover states; its `isScrollButtonCompact(width)` predicate is the single source `StatusBar` also passes as `scrollButtonCompact`, so `statusBarChipBudget`'s duplicated `SCROLL_BUTTON_RESERVATION`/`SCROLL_BUTTON_COMPACT_RESERVATION` in `cli/src/utils/status-bar-chips.ts` always reserve the columns actually rendered (test-enforced agreement, since the util must not import a component module). `cli/src/components/renderers/completion-summary-box.tsx` renders a titled `Run summary` `HarnessBox` (`gap={0}`, `paddingBottom={0}`) of aligned `Label   value` rows built from `ROW_LABELS` + derived `LABEL_COLUMN_WIDTH`, with no status emoji — meaning lives in the value words, not color. Reconciler-level coverage for the status bar lives in `cli/src/components/__tests__/status-bar.test.tsx`, which reuses the dev-only `renderTest`/`renderFrame` convention from `text-nesting.test.tsx` (`@opentui/react/test-utils` cannot be imported under `NODE_ENV=production`)._

- _Knowledge refresh 2026-09-05 (compaction progress + self-dismissing cards): `cli/src/utils/sdk-event-handlers.ts` consumes the additive `context_compaction_progress` event in `handleContextCompactionProgress`, clamping each reported percent to a whole 0..100 and writing only the MAXIMUM of what the card or notice already holds, so two producers for one pass (the agent loop's milestones and the inline spawn path's activity ticks) plus replayed or out-of-order events can never rewind the bar. Card updates stay root-scoped and paired by `runId`, while the status-bar notice tracks root and nested passes alike; a progress event never creates a notice or revives a settled one. `compactionResultIsDegraded` is the single site deciding `CompactionContentBlock.transient`: a healthy settled pass is stamped `progressPercent: 100` plus `transient: true`, while a mechanical or request-time trim, a pass that missed its budget, an escalated pass, and a low-yield streak all stay permanent warning cards, as do declined and interrupted passes. `cli/src/components/renderers/compaction-box.tsx` renders `cli/src/components/progress-bar.tsx` for pending and transient passes and hides a transient card after a short hold, but hiding is purely visual: `dropTransientCompactionBlocks` in `cli/src/utils/message-block-helpers.ts` is what actually removes it from state, composed into both the turn-end path in `handleFinish` and the abort path in `cli/src/hooks/helpers/send-message.ts`, so a self-dismissing card can never persist to the transcript. `cli/src/utils/status-bar-chips.ts` reports `⇲ compacting NN%` at md/lg when a live percent is finite and above zero and otherwise keeps the previous ellipsis label (xs/sm labels unchanged). `cli/src/types/chat.ts` carries the new optional `progressPercent` and `transient` block fields, the notice `progressPercent`, and the `boundedFileReads` category. `cli/src/components/terminal-command-display.tsx` now shows a timeout label only for a finite positive bound, because `timeout_seconds` defaults to no timeout and the removed 30s default would otherwise be implied. Coverage: `cli/src/utils/__tests__/sdk-event-handlers.test.ts`, `cli/src/utils/__tests__/status-bar-chips.test.ts`, and `cli/src/components/__tests__/sweep-boxes.test.tsx`._

- _Knowledge refresh 2026-09-12 (spawn attestation followups): reviewer-family specialist `spawn_agents` params now treat `snapshot_id` as OPTIONAL — runtime-owned programmatic spawns pass the gate-minted opaque `v3:<64-hex>` token, while manual/advisory prompt-authored spawns omit the key entirely (scoped files go in `params.files`, the question in the prompt); `security-reviewer` is the exception and its schema still requires `changed_files` + `snapshot_fingerprint` on manual spawns too (no v3 pattern on that key). Covered by `agents/specialists/create-specialist.ts`, `common/src/tools/params/tool/spawn-agents.ts`, and `packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts` (branched recovery hints), with the routing matrix in `agents/guides/specialist-routing.md`. Spawn partial-failure and `spawn_agent_inline` pre-validation errors now carry a concise `userMessage` + `autoRecovering: true` (see `common/src/types/print-mode.ts`, consumed through `cli/src/utils/sdk-event-handlers.ts`'s log-only auto-recovering path), so the CLI shows a calm one-liner instead of the raw multi-KB validation wall while the full contract still reaches the agent's message history (`packages/agent-runtime/src/tools/tool-executor.ts`). The context-pruner's structured review receipt renders an empty `snapshotFingerprint` echo as `(manual/unattested)` (`agents/context-pruner.ts` `formatStructuredReviewReceipt`), and gate attestation fails closed on an empty echo with the missing-fingerprint issue and no drift credit (`agents/base2/gate-reviewer.ts`; pinned in `agents/__tests__/gate-reviewer.test.ts`)._

- _Knowledge refresh 2026-09-12 (committed-surface mode): `update_plan_status` gained `requestCommittedSurfaceReview: true` (also accepted standalone by the top-level refine, refusal message names the flag). On base2's next gate pass it verifies the worktree is fully committed (fresh `git status --porcelain`, only `.agents/sessions/` paths excluded), derives a bounded fileset (40 cap) from the claimed task's runtime-observed `touchedFiles`/`changedFiles` filtered to reviewable files with verifiable 64-hex sha256 markers, routes reviewer-family specialists over it with the gate-computed `v3:<64-hex>` token, and — only when every specialist attests cleanly AND returns `LOOKS_GOOD` (`getReviewerFinalizationVerdict`) — mints a `plan-gate:<taskId>:committed-surface:<fp16>` receipt that survives turn-start prune while covered bytes match and retires only on an intersecting change. The request is consumed on its FIRST attempt whatever the outcome, and the `committedSurfaceReviewResolvedFromMessageIndex` replay watermark keeps the history re-walk from resurrecting a resolved request (a watermark beyond the current length is treated as compaction and ignored). Any schema change to a tool params module regenerates FOUR tool-definition mirrors (`agents/types/tools.ts`, `.agents/types/tools.ts`, `common/src/templates/initial-agents-dir/types/tools.ts`, `cli/src/data/initial-agent-type-sources.generated.ts`) that the pre-push regenerate check requires committed — the earlier claim that this refine was check-time-only was wrong. Coverage: `agents/__tests__/base2.test.ts` (lifecycle, failure branches, watermark), `agents/__tests__/gate-committed-surface.test.ts` (derive/receipt-id/inline parity), `common/src/tools/params/tool/update-plan-status.test.ts` (standalone flag)._

- _Knowledge refresh 2026-09-16 (persistent code understanding): chunk-addressed code store in `packages/code-map/src/chunks.ts` plus `CodeChunkSummary` on `IndexedFile`; Memory V2 chunk selector plus enriched capture with digests and best-effort verify promotion; lexical-match retrieval plus tiered prompt excerpts plus memory-first discovery wiring._

- _Knowledge refresh 2026-09-16 (P-G lifecycle): append-only canonical events with retention via `claim.forgotten + evidenceDisposition` (never `deleteEvents`/`compact`); `rebuildProjections` truncation guard with honest cursor; owner-only `0700`/`0600` store files; freshness-gated retrieval on every read; memory-retention evals green._

- _Knowledge refresh 2026-09-18: privileged GC compaction (`claim.archived` + `MemoryCompactionRequest`/`Outcome` in `common/src/types/memory-v2.ts`, `MemoryV2OperatorService.compact` preview/apply in `sdk/src/services/memory-v2/operator-service.ts`, `BunSQLiteMemoryRepository` privileged `getStoreStats`/`selectGCandidates`/`privilegedCompact` with trigger drop/recreate + VACUUM + 0600 archive writes, `/memory compact-memory` preview default + `--apply --confirm` + store/bloat observability in `cli/src/commands/memory-command.ts`, bloat threshold retuned 50MB to 128MB to align with 20k events) plus test coverage (`operator-service.test.ts`, `bun-sqlite-memory-repository.test.ts`, `memory-command.test.ts`) and live-verify scripts under `.e2e-scratch/` (untracked, never committed)._

- _Knowledge refresh 2026-09-18 (record_decision into V2 + decision-capture policy): `record_decision` now writes genuine decisions into the Memory V2 event store via the SDK observation seam (`sdk/src/services/memory-v2/coordinator.ts` `CAPTURE_KINDS`/`classifyObservationKind`/`collectPaths` read the echoed `kind`/`evidenceSelectors`), while the V1 `taskMemory` write is retained as the compatibility shadow and its evidence kind maps constraint->requirement/fact->note to stay within the V1 enum. A deterministic rationale gate (`common/src/util/decision-rationale.ts`) rejects a `decision`/`constraint` record lacking reasoning; facts are ungated. The cursor-authoritative tolerant export reader (`cli/src/services/memory-v2/bun-sqlite-memory-repository.ts`) skips-and-counts only unknown/future event types via `skippedUnknownCount`, surfaces the real raw tail via `rawTailEventId` for CAS, and hard-fails a known-type strict-decode error; `CANONICAL_EVENT_TYPES` covers all 25 envelope variants._

- _Knowledge refresh 2026-09-19 (per-turn memory reuse receipt, S2): the memory-cover gate now emits a visible per-turn reuse receipt on the LIVE TURN STREAM (carrier b, never persisted). `packages/agent-runtime/src/orchestration/discovery-coordinator.ts` adds a deterministic best-effort `recordMemoryReuse` accumulator wired at all five memory-cover call sites (query_index, code_search, find_files_matching_content, list_directory, glob); `packages/agent-runtime/src/run-agent-step.ts` emits one `memory_reuse` chunk per ROOT turn (guarded on `!parentId`, `turnId` set, `byTool` sorted by code-point, then cleared). `cli/src/types/chat.ts` adds a `MemoryContentBlock` `state:'reuse'` variant; `cli/src/components/renderers/memory-box.tsx` renders it; `cli/src/utils/sdk-event-handlers.ts` routes `memory_reuse` to `handleMemoryReuse`. The glob narrow branch now falls through to the full call (remainingGaps are file-like paths, not directories) matching list_directory/find_files_matching_content._

- _Knowledge refresh 2026-09-19 (CI fixes + honest reuse accounting): fixed two stale test assertions broken by earlier phases — the `record_decision` happy-path test now uses genuine-rationale text (the P2 rationale gate rejects non-rationale decisions), and the `/memory` pagination test expects `calls===2` (the loosened tolerant reader follows one empty advancing page before rejecting the repeated cursor). Also made the reuse receipt honest: `glob`/`list_directory`/`find_files_matching_content` record `decision: 'skip'` only when the skip branch is actually taken, else `'full'` (served 0), since a `narrow` cover falls through to the full call in those handlers (only `query_index`/`code_search` issue a genuine narrowed call and keep recording `narrow`)._

- _Knowledge refresh 2026-09-19 (P4 usage correlation + projection): pure deterministic usage correlation in `sdk/src/services/memory-v2/usage-observer.ts` (`correlateUsage`: chunk→observation map capped at 256 from verifiedKnowledge/reusableDiscovery evidence selectors; skip/narrow coverage → used/gate-skip; full-read turn marks remaining injected observations ignored/reread-despite; dedup per (observationId, kind), code-point sort, 128 cap, best-effort no-throw). `sdk/src/services/memory-v2/coordinator.ts` `buildUsageDrafts` appends ONE batched `observation.reused` event per turn inside the finishTurn terminal CAS batch (turnId/queryId correlation guards; advisory — dropped on CAS failure, never retried/parked; snapshot `agentState.memoryUsageTurn` cleared either way; `staled` deferred to a later verify-seam fold, `cited` reserved in the enum). `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts` adds `observation.reused` to `CANONICAL_EVENT_TYPES`, an idempotent `memory_usage` projection table (used/ignored/staled counters, last mechanism/turn, monotonic last_sequence guard — no DELETE), clears it on BOTH `rebuildProjections` and `privilegedCompact`, and exposes a bounded `getUsage` (256 rows / 64-id filter) through both the concrete driver and the runtime-neutral `MemoryRepositoryV2` boundary (`sdk/src/services/memory-v2/types.ts` optional `getUsage?` following the `getStoreStats?` precedent)._

- _Knowledge refresh 2026-09-19 (P6 relevance-based compaction + P9 sweep): `selectGCandidates` (`cli/src/services/memory-v2/bun-sqlite-memory-repository.ts`) now selects GC-relevant event types with payload_json within GC_SELECT_LIMIT and delegates to the shared `common/src/util/compaction-eligibility.ts` selection (per-observation lifecycle GROUPS, closure fixpoint, pinned/explicit/young/reused exclusions); asOfTurnWall is the code-point max occurredAt over the scanned window (recorded clock; the olderThanDays cutoff stays request-parameterized Date.now). `privilegedCompact` gains a fail-closed closure pre-check inside the existing transaction BEFORE the no-delete trigger is dropped — batch closure (every referenced observation recorded in-batch), no out-of-batch shared event may reference a batch observation, malformed payload_json fails closed; archive(0600)+claim.archived+DELETE+projection/memory_usage rebuild+VACUUM unchanged. `sdk operator compact()` candidates move to the same shared selection (preview+apply group-granular, never splitting a group at COMPACTION_APPLY_MAX_EVENTS; the advisory selectGCandidates call is now a consistency check emitting a bounded 'GC candidate drift' warning on mismatch) and the claim.archived `reason` is enriched with a deterministic bounded audit summary (`gc-eligibility compaction-eligibility-v1 model=usefulness-v1 branches retracted=N orphan=N lowScore=N; olderThanDays=D; maxEvents=M; asOf=...` — zero schema change, pure function of batch+request). CLI `/memory compact-memory --apply` recomputes the apply batch group-granularly from the canonical inventory instead of slicing candidateEventIds. P9 sweep adds enforcing tests: eligibility invariants (INV11 explicit-never/reused-never, INV6 no-Date.now purity via comment-stripped source scan), store-level INV11 end-to-end (an old unsuperseded explicit decision is never a GC candidate while the same-age derived orphan is), pinned-blocks-retracted (the shared forgotten event stays out of the batch), projection replay determinism across rebuildProjections for observation.reused/claim.archived, and an INV7 archive-file 0600 assertion in the compact apply success test._

- _Knowledge refresh 2026-09-19 (P7 contradiction & consolidation): `bun-sqlite-memory-repository.ts` registers `claim.reinforced` in CANONICAL_EVENT_TYPES + GC_RELEVANT (exclusive, not shared), adds a `claim_dedup` projection (claim_id PK / observation_id index; first-wins per replay keyed on provenance.metadata.claimId 64-hex written by the coordinator for record_decision captures; retraction deletes across forgotten/superseded/corrected/consolidated; cleared+rebuilt with memory_usage) and a bounded `getClaimDedup` (256 rows / 64-id filter) mirrored on the runtime-neutral `MemoryRepositoryV2` boundary as optional `getClaimDedup?`. Retrieval wiring: `ObservationState.reinforced` counter fed to scoreUsefulness (w_reinf=6 — the scorer's first producer), `claim.superseded` edges collected during the fold, contradiction flagging groups LIVE decision/constraint observations by `STABLE_CHUNK_ID_METADATA_KEY` (explicit key, not a 64-hex scan) into `deriveTopicKey` topics via `detectContradictions` and appends `contradiction-suspected` reread entries (first evidence selector, reconcile detail; verified-vs-reread superRefine exempts contradiction-suspected so both live sides surface), and `historicalContext` resolves retracted predecessors to their supersession head (`resolveSupersessionHead` cycle-safe) adding the head's sourceEventId. `sdk coordinator captureToolObservation` for record_decision: derives the claimId from the echoed DTO (kind+text+evidenceSelectors), stores it in provenance.metadata, best-effort `getClaimDedup` lookup — a duplicate reinforces the active claim via `claim.reinforced` instead of a second row (never blocks) — and after the main append emits a best-effort second batch (≤16 deduped sorted `claim.superseded` targets + exactly ONE `observation.reused` mechanism 'cited'). The handler validates the `supersedes` param shape-only and echoes it in the success DTO. Operator `correct()` supersede branch: both targets must belong to the request task, winner must be in the active set, target may be retracted (idempotent re-affirmation)._

- _Knowledge refresh 2026-09-19 (P8 ConceptIndex advisory semantic layer): new self-contained module `cli/src/services/memory-v2/concept-index.ts` — `expandConceptRecall` (never throws; no-embedder/timeout 1500ms/error all degrade; budget 32 new embeddings with the query embedded first; LRU cap 4 model fingerprints with rowid tiebreak; maxResults 8, score DESC + observationId code-point) over `concept-vectors.sqlite` in `<projectRoot>/.openbuff/memory/concept/` (dir 0700, db 0600, PRAGMA journal_mode=DELETE, meta schemaVersion=1 + conceptEmbeddingTextVersion='1'; vectors keyed by (sha256 embedText, fingerprint); embed text = kind+summary+detail normalized, 512 cap). Determinism firewall per SPEC S5: the repository gains an optional injected `recallExpander` (composition root: provider.ts loads indexing.semantic, `createConfiguredEmbedder` from @openbuff/sdk, any failure ⇒ semantics-off); `buildLexicalResult` is now async (single caller), builds a bounded corpus (≤256 active observations), adds the constant-0 `conceptRank` reserved slot to `compareObservations` (ordering-neutral), and appends AT MOST 8 `concept-advisory` entries (score 0, reasons[0].code 'concept-advisory') AFTER the lexical reusableDiscovery slice — never reordering the prefix, never touching the cover gate, freshness, or compaction. Byte-identity is defined over the authoritative view (result minus concept-advisory entries): semantics-off, cache-cold, and warm all produce identical authoritative results; degraded expansion is byte-identical to off. Tests: `concept-index.test.ts` (10) and `concept-firewall.test.ts` (3). Receipt `conceptExpanded` producer deliberately deferred (documented future seam)._

- _Knowledge refresh 2026-09-19 (P7/P8 supporting tests + flake note): store-level P7 tests in `bun-sqlite-memory-repository.test.ts` (claim_dedup build/retraction/rebuild + first-wins, contradiction integration — shared stableChunkId flags both live decisions until superseded, chain-fold replay A→B→C head resolution) and coordinator tests (reinforced on dedup hit, new row when the boundary method is absent, metadata claimId, supersedes second batch). Known pre-existing environmental flake: `bun test src/commands/__tests__/memory-command.test.ts` intermittently aborts at load with tree-sitter `packages/code-map/src/tree-sitter-queries/tree-sitter-c_sharp-tags.scm` parse errors ('Unhandled error between tests'); the file is untouched and git-clean and the suite passes on retry — not caused by memory-v2 work._

- _Knowledge refresh 2026-09-19 (P8 concept vector composite-key fix): `concept_vectors` in `cli/src/services/memory-v2/concept-index.ts` is now keyed by the composite `(embedding_hash, fingerprint)` primary key (matching the documented persisted format "vectors keyed by (sha256 embedText, fingerprint)"), so vectors from different model fingerprints coexist and a fingerprint switch no longer evicts/overwrites the other model's cache (the 4-fingerprint LRU is now real). `openConceptDatabase` migrates existing single-key v1 stores in place (transactional rename → recreate → copy → drop; failure rolls back and degrades to null/semantics-off), bumps `concept_meta.schemaVersion` to '2', and fingerprint-LRU eviction now also deletes evicted fingerprints' vector rows so the store stays bounded. Tests in `concept-index.test.ts`: fingerprint coexistence + switch-back cache hit, legacy v1 migration row preservation, LRU vector pruning; `schemaVersion` assertion updated to '2'._

- _Knowledge refresh 2026-09-19 (P7 mixed-version repair, migration-reviewer wave): store `PRAGMA user_version` bumped 2 → 3 (`SCHEMA_VERSION` in `bun-sqlite-memory-repository.ts`) so a pre-P7 build sharing the file fails closed at its own open (its version check rejects higher stores) — closing the window where its GC selection could archive a `claim.reinforced`-protected observation or its rebuild could leave `claim_dedup` stale; `validateSchemaShape`/preflight accept any version 1..SCHEMA_VERSION. Defense in depth: every open now deletes `claim_dedup` rows whose observation is absent from `memory_claims` (a legacy build's compaction/rebuild truncated projections without maintaining claim_dedup, and a stale row made a later record_decision dedup-hit the deleted observation and silently replace the new decision text with a folds-to-nothing `claim.reinforced`). `claim.corrected`/`claim.consolidated` folds reseed `claim_dedup` from the replacement observation's `provenance.metadata.claimId` (dedup continuity: a duplicate reinforces the surviving correction/consolidation head instead of bloating). `getObservationStatus` fails closed: unreadable/non-object/lifecycle-less `state_json` maps to the new `'unknown'` status (added to `MemoryObservationStatusEntry.status` on the sdk boundary) which supersession-safety callers treat as ineligible — only provably-active rows are supersession-eligible. Enforcing tests: version bump + stale-row reconciliation, corrupted-state fail-closed mapping, dedup continuity across correct/consolidate + rebuild._

- _Knowledge refresh 2026-09-19 (staleness guard touch): the regenerated tool-definition commit for the `record_decision` supersedes param touched `cli/src`; this entry keeps `cli/knowledge.md` newer than its sibling `src/` for the pre-push memory-drift guard._

- _Knowledge refresh 2026-09-19 (advisory cleanup): `concept-index.ts` drops the dead `queryHash` local (the query is embedded by position `vectors[0]`, never hash-looked-up) and `expandConceptRecall` now computes `modelDigest` once in the wrapper and passes it to `expandConceptRecallInner` instead of recomputing `conceptFingerprint(embed)` twice. No behavior change; concept-index/firewall/provider suites 25/0._

- _Knowledge refresh 2026-09-20 (staleness guard touch): the TUI theme-consistency + picker-polish commit `325709938` touched `cli/src` (borderless run summary, themed `/update` box, rounded BORDER_CHARS on picker screens, theme-surface focus rows, emoji cleanup, diff-viewer/agent-helpers theme colors); this entry keeps `cli/knowledge.md` newer than its sibling `src/` for the pre-push memory-drift guard._

- _Knowledge refresh 2026-09-20 (eviction telemetry in the status bar): the compaction overhaul's followup work gave the CLI visibility into the deterministic evictor's free reclaim. `common/src/types/print-mode.ts`'s `context_window` schema carries an additive optional `evictedTokens` (per-iteration reclaim; often the ONLY event an eviction iteration produces, since the free reclaim usually prevents an LLM pass entirely). `cli/src/utils/sdk-event-handlers.ts` `handleContextWindow` is the SINGLE accumulation point: the same iteration's amount is also stamped on the compaction status/result events, so those notice writers carry — never add — the total, preventing double-counting. `cli/src/types/chat.ts` `CompactionNotice.evictedTokens` is the turn-cumulative total, and an eviction-only notice (count 0, nothing live) stays observable so the chip can report real work. `cli/src/utils/status-bar-chips.ts` renders an eviction-only turn as `⇲ freed 12k` (secondary tone — informational, not a warning; `⇲ ↧12k` at xs/sm) and a settled count label gains `· freed 34k` at lg only; pending labels are unaffected. Coverage: `cli/src/utils/__tests__/status-bar-chips.test.ts` (eviction-only render at every width, lg-only suffix, pending immunity) and `cli/src/utils/__tests__/sdk-event-handlers.test.ts` (accumulation, no-write on garbage values, no-double-count across the three event types)._

- _Knowledge refresh 2026-09-20 (staleness guard touch): the regenerated tool-definition mirror commits `c463d5edd` and `09843377f` (the `recall_context` query-description reword propagated into all four generated mirrors, including `cli/src/data/initial-agent-type-sources.generated.ts`) touched `cli/src`; this entry keeps `cli/knowledge.md` newer than its sibling `src/` for the pre-push memory-drift guard._

- _Knowledge refresh 2026-09-21 (staleness guard touch + list_jobs ownership): this branch's `run.ts` change scopes background-job ownership by the stable per-process session seed (`getTrustedSessionClientId()`) instead of the per-run `promptId`, so `list_jobs`/`check_job`/`kill_job`/`read_logs` keep working across consecutive turns of one CLI session; `sdk/src/__tests__/run-list-jobs-gate.test.ts` now seeds gate rows with that same owner. This entry keeps `cli/knowledge.md` newer than its sibling `src/` for the pre-push memory-drift guard._
