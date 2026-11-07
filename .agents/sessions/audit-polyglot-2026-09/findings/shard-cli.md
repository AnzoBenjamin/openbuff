# Audit findings: shard-cli

- Subsystems: cli
- Features: cli-bootstrap-startup, chat-streaming-render, markdown-rendering, syntax-highlighting, text-layout-wrapping, terminal-image-protocols, ripgrep-search-vendoring, tree-sitter-wasm-embedding, single-binary-distribution, bun-compat-polyfill, memory-v2-sqlite-store, fuzzy-suggestion-engine
- Files covered: 12
- Snapshot: 3ce1fa2b4613303fb428bab8463887ba85bd13958dfd9df8c276dee8231f053a

## [MEDIUM] performance — cli/src/utils/markdown-renderer.tsx:1085 — Streaming markdown is fully re-parsed and re-wrapped per chunk on the JS main thread
- **Risk:** On long agent responses every streamed chunk re-tokenizes and re-wraps the whole markdown buffer on the JS main thread, competing with OpenTUI render and input handling; users see frame drops and laggy streaming on large code-fence-heavy replies.
- **Fix:** Move markdown parse + style-attributed line layout into a Rust (pulldown-cmark + custom renderer) native addon or WASM module emitting plain styled-span data; keep the thin ReactNode wrapper in TS. Cache incremental parse state per message id so streaming appends instead of re-parsing.
- **Evidence:** markdown-renderer.tsx: `const processor = unified().use(remarkParse)...` is invoked per renderMarkdown call; renderStreamingMarkdown (exported, called from components/blocks/content-with-markdown.tsx and message-with-agents.tsx during streaming) calls renderMarkdown on the complete section of the accumulated buffer on every streaming update; wrapInlineNodes/appendWrappedInlineSegment call stringWidth per token and per character for oversized tokens.

## [MEDIUM] test-coverage — cli/src/utils/syntax-highlighter.tsx:9 — Syntax highlighting is a deliberate stub — a language-blocked feature, not just missing polish
- **Risk:** Code blocks in agent responses render as unstyled monochrome text — a user-visible feature gap that exists purely because token-level highlighting is expensive/awkward in TS; a native highlighter makes real highlighting cheap enough to run during streaming.
- **Fix:** Rust (tree-sitter crates + syntect or a custom theme pipeline) compiled as a native addon/WASM returning (byte-range, style) spans; TS side maps spans to OpenTUI <span> elements. Reuses the already-shipped grammar set.
- **Evidence:** highlightCode body: `// For now, just return the code with basic styling // Can be enhanced later with actual syntax highlighting; return <span fg={fg}>{code}</span>`. The codebase already ships tree-sitter grammars as WASM (LANGUAGE_WASM_FILES in build-binary.ts) for code-map, but the renderer does not use them for display.

## [MEDIUM] state-mutation — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:2670 — Memory-v2 query folds the entire event log in JavaScript; FTS5 probed but semantic search unsupported
- **Risk:** Memory recall latency grows linearly with store size and blocks the JS event loop during queries; semantic search (the natural user-facing feature for a memory system) is architecturally blocked because bun:sqlite JS-side folding cannot support embeddings or FTS-backed ranking at acceptable cost.
- **Fix:** Rust memory kernel via rusqlite: push the fold into SQL (FTS5 for lexical, generated-column indexes for projectId/selector), and add sqlite-vec + a small local embedding model for real semantic recall — turning the currently-unsupported search() into a shipped feature.
- **Evidence:** query(): scanQueryRows reads up to MAX_QUERY_EVENTS=10,000 events / MAX_QUERY_PAYLOAD_BYTES=8MB into JS, JSON.parse per row, then buildLexicalResult folds the entire envelope list in JS (task/observation/evidence/freshness maps) on every retrieval. recordRuntimeCapabilities probes FTS5 but search() returns `unsupported('semantic-search')` and compact() is unsupported; recallExpander is advisory-only (max 8 appended results).

## [LOW] security — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:318 — bun:sqlite cannot do a descriptor-relative/no-follow open — secure-open mode is permanently refused
- **Risk:** The hardened-open feature (TOCTOU-proof memory store) cannot ship on bun:sqlite; symlink/fd-swap races between validation and open remain structurally unfixable in the current driver.
- **Fix:** A Rust kernel using rusqlite with a custom VFS (or SQLITE_OPEN via already-held file descriptor) can open exactly the validated descriptor, converting the fail-closed requireSecureOpen branch into a real supported hardened-open mode.
- **Evidence:** open() comments: bun:sqlite 'opens the main database plus its -wal/-shm sidecars by derived pathname inside its own VFS. The pathname hardening in this module is therefore best-effort defense-in-depth: it cannot prove that the files SQLite opened are the files that were validated beforehand.' requireSecureOpen=true refuses every open with kind 'unsupported-open'. The code compensates with preflight + post-open realpath/dev/ino re-verification (verifyOpenedDatabasePath, fileIdentity).

## [LOW] performance — cli/src/utils/terminal-images.ts:155 — Sixel image protocol unimplemented because image decode/resize needs native codecs
- **Risk:** Users on sixel-capable terminals and anyone pasting large screenshots get no image preview (or unscaled iTerm2/kitty output); image decode/resize is a native-codec problem TS/Bun has no good answer for.
- **Fix:** Rust native addon with the `image` crate (decode PNG/JPEG, resize to cell grid, emit sixel or kitty RGBA payload). Unlocks sixel terminals (xterm, wezterm, mlterm) and correctly-sized inline previews as new features.
- **Evidence:** Sixel branch: `case 'sixel': // Sixel is more complex and requires actual image decoding // For now, return null and fall back to metadata display; return null`. iTerm2/kitty paths only base64-encode raw bytes; no width/height computation from image dimensions, no downscaling to terminal cell size.

## [MEDIUM] performance — cli/src/native/ripgrep.ts:20 — ripgrep is vendored as an external binary that must be extracted to disk and chmod'd at runtime
- **Risk:** Search fails on read-only install dirs (cannot write rg next to the binary), adds cold-start latency for the first search (extraction + chmod), and multiplies release-matrix surface (5 vendored rg builds + a 6th legacy one).
- **Fix:** Link libripgrep (grep-searcher/ignore crates) into a Rust addon statically: no sibling extraction, no exec-bit dance, no legacy-macOS special build, and streaming search results over NAPI instead of process spawn per query.
- **Evidence:** getRipgrepPath maintains per-platform require() paths for 5 vendored binaries, extracts to dirname(process.execPath) at first use, chmod +x via spawnSync, and throws for a legacy-macos sibling missing; build-binary.ts separately copies LEGACY_RIPGREP_BIN. Consumed via codebuff-client.ts spawning the rg process.

## [MEDIUM] api-contract — cli/src/pre-init/tree-sitter-wasm.ts:1 — tree-sitter WASM and all grammar WASMs must ship as sibling files with a hand-rolled integrity manifest
- **Risk:** A missing or corrupted sibling .wasm silently degrades parsing; distribution requires a multi-file tarball with integrity manifest, and Windows bunfs paths require argv[0]/execPath fallback hacks that already needed multiple repair rounds.
- **Fix:** Rust addon statically linking tree-sitter and grammars: no wasm siblings, no locateFile, no manifest, no bunfs path workarounds; the entire smoke-gate diagnostic machinery can be retired or reduced to a single version probe.
- **Evidence:** pre-init tree-sitter-wasm.ts documents: 'Final approach after several attempts to embed the wasm into the bun --compile binary all failed on Windows (the bytes ended up in the binary, but every JS-level retrieval mechanism ... was either tree-shaken, transformed by the minifier, or otherwise stripped)'. index.tsx carries a ~150-line --smoke-tree-sitter diagnostic block plus WASM_MAX_BYTES cap and TOCTOU re-check; build-binary.ts ships tree-sitter-manifest.json with sha256 per grammar.

## [MEDIUM] api-contract — cli/scripts/build-binary.ts:60 — Single-binary distribution rests on fragile Bun --compile + runtime node_modules patching
- **Risk:** Every new platform/arch needs a matching OpenTUI native bundle plus Bun target; Bun version upgrades break the polyfill chain; startup failure modes on legacy platforms consume ongoing engineering (multiple smoke gates exist purely to catch this).
- **Fix:** Keep the OpenTUI/React UI in TS (rewrite cost too high — see chat.tsx coupling) but treat OpenTUI as the one pinned native boundary; alternatively evaluate a Rust TUI core (ratatui) only for a future headless/serve mode, not the interactive REPL.
- **Evidence:** build-binary.ts patches @opentui/core bundles in node_modules (patchOpenTuiAssetPaths, patchOpenTuiCoreNativeLoaderForLegacy, restoreOpenTuiCoreNativeLoader), fetches @opentui/core-<platform>-<arch> tarballs with tar at build time, and index.tsx runs --smoke-opentui with `useThread: process.platform !== 'linux'` to probe the native FFI boundary because full-screen rendering 'is not deterministic when stdout is a pipe (notably on legacy Intel macOS)'.

## [LOW] dependency-hygiene — cli/src/polyfills/bun-strip-ansi.ts:5 — Bun version churn already forces a compat polyfill; binary story is pinned to two Bun generations
- **Risk:** Bun runtime churn (removed built-ins, compiler flag changes) is a recurring distribution and correctness risk; each Bun upgrade can silently break the binary build or runtime behavior across the 5-target release matrix.
- **Fix:** A Rust/Go core isolates runtime churn to a compiled artifact; the TS surface shrinks to the UI layer whose Bun dependency is version-pinned and narrow. Alternatively, replace the Bun-only API usage in hot paths with portable code so the polyfill layer disappears.
- **Evidence:** polyfills/bun-strip-ansi.ts: 'Bun 1.2 removed Bun.stripANSI; provide a fallback for libraries that still call it' — monkey-patches globalThis.Bun.stripANSI with a TS implementation. Combined with the legacy-macOS lane pinned to Bun 1.0 compiler flags (`--conditions=production` path) and the non-legacy lane requiring modern --production/--target flags, the CLI is simultaneously coupled to two Bun generations.

## [MEDIUM] performance — cli/src/index.tsx:340 — Serial startup awaits before the TUI renders; cold start carries JS runtime boot plus OSC probe
- **Risk:** Cold-start time to first paint is the single most user-visible latency metric for a CLI; the serial awaits and React/OpenTUI boot cost make sub-100ms cold start impossible, and Windows non-TTY hangs required a timer workaround.
- **Fix:** Rust/Go bootstrap (terminal probe, registries, index peek) with the TS UI attaching to an already-warm runtime; native-side periodic pollers push updates over a channel instead of UI-thread setInterval.
- **Evidence:** index.tsx awaits detectTerminalTheme() on stdin before parseCliArgs, then initializeApp, agent+skill registries, then createCliRenderer; the smoke-bootscreen path reserves a 1500ms grace timer because 'renderer/app init may hang on Windows pipes'. chat.tsx polls getDiffStats every 10s and peekIndexStatus every 2s from the UI thread.

## [LOW] performance — cli/src/utils/text-layout.ts:44 — Text layout measures width per character in JS on the hot input path
- **Risk:** Wide-character/multibyte content makes per-keystroke layout measurably janky; a shared native measurement kernel would also fix drift between the 3 separate wrap implementations (text-layout, markdown-renderer wrapText, appendWrappedInlineSegment).
- **Fix:** Rust unicode-width + SIMD-accelerated wrap kernel returning pre-computed visual lines; keep the TS function signatures. Also unlocks grapheme-cluster-correct wrapping (emoji/ZWJ sequences) that string-width handles inconsistently.
- **Evidence:** appendWrappedLine/appendSegment call Array.from(segment) and stringWidth(ch) per character; measureLines does the same per keystroke via computeInputLayoutMetrics (called from chat.tsx in a useMemo on every inputValue/cursorPosition change). wrapTextToVisualLines is consumed by 9 component files including diff-viewer and message blocks.

## [LOW] api-contract — cli/src/utils/markdown-renderer.tsx:1150 — Renderer layer is hard-coupled to OpenTUI React — the rewrite boundary must stay TS
- **Risk:** The UI layer is the highest-coupling, lowest-test-coverage-ratio zone for a migration; a big-bang rewrite is infeasible, so any migration must be incremental at process/protocol boundaries, which the current ReactNode-typed renderer boundary does not support.
- **Fix:** Define a styled-span/line protocol (plain data) at the markdown/highlight/layout boundary now — it makes those three layers portable to Rust without touching the React component tree, and is the prerequisite for any future native render core.
- **Evidence:** renderMarkdown returns ReactNode built from OpenTUI <span> elements directly; chat.tsx (1871 lines) wires ~40 keyboard/UI handlers into useChatKeyboard and zustand stores; app.tsx composes screens via OpenTUI components. Any native replacement of chat rendering would have to reproduce this handler surface.

## [LOW] test-coverage — cli/src/hooks/use-suggestion-engine.ts:1 — File/mention suggestion matching runs in JS over the whole project file tree
- **Risk:** On large monorepos the file suggestion loop is O(files × query) in JS on the keystroke path, forcing throttling; a native fuzzy engine would make instant-as-you-type fuzzy search over the whole repo viable as a feature.
- **Fix:** Rust fuzzy-matching kernel (nucleo or the fzf algorithm) exposed as a native addon: instant ranking over 100k+ files, enabling fzf-quality file/agent/command search, subsequence scoring with tie-breaking, and multi-select paste as new user-facing features.
- **Evidence:** useSuggestionEngine feeds the full FileTreeNode[] from getProjectFileTree into JS filtering on every input change; fileMatches drive agent/file mention completion (chat.tsx handlers onMentionMenuSelect/onMentionMenuComplete slice and splice inputValue around the mention).

## [LOW] test-coverage — cli/src/chat.tsx:320 — Diff surfaces are limited to git plumbing calls; no in-TUI rich diff engine
- **Risk:** Users reviewing agent edits get coarse line-level diffs with no intra-line emphasis, and diff computation on large changed file sets competes with the UI thread.
- **Fix:** Rust diff kernel (imara-diff/similar with Myers+patience+histogram) as a native addon: word-level intra-line highlights in the TUI diff viewer, instant /diff review screens, and conflict-resolution UI — features competitors get from native diffs (e.g., Zed, gitui).
- **Evidence:** chat.tsx imports getDiffStats from ./utils/git and polls it every 10s and after streaming ends; diff rendering in components/tools/diff-viewer.tsx relies on wrapTextToVisualLines with no word-level highlighting; the StatusBar shows only aggregate diffStats (additions/deletions).

## [LOW] performance — cli/src/pre-init/tree-sitter-wasm.ts:1 — Tree-sitter grammars already ship in the bundle — a native highlighter/indexer could reuse them directly
- **Risk:** Duplicated parsing stacks: the CLI pays for shipping grammars twice conceptually (parse for code-map, nothing for display); incremental tree-sitter parsing in a native addon is the standard solution (Zed, helix) and TS-only options cannot keep up with streaming.
- **Fix:** Rust addon that loads the same grammar set (native tree-sitter crates, or the shipped WASM via wasmtime) and exposes incremental highlight queries; incremental parsing makes highlighting during streaming affordable, which re-parsing-per-chunk TS cannot do.
- **Evidence:** The tree-sitter grammars are already shipped alongside the binary (build-binary.ts copies LANGUAGE_WASM_FILES with sha256 manifest) and are initialized for code-map parsing, but the highlighter stub ignores them; a native path could reuse the same grammars for streaming-safe highlighting.

## Coverage receipt

### Subsystems
- cli

### Features
- cli-bootstrap-startup
- chat-streaming-render
- markdown-rendering
- syntax-highlighting
- text-layout-wrapping
- terminal-image-protocols
- ripgrep-search-vendoring
- tree-sitter-wasm-embedding
- single-binary-distribution
- bun-compat-polyfill
- memory-v2-sqlite-store
- fuzzy-suggestion-engine

### Files
- cli/src/index.tsx
- cli/src/app.tsx
- cli/src/chat.tsx
- cli/src/utils/syntax-highlighter.tsx
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/text-layout.ts
- cli/src/utils/terminal-images.ts
- cli/src/native/ripgrep.ts
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- cli/scripts/build-binary.ts
- cli/src/pre-init/tree-sitter-wasm.ts
- cli/src/polyfills/bun-strip-ansi.ts

### Domains
- performance
- state-mutation
- test-coverage
- api-contract
