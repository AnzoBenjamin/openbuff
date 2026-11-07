# Shard 2 — CLI input components (uncommitted audit)

Shard: audit-uncommitted-2026-10 / shard-2-cli-components
Branch: feat/polyglot-reaudit-roadmap (working tree = source of truth)

Files audited (diff + working tree):
- cli/src/components/multiline-input.tsx (modified, +286)
- cli/src/components/chat-input-bar.tsx (modified, +44)
- cli/src/chat.tsx (modified, +63)
- cli/src/hooks/use-chat-input.ts (modified, +14)
- cli/src/hooks/__tests__/use-chat-input.test.ts (modified, +18)
- cli/src/components/__tests__/multiline-input-height.test.ts (new)

Verification performed: full git diff review; working-tree reads of all files plus the dependency cli/src/utils/text-layout.ts and cli/src/utils/input-modes.ts; `bun test` on the new/modified tests (46/46 pass), existing multiline-input.test.tsx (71/71 pass), and text-layout.test.ts (3 deterministic failures — see cross-shard note); `bun run typecheck` in cli/ (clean); grep of all 12 `<MultilineInput` render sites and the single `<ChatInputBar` / `useChatInput` call sites.

Severity counts: 0 CRITICAL, 0 HIGH, 2 MEDIUM, 4 LOW, 1 cross-shard note.

---

## Finding 1 — Box height now trusts hand-maintained width estimates that are observably wrong for some modes

Severity: MEDIUM
Domain: Correctness (with Performance-motivated regression surface)
Files: cli/src/hooks/use-chat-input.ts:46-59, cli/src/chat.tsx:1611, cli/src/components/chat-input-bar.tsx:505-518, cli/src/utils/input-modes.ts

Risk: The forwarded row count is measured at `inputWrapColumns(inputWidth)`, and the box trusts it (see Finding 2 for why nothing cross-checks it). `inputWidth` is derived from two estimates:
- `estimatedToggleWidth` is 0 whenever `inputMode !== 'default'` (use-chat-input.ts:47-49), but the full-height branch renders the AgentModeToggle on `modeConfig.showAgentModeToggle && !isNarrowWidth` (chat-input-bar.tsx:505). `help` mode (reachable via the `/help` command, cli/src/commands/help.ts:9) and `homeDir` mode both set `showAgentModeToggle: true`, so at full height and non-narrow width the toggle (~`stringWidth(\`< MODE\`)` + 6 columns) is drawn while the estimate contributes 0 — `inputWidth` overstates the drawable columns by that amount.
- The `widthAdjustment` table is stale for two modes: `openbuff:provider` declares 12 but renders icon `⚙` (1) + paddingRight 1 + ` Provider ` (11) + paddingRight 1 = 14; `openbuff:models` declares 10 vs actual ~11.
- Transiently, the collapsed toggle expands on hover into a much wider SegmentedControl without changing `inputWidth`.

Before this change, MultilineInput's height came from `lineInfo.lineStartCols.length` (the actual rendered wrap at the drawn width) and was immune to these estimates; only the centering decision used them. Now a value that wraps into more rows at the real (narrower) drawn width than at the estimated columns gets a box shorter than its content — reintroducing, for those modes, the exact overflow the change says it fixes (undersized box, excess rows painted outside). Mitigating: the common `default` mode estimate (`stringWidth + 6`) matches the collapsed toggle exactly (button padding 2 + borders 2 + wrapper paddingLeft 2), and the cap `floor(terminalHeight/2)` masks the undercount whenever both counts exceed it.

Suggested fix: gate `estimatedToggleWidth` on the same condition the render uses (modeConfig.showAgentModeToggle && !isNarrowWidth && !isCompactHeight, using the mode config rather than `inputMode !== 'default'`); correct the two stale `widthAdjustment` entries; longer term, reconcile the forwarded count against `lineInfo` once it exists (prefer the actual rendered rows when they exceed the forwarded count).

## Finding 2 — The measurementKey staleness guard is tautological in the shipped wiring

Severity: MEDIUM (design/doc; no runtime break today because React props are atomic)
Domain: Correctness / API contract
Files: cli/src/components/multiline-input.tsx:1279-1288, cli/src/utils/text-layout.ts:782-785

Risk: MultilineInput computes `measurementKey = multilineInputMeasurementKey(value, multilineInputWrapColumns(wrapWidth)!)` from its OWN `value`/`wrapWidth` props and hands both `value` and that key to `computeMultilineInputHeight`, which then checks `measurementKey === multilineInputMeasurementKey(value, wrapColumns)` — the same expression on the same inputs, so it is always true whenever `measuredTotalLines !== undefined`. The producer (chat.tsx) never forwards the key it actually measured with. Consequences:
- The documented protections ("a row count measured for other content / at other columns is not trusted", multiline-input.tsx:1267-1277, text-layout.ts:720-737) are unreachable in production; the function-level tests exercise a hand-built mismatched-key path that production cannot produce, so they pin a code path the real wiring never uses.
- A wrong `wrapWidth` prop (Finding 1) is trusted rather than detected — exactly the case the key was meant to catch.
- The `!` non-null assertion at multiline-input.tsx:1287 papers over `wrapWidth === undefined`: a call site forwarding a count without a width would produce key `'unwrapped\0value'`, match, and trust a count with no column identity at all.

Suggested fix: have chat.tsx compute and forward the producer-side identity (e.g. `multilineInputMeasurementKey(layoutContent, cols)` or the measured columns) and compare producer vs consumer keys in `computeMultilineInputHeight`; replace the `!` with an explicit undefined branch that refuses to trust the count.

## Finding 3 — Comments misstate mount topology, the old effect deps, and the protection the key provides

Severity: LOW
Domain: Correctness (documentation)
Files: cli/src/components/multiline-input.tsx:334-340, 1267-1277, 626-629; cli/src/utils/text-layout.ts (PlaceholderLineMemo docs)

Risk: Several load-bearing comments describe things that are not true in the working tree: (a) "Two MultilineInputs are mounted in one frame by chat-input-bar's compact and full-height branches" — chat-input-bar.tsx:328 early-returns, the branches are mutually exclusive (the per-instance memo is still the right design for dialog mounts, but the stated rationale is wrong); (b) the staleness protection described at 1267-1277 does not exist in the wiring (Finding 2); (c) the tab-expansion comment (626-629) claims the fresh identity "re-ran the scroll effect, which keys on the rendered text" — the old effect's deps were `[scrollBoxRef.current, cursorPosition, focused, cursorRow]`, not the rendered text. Misleading docs on exactly the invariants this change adds will misdirect future edits.

Suggested fix: correct the three comments.

## Finding 4 — Wiring tests are source-text assertions; nothing executes a rendered MultilineInput

Severity: LOW
Domain: Test coverage
File: cli/src/components/__tests__/multiline-input-height.test.ts:688-890

Risk: The "input layout measurement wiring" describe block pins prop forwarding by string-matching JSX blocks read from source with fs.readFileSync. It does catch a deleted forwarding hop (assertions match the current source and the blocks parse correctly), and the function-level tests import the real modules (text-layout helpers and the real exported seams from ../multiline-input — verified 46/46 pass). But a same-named wrong variable, a runtime branch inside the component, or a reorder of the dep array would not be caught. The scroll-effect test parses the dependency array out of the source — same class. Acceptable given MultilineInput cannot render under bun test without the OpenTUI app context (stated in the file), but it is the weakest link in the "would it fail if the wiring regressed" question: it fails on textual regression, not behavioral.

Suggested fix: none practical under the current runner; if the CLI test harness gains an OpenTUI render context, convert the forwarding pins to render-based assertions.

## Finding 5 — use-chat-input test does not cover the clamp interacting with modeWidthAdjustment

Severity: LOW
Domain: Test coverage
File: cli/src/hooks/__tests__/use-chat-input.test.ts:151-165

Risk: The new test covers the happy path (`80 - 2 - 4 = 74`) and the existing test covers clamping without an adjustment. No case asserts `Math.max(1, ...)` still floors when separatorWidth is tiny AND modeWidthAdjustment is large (the NaN-free but sub-1 case). Trivial gap — the clamp expression is unchanged.

Suggested fix: optional one-line case: separatorWidth 4, modeWidthAdjustment 4 → inputWidth 1.

## Finding 6 — stickyScroll removal changes behavior for every MultilineInput mount, not just the chat bar

Severity: LOW
Domain: State mutation / behavior change
File: cli/src/components/multiline-input.tsx:1380

Risk: `stickyScroll={true} stickyStart="bottom"` → `stickyScroll={false}` applies to all ~12 mount sites (command palette, provider picker, model route picker, prompt history, ask-user custom answer, etc.), which do not opt in explicitly. Focused boxes are equivalent (the effect performs the same cursor-follow clamp the old effect did, now with the cursor-as-target-not-floor fix at 1347-1348 and the unfocused re-clamp at 1330-1341 — both improvements). Unfocused boxes whose content grows programmatically no longer stick to bottom; they hold their offset, clamped legal. No site was found that depends on unfocused bottom-stick, and existing multiline-input.test.tsx passes (71/71). Flagging as a deliberate global behavior change to be aware of, not a defect.

Suggested fix: none needed; if a dialog later reports "content doesn't auto-follow", this line is why.

## Cross-shard note — shared dependency test suite fails in the working tree

Severity: (for this shard's files: none — dependency owned by the text-layout shard)
Domain: Test coverage / dependency hygiene
File: cli/src/utils/__tests__/text-layout.test.ts (modified, not in this shard)

`bun test cli/src/utils/__tests__/text-layout.test.ts` has 3 deterministic failures in the working tree: "every classified code unit is tokenized on the run the class implies" and "a NEL in a pasted value is tokenized as a single whitespace run" (widthCalls expected 3, received 1) and "the shipped mixed paste path slices exactly one string per token"; plus a flaky wall-clock ceiling test. These live in the other shard's assigned files, but the uncommitted change set as a whole ships failing tests, and my files consume text-layout directly. Not attributable to shard-2 files.

---

## Verified-good (explicitly checked, no finding)

- Performance claim holds: one `measureLines` pass per keystroke (chat.tsx:1584-1629 useMemo), zero in MultilineInput's render body when the forwarded count is present, and the idle empty-input frame costs zero passes (trusted count + per-instance placeholder memo). `computeMultilineInputHeight` is called in the render body but performs no wrap when the count is current; the placeholder memo write during render is an idempotent keyed cache (strict-mode/double-render safe).
- The useMemo dep array `[inputValue, cursorPosition, inputWidth]` is complete for what it reads; removing `terminalHeight` is correct because the cap moved out of the memo to chat.tsx:1633 (`inputHeightCap`/`inputHeightLines` computed fresh each render), so resize still re-clamps via the forwarded cap and the box's own deps.
- maxHeight expressions: chat.tsx measures uncapped (`Number.MAX_SAFE_INTEGER`, 1627) and applies `Math.floor(terminalHeight / 2)` separately (1633); chat-input-bar uses `Math.floor(terminalHeight / 2)` at both branch sites (329 compactMaxHeight, 495 full). The task brief's expectation of `floor(terminalHeight/2)` at chat.tsx ~1613 is superseded by this (coherent) pre-clamp split; gutter/cap math is consistent between caller and box for every cap value checked, including tiny terminals (cap 0 → max(1, ...)).
- Props flow is name/type consistent end-to-end: chat.tsx 1996-2000 (inputWidth/inputMinHeight/inputTotalLines/inputInputCap/inputGutterEnabled) → ChatInputBar (destructured, forwarded at 394-398 and 496-500) → MultilineInput (wrapWidth/measuredTotalLines/measuredGutterEnabled/callerHeightCap/minHeight) → computeMultilineInputHeight. `tsc --noEmit` clean.
- API contract: all four new MultilineInput props are optional; the other ~12 render sites compile unchanged and hit the fallback path (no wrapWidth → `lineInfoLines ?? 1` with a 1-row floor, placeholder not counted, cursorRow gutter fallback, own maxHeight for scrollability), which reproduces the old lineInfo-based behavior; the placeholder is still covered there via lineInfo (it reflects the drawn text). ChatInputBar's `inputWidth` is required but its sole call site passes it. `useChatInput`'s `modeWidthAdjustment` is required and every INPUT_MODE_CONFIGS entry provides a number (no NaN path).
- Scroll effect: dep list (`layoutMetrics.totalLines`, `heightLines`, `wrapWidth`, `cursorRow`, `focused`) covers every fact that can move the legal offset range; gutter flips are covered via `heightLines`; same-row keystrokes correctly skip re-clamping; unfocused re-clamp and cursor-as-target fixes are strict improvements.
- `expandTabsForRendering` fast path returns the same reference when no tab is present; identity pinned by test.
- New test file imports the real modules (not mocks); all 46 tests pass.

## Coverage receipt

- cli/src/components/multiline-input.tsx — audited (diff + working tree): new props/fallback paths, height computation call site, scroll effect rewrite, stickyScroll removal, tab fast path, placeholder memo ownership; findings 1, 2, 3, 6.
- cli/src/components/chat-input-bar.tsx — audited: both branch forwards verified line-by-line, compact/full mutual exclusivity, compactMaxHeight, toggle render condition vs estimate (finding 1 input).
- cli/src/chat.tsx — audited: inputLayoutMetrics memo (deps complete, uncapped measurement deliberate), inputHeightCap/inputHeightLines, isMultilineInput semantics vs old heightLines>1 (equivalent), single ChatInputBar site forwards all new props.
- cli/src/hooks/use-chat-input.ts — audited: modeWidthAdjustment subtraction, no NaN path (typed required number), estimate condition mismatch with toggle render condition (finding 1).
- cli/src/hooks/__tests__/use-chat-input.test.ts — audited: new test correct (74 = 80-2-4), passes; clamp interaction gap (finding 5).
- cli/src/components/__tests__/multiline-input-height.test.ts — audited: function-level tests behavioral and import real modules, wiring tests source-text based (finding 4), 46/46 pass.
