# CLI Package Knowledge

## Long-running Agent UX

- Productive agent runs are unlimited by default. `maxAgentSteps` is an optional fixed cap; `-1` selects unlimited mode.
- The runtime stops repeated no-progress patterns separately, and the CLI renders the resulting resumable checkpoint instead of treating it as a missing agent response.
- Completion summaries count final file outcomes, terminal top-level failures, and auxiliary-agent failures without duplicating recovered nested tool errors.
- Regenerate bundled agents and starter type sources with `bun run prebuild:agents` after changing shipped agents or public tool schemas.
- Public agent/tool type changes must also run the repository-root generator (`bun scripts/generate-tool-definitions.ts`); CI verifies `cli/src/data/initial-agent-type-sources.generated.ts` is committed.
- `read_files` selector caps (window `windowSize` ≤ 5000, `around` `contextLines` ≤ 2000) are reflected in generated tool type sources; regenerate after any public read-tool param change so CI's tool-definition freshness check stays green. (The `read_blocks` tool was removed; its selectors are now read_files `windows`/`around`/`symbols`.)

## Slash Commands and Plan Mode

- Durable planning is entered through `mode:plan`; the standalone `/plan` command is intentionally absent from `COMMAND_REGISTRY` and `SLASH_COMMANDS` so there is one plan-entry path.
- Keep the durable-plan quartet registered: `/resume-plan` (`rp`), `/update-plan` (`up`), `/plan-status` (`ps`), and `/lessons` (`lesson`). These commands operate on `.agents/sessions/<slug>/` artifacts and fall back to the plan-session picker when no target is provided.
- `/plans` (`plan-ls`) lists the artifact-bearing sessions returned by `listPlanSessions()` and never prompts the agent, while `/plan-use` (`plan-active`, `use-plan`) writes the `ACTIVE_SESSION` pointer file under `.agents/` and only accepts a bare slug or `.agents/sessions/<slug>` — the resolved directory must be exactly one segment under `.agents/sessions/` because the pointer stores bare slugs, so nested paths, non-session paths, missing directories, and artifact-less directories are all rejected before any write. Both share `formatPlanSessionListRow` / `PLAN_SESSIONS_DIR_PREFIX` from `cli/src/commands/plan-artifacts.ts` so the rendered box and the text report cannot drift.
- `/memory` (alias `/mem`, `cli/src/commands/memory-command.ts`, registered in `command-registry.ts` and listed in `data/slash-commands.ts`) inspects the persisted cross-session task memory for the current project (`.openbuff/memory/task-memory.json`). `/memory status` (the default) reports the record's revision and age, its goal and per-list counts, and how much of its evidence still verifies against disk, listing up to five stale paths; `/memory prune` drops evidence that no longer verifies. Both subcommands are move-aware via `collectWorkspaceMoves` + `WorkspaceJournalService` so a renamed file's evidence rebinds rather than being reported stale and deleted.
- Slash-command descriptions should stay model-agnostic under BYOK/local mode. Use wording such as "configured reviewer" rather than naming hosted models.

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

- Queue processing uses a single-owner lock plus a watchdog in `cli/src/hooks/use-message-queue.ts` so stale async cleanup cannot release a newer queue-processing run.
- Plan blocks render known and custom artifact paths as static text, while plan command strings render as `Button` controls that call `onInsertCommand` to prefill the chat input without submitting. Keep this callback threaded through `MessageWithAgents`, `MessageBlock`, `BlocksRenderer`, `SingleBlock`, and nested `AgentBranchWrapper` when changing plan or agent rendering.
- Status indicators in `cli/src/utils/status-indicator-state.ts` distinguish retrying, reconnecting, paused ask_user prompts, and phase-aware waiting/streaming labels.
- Re-render performance tests rely on debug rerender logs from `CODEBUFF_PERF_TEST=true`; tmux global env propagation is best-effort because `new-session` can start the server and inherit the current process environment.
- Slash-command and agent-mention menu behavior is covered by focused CLI tests; keep the knowledge notes in sync when changing menu navigation, visible-item caps, or insertion semantics.
- Release validation runs `bun --cwd=scripts run guard:memory-drift`; if CLI `src/` or tmux interaction behavior changes, refresh `cli/knowledge.md` and/or `cli/tmux.knowledge.md` in the same commit so the staleness guard stays green.
- Gate vs Specialist routing canonical matrix lives in `agents/base2/quality-prompt-section.ts` (`specialistRoutingSection`) and `agents/guides/specialist-routing.md`; `docs/agents-and-tools.md` links there for the Params Contract (`snapshot_id` vs `snapshot_fingerprint`).
- Index workspace watching now classifies file changes before notifying the index manager: ignored top-level build/cache directories and the configured cache dir are skipped, file updates and deletes are batched as path-specific deltas, ambiguous directory/watch errors mark the index stale, and at most four project roots keep active recursive watchers.
- `cli/src/components/renderers/gate-state-box.tsx` renders `<gate-state>` blocks as a bordered box supporting exactly the four `GateStateStatus` values from `cli/src/types/chat.ts` — `pending` (`…`, warning), `passed` (`✓`, success), `failed` (`✗`, error), and `skipped` (`–`, warning) — with the heading format `<icon> <origin ?? 'Gate'> · <gate> · <STATUS_LABEL>`; keep `STATUS_LABEL`, `STATUS_ICON`, and `statusColor` exhaustive when adding a status. The block schema is `gate`/`status` (required) plus optional `details`, `origin`, and `advisories`: `advisories` is an additive array of non-empty reviewer observations that never changes the gate status, is dropped entirely by `parseGateStateBlock` unless every entry is a non-empty string, and renders under an "Advisory (non-blocking):" bulleted list after `details`. base2 bounds it to 8 entries of ≤240 chars per block, so downstream consumers must treat it as optional and already-truncated.
- `cli/src/commands/git-command-args.ts` parses user-supplied `/diff` and `/status` arguments with `parseSafeGitArgs`, which rejects shell operators and expansions (newline, `;`, `$`, backtick, `|`, `&`, `<`, `>`, `\`) and unclosed quotes while intentionally allowing `()[]{}` so git pathspec magic such as `:(exclude)` still works; `quoteShellArgument` single-quotes each argument (escaping embedded single quotes) and `buildSafeGitCommand` assembles the final command with a fallback argument list, so route any new git-backed slash command through these helpers instead of interpolating raw input.
- `cli/src/utils/sdk-event-handlers.ts` consumes the additive `job_update` print-mode event through a catch-all branch, so unknown future event variants stay no-ops rather than throwing.
- `cli/src/data/initial-agent-type-sources.generated.ts` is regenerated by the repository-root `bun scripts/generate-tool-definitions.ts`, so any new public tool schema (e.g. the `occurrence` selector on `replace_range`, or the `windows`/`around`/`symbol` selectors on `read_files`) must land with a regenerated, committed copy of that file — CI verifies it is current. The same freshness check gates the three `tools.ts` type sources (`agents/`, `.agents/`, `common/src/templates/`), so a `list_jobs` description/schema change also requires regenerating and committing those.
- `list_jobs` returns an owner-scoped digest of background jobs (process + agent) with bucketed pending output relative to the `check_job` cursor, a `gap` flag, terminal tails, and a 10-row cap; when nothing changed this turn the SDK change-gate in `sdk/src/run.ts` (`applyListJobsDigestGate`) swaps it for a suppressed `{ unchanged: true, note }` payload. See `common/docs/list-jobs.md` for both output variants.
- `scripts/measure-context-baseline.ts` measures the per-turn fixed context cost (system prompt, file tree, knowledge files, injections) and is the baseline for the context-budget ledger in `packages/agent-runtime/src/util/context-budget.ts`.
- The built-in `query_index` result JSON carries an additive optional `indexMutationEpoch` (the IndexManager's in-process epoch, incremented on `markStale`/`markPathsChanged`). base2's proactive-retrieval cache uses it to invalidate a cached result when an external index mutation did not advance the workspace revision. The disabled-index result path omits the field, which base2 treats as a match (pre-epoch behavior).
- `spawn_agents` tool results may surface a nested `agentReceipt` (including `status: 'partial'`). `cli/src/utils/sdk-event-handlers.ts` narrows that receipt without `any` and marks the corresponding agent block partial even when only the receipt is present, so incomplete specialist turns stay visible in the TUI.
- BACKGROUND terminal cards wire `backgroundJobId` from the launch `tool_result` so live `job_update` events settle lifecycle/output in place without a `check_job` poll; keep frozen JSON status from being treated as authoritative after settle.
- `cli/src/utils/create-run-config.ts` and regenerated agent type sources track content-search/glob `cwd` ergonomics (file-as-cwd coercion, paths param, flag allowlist). After public tool schema changes, regenerate `cli/src/data/initial-agent-type-sources.generated.ts` via the root tool-definition generator.
- `cli/src/components/blocks/blocks-renderer.tsx` wraps every block and block group in its own nested `ErrorBoundary` (`isolateBlock`), with the React key on the boundary. Keep new block handlers routed through it: `@opentui/react`'s root boundary is app-wide, so an unguarded render throw in one persisted block blanks the whole session on every reload.

- `cli/src/components/renderers/compaction-box.tsx` derives the pending/interrupted/unsettled triple in one `derivePresentation` helper that both `deriveTone` and the render path consume, so the chosen tone and the rendered lines cannot drift. A `status: 'pending'` block is only presented as live when `isLiveCompaction` confirms it belongs to THIS process (matching `liveSessionId`); a replayed pending block from a persisted transcript renders as "Interrupted before this pass reported a result." rather than a permanently spinning "Compacting context…" card. `cli/src/utils/sdk-event-handlers.ts` consumes the additive `context_compaction_status` event and pairs `started`/`settled` strictly by the event's required `runId` — never by `agentId`, which subagent forwarding rewrites — so a nested agent loop's settle cannot clear the root turn's live card; `handleFinish` rewrites any stray pending block as interrupted so an aborted turn leaves an honest terminal record.

- _Knowledge refresh 2026-08-23: add `/memory` (alias `/mem`) slash command; staleness guard touch._

- _Knowledge refresh 2026-08-31: live compaction status rendering (`context_compaction_status` consumption, run-correlated pending/settled pairing, replayed-pending-as-interrupted) in `cli/src/utils/sdk-event-handlers.ts` and `cli/src/components/renderers/compaction-box.tsx`._

- _Knowledge refresh 2026-08-31 (followups): `handleRuntimeError` in `cli/src/utils/sdk-event-handlers.ts` now splits runtime error events by `autoRecovering` — auto-recovering notices log at `debug` (`'SDK auto-recovering runtime notice'`) with no visible error banner, while genuine failures still log at `error` (`'SDK runtime error event'`) and render. Tool-ordering rejections (the `suggest_followups` gate/ordering rejections and the pre-gate `git-committer withheld` chunk) arrive with a concise `userMessage` plus `autoRecovering: true`, so the model still receives the full `message` via the `TOOL_CALL_ERROR` path in `packages/agent-runtime/src/tools/stream-parser.ts`; `git-committer blocked by unvalidated dirty file(s)` deliberately stays user-visible because it asks the user to reply `COMMIT ANYWAY`._
