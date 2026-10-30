# Audit findings: gap-cli-deep

- Subsystems: cli
- Features: opentui-upgrade, markdown-renderer, syntax-highlighter, text-layout-wrap, diff-viewer, markdown-tables, chat-scroll, batched-message-updater, stream-chunk-routing, message-queue, chat-state-persistence, turn-checkpoint, concept-recall, memory-v2-provider, memory-v2-sqlite-open, recent-projects, open-file, git-command-args, update-version-compare, fuzzy-match, index-command, slash-command-parse, init-command, plan-timeline, info-context-help-image-commands
- Files covered: 27
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] dependency-hygiene — cli/package.json:37 — OpenTUI 0.2.2 -> 0.5.x upgrade: quantified deletion + migration risk
- **Risk:** Pinned @opentui/core and @opentui/react at 0.2.2 (package.json:37-38) force the CLI to hand-roll four subsystems that 0.5.x ships natively. Deletable/shrinkable code (read in this shard): syntax-highlighter.tsx (20 lines, whole file, a stub), markdown-renderer.tsx (1269 lines; about 1100 are renderer/wrap/table code), diff-viewer.tsx (548 lines; about 300 lines of render/wrap/side-by-side geometry), text-layout.ts (165 lines; the wrap helpers, about 110 lines). Total is about 1,500 LOC plus the remark-parse/remark-gfm/remark-breaks/unified/mdast/string-width dependencies. Migration risks: (1) three pre-1.0 minor versions, so expect breaking React reconciler/intrinsic-prop changes (span fg/bg/attributes, text wrapMode) across every component. (2) The Zig core means per-platform native prebuilt binaries, which affects the single-binary/wrapper distribution. (3) The ScrollBoxRenderable API is used directly (use-scroll-management.ts:92,134 verticalScrollBar.scrollPosition, viewport.height). (4) Snapshot tests are coupled to hand-rolled output (utils/__tests__/markdown-renderer.test.tsx, tools/__tests__/diff-viewer.test.tsx, utils/__tests__/text-layout.test.ts). (5) Palette/theming contract (MarkdownPalette) must be remapped onto native renderable styles. Versions and features are the web facts supplied by the parent. I did not verify them against the 0.5 changelog.
- **Fix:** Do the upgrade in a dedicated branch in 3 steps. (a) Bump to 0.5.x with no feature changes, fix reconciler/prop breakage, and verify prebuilt binaries for darwin-arm64/x64, linux-x64/arm64, and win32. (b) Swap syntax-highlighter to the Code renderable and diff-viewer rendering to the Diff renderable, keeping parseDiffIntoHunks for stats. (c) Swap markdown-renderer and tables to the Markdown/TextTable renderables, delete remark deps, and replace output-snapshot tests with semantic tests. Cost is about 1–2 engineer-weeks. Confidence is medium, since the 0.5 API surface was not read locally.
- **Evidence:** cli/package.json:37 "@opentui/core": "0.2.2", :38 "@opentui/react": "0.2.2". markdown-renderer.tsx totalLines 1269; diff-viewer.tsx 548; text-layout.ts 165; syntax-highlighter.tsx 20. wrapTextToVisualLines is referenced by terminal-command-display, diff-viewer, and markdown-renderer. wrapTextPreservingNewlines is referenced by 9 components (agent-branch-item, agent-branch-wrapper, content-with-markdown, message-block, message-with-agents, thinking, discovery-output, query-index, tool-call-item).

## [HIGH] correctness — cli/src/utils/syntax-highlighter.tsx:9 — Syntax highlighter is a no-op stub; use OpenTUI 0.5 Code renderable + worker TreeSitterClient
- **Risk:** Mechanism: highlightCode() ignores lang and returns <span fg>{code}</span> (lines 9-19, comment 'For now, just return the code'). markdown-renderer renderCodeBlock (around line 640) also emits monochrome spans, so every code block and diff in the chat is unhighlighted. TS is fine as the host language, but tree-sitter parsing on the render thread would jank streaming, so the right home is a worker. Best option: consume the OpenTUI 0.5 Code renderable with its worker TreeSitterClient. Do not write a TS highlighter (shiki/highlight.js add weight and run on the main thread). Unlocks now: real highlighting in code fences and read_files/str_replace tool output. Unlocks later: language-aware folding and inline diagnostics.
- **Fix:** Delete syntax-highlighter.tsx. Render fenced code through <code lang=...> (Code renderable) after the 0.5 bump. Map theme colors to a tree-sitter theme. Cost: small (about 1 day) once the upgrade lands. Confidence: high that it is a stub; medium on the exact renderable API.
- **Evidence:** syntax-highlighter.tsx:16-18 "// For now, just return the code with basic styling\n// Can be enhanced later with actual syntax highlighting\nreturn <span fg={fg}>{code}</span>". markdown-renderer.tsx renderCodeBlock pushes <span fg={palette.codeTextFg} bg=...> per wrapped line with no tokenization.

## [HIGH] performance — cli/src/utils/markdown-renderer.tsx:1210 — Hand-rolled remark->React markdown renderer re-parses the whole message on every streaming flush
- **Risk:** Mechanism: a unified/remark-gfm/remark-breaks parse (line 113) produces an mdast. A custom parseInlineFallback emphasis pass (about lines 395-470) and a hand-built React span tree follow, with manual word-wrapping per inline segment (appendWrappedInlineSegment/wrapInlineNodes) and a nextKey() counter. renderStreamingMarkdown (about line 1235) re-runs a full parse of the complete prefix on every update. Combined with the 100ms batched flush (message-updater.ts:29), that is O(n) re-parse plus O(n) React element creation per flush for long answers, so cost grows quadratically over a stream. Keys are counter-based, so React cannot reuse nodes across renders. The wrapping splits by code point (for...of), not grapheme. Needs: incremental, grapheme-correct, fast styled text. Best option: the OpenTUI 0.5 Markdown renderable (native Zig layout, grapheme-aware width), which moves parse/layout off React reconciliation. TS is the wrong layer for per-cell layout. Unlocks now: smooth streaming for long messages and deletion of about 1100 LOC plus 4 deps. Unlocks later: native selection/copy across markdown, and links/OSC8.
- **Fix:** After the 0.5 bump, replace ContentWithMarkdown's renderMarkdown/renderStreamingMarkdown with the Markdown renderable and feed it appended text (streaming-aware). Keep the parseInlineFallback quirk only if product needs the 'Other**.github/**' behavior; otherwise drop it. Until the upgrade, memoize by completed-block boundary so only the tail block is re-parsed. Cost: medium (3-5 days incl. tests). Confidence: high on mechanism.
- **Evidence:** markdown-renderer.tsx:113 `const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks)`. renderMarkdown calls processor.parse(markdown) then applyInlineFallbackFormatting(ast) on every call. renderStreamingMarkdown → renderMarkdown(completeSection) each render. createRenderState nextKey counter `markdown-${counter}`. content-with-markdown.tsx:31-34 calls renderStreamingMarkdown when isStreaming. message-updater.ts:29 DEFAULT_FLUSH_INTERVAL_MS = 100.

## [MEDIUM] correctness — cli/src/utils/markdown-renderer.tsx:860 — Markdown tables flattened to plain text with hand-computed box drawing; use TextTable renderable
- **Risk:** Mechanism: renderTable converts cells via nodeToPlainText, which loses inline code/bold/links. It computes naturalWidths with stringWidth, scales proportionally, wraps with a local wrapText (a third copy of the wrap algorithm in this file, plus text-layout.ts), and pads with spaces. Cell formatting is lost, and emoji/ZWJ widths are miscounted because char iteration is not grapheme-aware. Best option: the OpenTUI 0.5 TextTable renderable. Unlocks now: correct wide-char tables and styled cells. Unlocks later: resizable/scrollable tables for tool output (query_index and code_search results).
- **Fix:** Replace renderTable/wrapText/padText with TextTable during the markdown migration. Cost: small. Confidence: medium-high.
- **Evidence:** markdown-renderer.tsx renderTable: `const rows = table.children.map(row => cells.map(cell => nodeToPlainText(cell).trim()))`. The local `const wrapText = (text, maxWidth)` duplicates text-layout.ts wrapTextToVisualLines. `for (const char of token)` breaks by code point.

## [MEDIUM] correctness — cli/src/utils/text-layout.ts:60 — JS word-wrap/measure duplicates the renderer's layout and is not grapheme-aware
- **Risk:** Mechanism: measureLines/wrapTextToVisualLines split on whitespace, measure with string-width, and hard-break oversize tokens with Array.from(segment), which splits code points and so breaks ZWJ emoji, flags, and combining marks mid-cluster. Components pre-wrap text in JS and then render with wrapMode none, so JS layout and native layout can disagree, which causes cursor/height drift in computeInputLayoutMetrics (used by chat.tsx). Best option: rely on OpenTUI 0.5 native grapheme-aware wrapping for display. Keep only computeInputLayoutMetrics, re-backed by the renderer's measure API or Intl.Segmenter. TS is fine for the remaining height logic. Unlocks now: correct emoji/CJK wrapping and removal of pre-wrap in 9+ components. Unlocks later: native reflow on resize without React re-render.
- **Fix:** Short term: replace Array.from with Intl.Segmenter('grapheme') in both wrap loops (lines ~26 and ~85). After the 0.5 bump, delete wrapTextToVisualLines/wrapTextPreservingNewlines callers in favor of wrapMode word, and keep computeInputLayoutMetrics. Cost: small/medium. Confidence: high.
- **Evidence:** text-layout.ts:26 `for (const ch of Array.from(segment)) { const w = stringWidth(ch)`. :85 same pattern in wrapTextToVisualLines. The referencedBy list shows wrapTextPreservingNewlines used in 9 components and computeInputLayoutMetrics in cli/src/chat.tsx. diff-viewer.tsx renders pre-wrapped lines with style wrapMode 'none'.

## [MEDIUM] performance — cli/src/components/tools/diff-viewer.tsx:318 — Hand-rolled diff viewer with a 400-node render cap; use the Diff renderable
- **Risk:** Mechanism: parseDiffIntoHunks (line ~160) is a solid unified-diff parser with correct line counters. Rendering creates one <text> React node per wrapped line (unified or side-by-side), and it needs DIFF_MAX_RENDER_NODES=400 (line 61) plus auto-collapse (DIFF_INITIAL_MAX_LINES=80) because React node cost dominates. parseDiffIntoHunks re-runs on every render (not memoized, line ~327), and renderNodeCount is a mutable render-time counter, which is fragile under concurrent rendering. No intra-line (word) highlighting and no syntax colors. Best option: the OpenTUI 0.5 Diff renderable for display, keeping parseDiffIntoHunks/countDiffStats in TS for stats and collapse metadata. Unlocks now: large diffs without truncation, and syntax plus word-level highlighting. Unlocks later: interactive hunk accept/reject in review-screen.
- **Fix:** Wrap parseDiffIntoHunks in useMemo now (a cheap fix). After the upgrade, replace renderUnifiedBody/renderSideBySideBody/pairSideBySideRows (about 300 LOC) with the Diff renderable, and drop the node cap. Cost: medium (2-3 days). Confidence: medium-high.
- **Evidence:** diff-viewer.tsx:59-61 DIFF_INITIAL_MAX_LINES = 80, DIFF_INITIAL_MAX_HUNKS = 8, DIFF_MAX_RENDER_NODES = 400. In the DiffViewer body: `const parsedDiff = parseDiffIntoHunks(diffText)` with no memo, and `let renderNodeCount = 0` mutated inside map callbacks. Footer text: '… render capped at 400 nodes; collapse hunks or narrow the diff'.

## [MEDIUM] performance — cli/src/hooks/use-scroll-management.ts:125 — Scroll listener re-subscribed every render; JS setTimeout animation loop for scroll
- **Risk:** Mechanism: the useEffect that registers verticalScrollBar.on('change') has no dependency array (lines ~125-155), so it unsubscribes and resubscribes on every render of the chat, which re-renders every 100ms flush while streaming. Smooth scroll is a setTimeout(16ms) easing loop in JS (animateScrollTo), stored in a ref typed as number via 'as any'. Stick-to-bottom is emulated with a 50ms timeout after every messages change plus programmatic-scroll flags, which races with user scroll. TS is fine, but stick-to-bottom belongs in the renderer. Best option: the OpenTUI ScrollBox sticky-scroll/stickyStart option if present in 0.5 (not verified locally). Otherwise keep TS and add deps. Unlocks now: fewer listener churns and fewer auto-scroll fights. Unlocks later: the renderer-driven follow mode removes the 50ms lag.
- **Fix:** Add [scrollRef, cancelAnimation] deps to the listener effect, or use a stable handler via useEvent. Type the timer as ReturnType<typeof setTimeout>. Evaluate native sticky scroll after the upgrade. Cost: tiny now, small later. Confidence: high for the missing deps and medium for native sticky availability.
- **Evidence:** use-scroll-management.ts: `useEffect(() => { ... scrollbox.verticalScrollBar.on('change', handleScrollChange); return () => {...off...} })` has no deps array. `animationFrameRef.current = setTimeout(animate, frameInterval) as any`. AUTO_SCROLL_DELAY_MS = 50 and the setTimeout in the [messages,...] effect.

## [LOW] performance — cli/src/utils/message-updater.ts:124 — Batched message updater: correct design, O(messages) map per flush
- **Risk:** Mechanism: it queues updaters and flushes every 100ms via setInterval, composing them and applying prev.map over all messages. It is correct: flush before dispose, and markComplete/setError flush first. The cost per flush is O(total messages) plus a new array, which triggers re-render of the message list. In long sessions, most cost is downstream markdown re-parse (see the markdown finding), not here. TS is best, with no daemon or library needed. It could flush on requestAnimationFrame-equivalent renderer frame ticks after 0.5 to align with paint.
- **Fix:** Keep. Optionally index the message by id (findLastIndex then a single slice replace) and align the flush with renderer frame callbacks after the upgrade. Cost: tiny. Confidence: high.
- **Evidence:** message-updater.ts:29 DEFAULT_FLUSH_INTERVAL_MS = 100. flush(): `setMessages((prev) => prev.map((msg) => (msg.id === aiMessageId ? composedUpdater(msg) : msg)))`. `intervalId = setInterval(flush, flushIntervalMs)`.

## [LOW] state-mutation — cli/src/utils/stream-chunk-processor.ts:43 — Stream chunk routing: pure TS reducer, keep
- **Risk:** Mechanism: it maps SDK events to a root or agent destination and appends text immutably via block-operations. It is pure and cheap. TS is best here, and there is no OpenTUI or daemon angle. The only coupling is that downstream appended text feeds the whole-message markdown re-parse.
- **Fix:** Keep. When migrating to the Markdown renderable, expose the appended delta (text) so the renderable can append incrementally instead of re-parsing. Cost: small. Confidence: high.
- **Evidence:** stream-chunk-processor.ts:43-65 processTextChunk → appendTextToAgentBlock / appendTextToRootStream. destinationFromChunkEvent handles subagent_chunk/reasoning_chunk.

## [LOW] state-mutation — cli/src/hooks/use-message-queue.ts:190 — Message queue: careful ownership-token state machine in TS; keep
- **Risk:** Mechanism: a queue is mirrored in state and a ref, with Symbol ownership tokens to ignore stale cleanups, synchronous-throw guarding, and failure re-enqueue plus pause (lines ~280-292). It is correct and well-reasoned. Multiple refs (isProcessingQueueRef, isQueuePausedRef, canProcessQueue state, streamStatus) encode an implicit state machine, which is readable but spread out. setCanProcessQueue is passed to beginQueuedMessageProcessing but unused there. TS is best, with no need for xstate, a daemon, or native. It later unlocks a persisted queue across restarts (the exit drain exists).
- **Fix:** Keep. Optionally remove the unused setCanProcessQueue/isQueuePausedRef params from BeginQueuedMessageProcessingParams. Cost: tiny. Confidence: high.
- **Evidence:** use-message-queue.ts:48-66 beginQueuedMessageProcessing destructures setCanProcessQueue and isQueuePausedRef but never uses them. The onRejected restore is `[rejectedMessage, ...current]` then pause.

## [MEDIUM] performance — cli/src/utils/run-state-storage.ts:330 — Chat persistence writes the full run state 3x as pretty JSON synchronously on the UI thread
- **Risk:** Mechanism: saveChatState sanitizes, then writeJsonAtomic writes chat-state.json (envelope with runState plus messages), then again run-state.json and chat-messages.json. Each is JSON.stringify(value, null, 2) with a sync write plus rename. That is 2x duplicate bytes, synchronous, with pretty-printing, on the TUI event loop after every turn. It also reads and parses the existing envelope first (readEnvelopeVersion) just to check the version. There is no fsync before rename, so it is not durable across power loss on ext4 data=writeback. saveCheckpoint also writes pretty JSON synchronously every ~30s mid-turn. The version-tolerance and quarantine logic is good. TS is fine. The better option is keeping JSON but async/compact, or moving session state into the existing bun:sqlite store (append-only events) for incremental saves. Unlocks now: no frame hitches on large sessions. Unlocks later: incremental saves and cross-process session browsing.
- **Fix:** Drop pretty-print (null, 2). Write the legacy sidecars lazily (only when history views need them) or derive them from the envelope. Cache the on-disk envelope version in memory instead of re-reading. Use Bun.write/async fs, or schedule via queueMicrotask/idle. Add fsync on the temp fd before rename. Cost: small. Confidence: high.
- **Evidence:** run-state-storage.ts saveChatState: readEnvelopeVersion(chatStatePath) → JSON.parse(fs.readFileSync) then writeJsonAtomic(chatStatePath, envelope); writeJsonAtomic(getRunStatePath(), persistedRunState); writeJsonAtomic(getChatMessagesPath(), persistedMessages). writeJsonAtomic: `fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 })` then renameSync. saveCheckpoint: `JSON.stringify(checkpoint, null, 2)` with writeFileSync/renameSync.

## [MEDIUM] performance — cli/src/services/memory-v2/concept-index.ts:232 — Concept recall: brute-force JS cosine over JSON-text vectors, per-row prepare, DB reopened per query
- **Risk:** Mechanism: each recall opens a new bun:sqlite Database (openConceptDatabase: mkdir, migrate, DDL, 2 meta upserts, PRAGMA journal_mode, chmod). For each corpus entry it calls db.prepare(SELECT ...) inside the loop (statement re-prepare per row), JSON.parses a vector stored as TEXT, and computes cosine in JS over number[]. The design is correct (abort gates, poisoned-vector handling, LRU bound), but costs are O(corpus x dim) JS math plus JSON decode inside a 1.5s budget, and hit the timeout degradation as the corpus grows. It is in TS, which is fine at the current scale (DEFAULT_CONCEPT_MAX_RESULTS 8, the embed budget of 32). Best options by stage: (now) hoist prepare, store Float32Array BLOBs, and keep the handle open via the provider lease. (later) consume sqlite-vec, which needs Database.setCustomSQLite on macOS because the system SQLite forbids extensions, or move vector search into the indexer daemon that already owns embeddings (index-command.ts uses the same createConfiguredEmbedder).
- **Fix:** Hoist `db.prepare('SELECT vector ...')` out of the loop. Encode vectors as Float32Array BLOB. Hold one connection per project inside ProjectMemoryV2Provider. Later, unify with the @codebuff/indexer semantic store instead of a second vector cache. Cost: small now, medium to unify. Confidence: high.
- **Evidence:** concept-index.ts expandConceptRecallInner: `for (const entry of params.corpus) { ... const row = db.prepare('SELECT vector FROM concept_vectors WHERE embedding_hash = ? AND fingerprint = ?').get(...)`. Schema: `vector TEXT NOT NULL`. cosineSimilarity is a JS loop. expandConceptRecall calls openConceptDatabase(params.projectRoot) per call and db.close() in finally. DEFAULT_CONCEPT_TIMEOUT_MS = 1500.

## [MEDIUM] dependency-hygiene — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:472 — Memory V2 on bun:sqlite: macOS system SQLite exposure; pin a bundled SQLite before adopting FTS5/extensions
- **Risk:** Mechanism: new Database(path, {create, strict}) with WAL, synchronous NORMAL, busy_timeout, and quick_check health (lines 472-488, ~1363-1373). On macOS, bun:sqlite links the OS SQLite (per the parent's web-verified fact, with an FTS5 corruption bug) and cannot load extensions. Lexical search is implemented in JS (lexicalTokens/scanQueryRows/buildLexicalResult in the outline), likely partly for this reason, which means O(rows) scans instead of FTS5. The code also documents that no no-follow/descriptor-relative open exists (requireSecureOpen refused, line 466). TS plus bun:sqlite is fine. Best option: call Database.setCustomSQLite() with a bundled modern libsqlite3 on darwin at startup, then adopt FTS5 for lexical search and sqlite-vec for concept vectors. A Rust/Zig daemon is not warranted. Unlocks now: a consistent SQLite version across OSes. Unlocks later: FTS5 ranking and native vector search. Only lines 455-500 plus a grep of this 4811-line file were read, so the lexical-scan claim is based on symbol names.
- **Fix:** Add a darwin-only setCustomSQLite bootstrap before any Database construction (memory-v2 and concept-index), and record sqlite_version() in recordRuntimeCapabilities. Gate FTS5 adoption on it. Cost: small/medium (packaging a dylib). Confidence: medium, since the file was partially read.
- **Evidence:** bun-sqlite-memory-repository.ts:466-468 requireSecureOpen → insecureOpenUnavailableFailure ('no descriptor-relative/no-follow open exists for this driver'). :472 `database = new Database(preparedPath.databasePath, { create: true, strict: true })`. :481 PRAGMA synchronous = NORMAL, :484 PRAGMA journal_mode = WAL. The outline includes scanQueryRows, lexicalTokens, and buildLexicalResult. Grep found no FTS5 usage in the first 30 matches.

## [LOW] state-mutation — cli/src/services/memory-v2/provider.ts:138 — Memory V2 provider lease/refcount lifecycle: correct TS, keep
- **Risk:** Mechanism: a singleton provider with generation counter, pending-open dedupe, lease counts, retire-then-close-on-last-release, and reset-during-open detection. It handles concurrent opens and resets correctly. The concept recall expander is composed here but opens its own DB per call (see the concept-index finding), which wastes the lease model. TS is best, with no daemon needed until multiple processes share a store. WAL already allows multi-process readers.
- **Fix:** Keep. Pass a long-lived concept DB handle owned by the Resource into recallExpander so it shares lifecycle with the lease. Cost: small. Confidence: high.
- **Evidence:** provider.ts ProjectMemoryV2Provider: generation, current, pending. acquire() increments leaseCount; release closes if retired && leaseCount===0. defaultOpener sets `options.recallExpander = (params) => expandConceptRecall({ projectRoot, embed, ... })`.

## [LOW] dependency-hygiene — cli/src/services/memory-v2/usefulness-scorer.ts:1 — usefulness-scorer is a relative-path re-export into common/src
- **Risk:** The one-line re-export `export * from '../../../../common/src/util/usefulness-scorer'` bypasses the @codebuff/common package boundary (other files import '@codebuff/common/util/...'). That can break bundling/tsconfig path isolation and duplicate module instances. There is no language-fit issue.
- **Fix:** Import via '@codebuff/common/util/usefulness-scorer', or delete the shim and update importers. Cost: tiny. Confidence: high.
- **Evidence:** cli/src/services/memory-v2/usefulness-scorer.ts:1 `export * from '../../../../common/src/util/usefulness-scorer'`. Compare context.ts:1 `import { formatLedgerForCli } from '@codebuff/common/util/context-budget'`.

## [MEDIUM] correctness — cli/src/utils/open-file.ts:17 — open-file substitutes the raw unquoted path into shell:true editor commands
- **Risk:** Mechanism: it builds editor command strings and spawns them with shell: true. When $EDITOR contains %f or {file}, replaceFilePlaceholder inserts rawPath unquoted (line ~47 uses rawPath, not shellPath), so paths with spaces break, and paths containing shell metacharacters (repo-controlled filenames surfaced by validation-error-popover) execute. The non-placeholder branch quotes correctly. Each candidate waits for process 'close' sequentially even though detached GUI launchers return quickly. Best option: keep TS but use argv spawning (Bun.spawn([...])) after splitting EDITOR with a shell-words parser (git-command-args.ts already has one). Unlocks now: safe opening of arbitrary paths. Unlocks later: line/column jump support uniformly.
- **Fix:** Pass shellPath (quoted) into replaceFilePlaceholder, or better, tokenize the EDITOR value and spawn with an argv array without a shell. Cost: small. Confidence: high.
- **Evidence:** open-file.ts: `const rawPath = filePath` ... `const withFile = replaceFilePlaceholder(value, rawPath)`. replaceFilePlaceholder: `command.replace(/%f/g, filePath)`. runCommand: `spawn(command, { shell: true, stdio: 'ignore', detached: true })`.

## [LOW] state-mutation — cli/src/utils/recent-projects.ts:147 — recent-projects: non-atomic writes, existsSync per entry on every load
- **Risk:** writeFileSync directly to recent-projects.json (lines ~77, ~99, ~147) with no temp-plus-rename. Two concurrent CLI instances, or a crash mid-write, can truncate it, and it then silently loads as []. loadRecentProjects stats every path synchronously (max 10, cheap). TS is fine.
- **Fix:** Reuse the writeJsonAtomic pattern from run-state-storage.ts. Cost: tiny. Confidence: high.
- **Evidence:** recent-projects.ts saveRecentProject: `fs.writeFileSync(recentProjectsPath, JSON.stringify(updatedProjects, null, 2))`. removeRecentProject and clearRecentProjects use the same pattern. The load catch returns [].

## [LOW] dependency-hygiene — cli/src/commands/update-command.ts:38 — Hand-rolled semver comparator; consume Bun.semver.order
- **Risk:** compareUpdateVersions (lines 38-88, about 50 LOC) reimplements semver precedence including prerelease identifiers. Bun ships Bun.semver.order(a, b), which is native, tested, and matches the spec. The 'non-semver current is outdated' rule is product logic and should stay. The feature is otherwise correct, sync, and does no network. TS is fine.
- **Fix:** Replace the body with a regex guard plus `Bun.semver.order(current, pending)`, and keep the deps.compareVersions injection for tests. Cost: tiny. Confidence: high.
- **Evidence:** update-command.ts:38 `function compareUpdateVersions(current: string, pending: string): number {` ... its prerelease numeric/alpha comparisons at lines ~61-86.

## [LOW] correctness — cli/src/commands/git-command-args.ts:6 — Safe git arg parser: TS is right; keep, but it silently drops backslash escapes
- **Risk:** Mechanism: it rejects shell metacharacters including backslash via regex, runs a mini quote-aware tokenizer, then single-quotes each argument into a shell string. It is safe by construction. A library (shell-quote) is unnecessary. The limitation is that it rejects \ entirely, so Windows paths cannot be passed. Building a shell string at all (buildSafeGitCommand) would be unnecessary if the runner accepted argv.
- **Fix:** Keep. When the bash runner supports argv, return args[] and spawn git directly with no shell. Cost: small. Confidence: high.
- **Evidence:** git-command-args.ts:3 `const FORBIDDEN_SHELL_CHARACTERS = /[\n\r;$`|&<>\\]/`. :41 quoteShellArgument. :48 buildSafeGitCommand joins into a string.

## [LOW] performance — cli/src/utils/fuzzy-match.ts:9 — Greedy fuzzy matcher: TS fine, greedy first-match scoring is suboptimal
- **Risk:** Mechanism: greedy left-to-right subsequence match with a gap/consecutive/boundary score. It is shared by command registry, palette, prompt history, and suggestion engine. Being greedy, it picks the first occurrence, not the best alignment (for example 'cr' in 'core/router' matches c at 0 and r at 2, missing the boundary r), so ranking is sometimes off. It is O(n) per item, which is fine. It does not treat '-', '_', '.', or camelCase as boundaries. Best option: keep TS, or consume fzf-for-js/fuzzysort for optimal alignment if ranking complaints arise. There is no native or daemon need.
- **Fix:** Optionally add boundary chars [-_. ] and camelCase to boundaryBonus, or switch to fuzzysort. Cost: tiny. Confidence: high.
- **Evidence:** fuzzy-match.ts:26-43 inner while advances textIdx to the first equal char. :55-57 boundaryBonus only for idx===0 || text[idx-1]==='/'.

## [LOW] correctness — cli/src/commands/index-command.ts:84 — /index formats status twice (block + string) and blocks the UI up to 30s on rebuild
- **Risk:** buildIndexStatusContentBlock (lines 84-142) and formatIndexStatus (lines ~276-315) duplicate identical formatting, which already drifts: the string version appends '.' to Age and Vector lines and the block version does not. handleIndexCommandBlocks falls back to the string path for explain. Rebuild awaits waitUntilReady(30_000) inline, so the command appears hung. IndexManager runs in-process. A long-lived indexer daemon (shared across CLI sessions and the SDK query_index handler) would unlock shared warm indexes. TS formatting is fine.
- **Fix:** Derive formatIndexStatus from buildIndexStatusContentBlock(...).lines.join('\n'). Make rebuild return immediately with a 'refreshing' block and update via a status subscription. Consider the indexer as a daemon later. Cost: small. Confidence: high.
- **Evidence:** index-command.ts:94 `status.indexAge > 0 ? formatAge(status.indexAge) : 'not available'` (no '.'), whereas formatIndexStatus writes `Age: ${...}.`. Both rebuild paths call `await setup.manager.waitUntilReady(30_000)`.

## [LOW] correctness — cli/src/commands/router-utils.ts:61 — Slash-command parsing and simple commands (help/info/context/image/init/plan-timeline): TS fits; minor nits
- **Risk:** router-utils parse is pure TS and fine. image.ts:13 splits args on whitespace, so image paths containing spaces cannot be attached (quote-aware parsing from git-command-args could be reused). info.ts falls back to a hard-coded '1.0.0' version. init.ts uses link()-based exclusive create plus rollback, which is correct and good. plan-timeline delegates parsing to common and is fine. None needs OpenTUI native renderables beyond the markdown/table migration for their output boxes.
- **Fix:** Reuse parseSafeGitArgs-style quoting in handleImageCommand. Show 'unknown' instead of '1.0.0' when CODEBUFF_CLI_VERSION is unset. Cost: tiny. Confidence: high.
- **Evidence:** image.ts:13 `const [imagePath, ...rest] = args.trim().split(/\s+/)`. info.ts:20 `return getCliEnv().CODEBUFF_CLI_VERSION ?? '1.0.0'`. init.ts writeNewFileAtomically: writeFileSync(tmp, {flag:'wx'}) then linkSync(tmp, target).

## Coverage receipt

### Subsystems
- cli

### Features
- opentui-upgrade
- markdown-renderer
- syntax-highlighter
- text-layout-wrap
- diff-viewer
- markdown-tables
- chat-scroll
- batched-message-updater
- stream-chunk-routing
- message-queue
- chat-state-persistence
- turn-checkpoint
- concept-recall
- memory-v2-provider
- memory-v2-sqlite-open
- recent-projects
- open-file
- git-command-args
- update-version-compare
- fuzzy-match
- index-command
- slash-command-parse
- init-command
- plan-timeline
- info-context-help-image-commands

### Files
- cli/src/utils/syntax-highlighter.tsx
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/text-layout.ts
- cli/src/components/tools/diff-viewer.tsx
- cli/src/components/blocks/content-with-markdown.tsx
- cli/src/hooks/use-scroll-management.ts
- cli/src/hooks/use-message-queue.ts
- cli/src/utils/message-updater.ts
- cli/src/utils/stream-chunk-processor.ts
- cli/src/utils/run-state-storage.ts
- cli/src/utils/recent-projects.ts
- cli/src/utils/open-file.ts
- cli/src/utils/fuzzy-match.ts
- cli/src/services/memory-v2/concept-index.ts
- cli/src/services/memory-v2/provider.ts
- cli/src/services/memory-v2/usefulness-scorer.ts
- cli/src/services/memory-v2/index.ts
- cli/src/commands/git-command-args.ts
- cli/src/commands/router-utils.ts
- cli/src/commands/image.ts
- cli/src/commands/help.ts
- cli/src/commands/info.ts
- cli/src/commands/context.ts
- cli/src/commands/update-command.ts
- cli/src/commands/init.ts
- cli/src/commands/index-command.ts
- cli/src/commands/plan-timeline.ts

### Domains
- performance
- correctness
- state-mutation
- dependency-hygiene
