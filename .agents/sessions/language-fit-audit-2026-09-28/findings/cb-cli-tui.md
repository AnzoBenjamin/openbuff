# Audit findings: cb-cli-tui

- Subsystems: cli
- Features: tui-rendering-core, markdown-parse-render, syntax-highlight, wrap-grapheme-width, diff-view, terminal-images, clipboard, input-editing, virtualization-scroll, stream-chunk-processing, binary-packaging, tui-rewrite-question, terminal-dimensions
- Files covered: 24
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [LOW] performance — cli/src/index.tsx:436 — TUI rendering core (OpenTUI Zig + React reconciler): KEEP
- **Risk:** None material. Cell diffing, ANSI emission, and Yoga layout already run in the native libopentui (Zig). React only builds the renderable tree. A Rust napi layer would duplicate that work.
- **Fix:** Keep it. Treat OpenTUI's native renderables as the escape hatch for hot paths instead of adding new native modules. Unlocks now: nothing new. Later: move hot widgets (markdown/code/diff/textarea) onto OpenTUI-native renderables (see the other findings).
- **Evidence:** index.tsx:436 createCliRenderer({screenMode:'alternate-screen'}); index.tsx:103 --smoke-opentui probes the FFI boundary. node_modules/@opentui/core-linux-x64 ships libopentui.so; core 0.2.2 is pinned in cli/package.json. Cost: 0. Confidence: high.

## [MEDIUM] performance — cli/src/utils/markdown-renderer.tsx:1225 — Markdown parse/render: KEEP-TS, FIX ALGORITHM (incremental or OpenTUI-native markdown)
- **Risk:** Every streaming chunk re-parses the whole message with unified/remark (renderStreamingMarkdown -> renderMarkdown -> processor.parse), then runs applyInlineFallbackFormatting and rebuilds a ReactNode per word or per character in wrapInlineNodes. Total work grows O(n^2) over a message's lifetime, and GC pressure on long replies competes with the render loop. The problem is the algorithm, not the language: comrak or pulldown-cmark via napi would still re-parse everything and would add a per-platform .node artifact to the bun --compile binary.
- **Fix:** Now: memoize completed top-level blocks by source offset and re-parse only the trailing open block, the same way the incomplete-fence split already works. Swap remark for marked, which OpenTUI already depends on and is roughly 5-10x faster than remark (needs verification). Later: adopt OpenTUI's native markdown/code renderable if 0.2.x exposes one, so wrap and styling happen in Zig. Rust napi: reject.
- **Evidence:** markdown-renderer.tsx:114 unified().use(remarkParse).use(remarkGfm).use(remarkBreaks); :1225-1239 renderMarkdown full parse; :1250-1269 renderStreamingMarkdown re-parses the complete section on every call; :225-313 per-token/char ReactNode wrapping. content-with-markdown.tsx:30-34 calls it on each content change. node_modules/@opentui/core/package.json:50 lists marked 17.0.1. Cost: S-M (incremental block cache, about 2-3 days). Confidence: medium-high. Needs verification: whether OpenTUI 0.2.2 exports a MarkdownRenderable (its dist was not searchable here), and the marked-vs-remark speed ratio.

## [MEDIUM] correctness — cli/src/utils/syntax-highlighter.tsx:9 — Syntax highlighting: ADOPT OpenTUI tree-sitter highlighting (reuse shipped grammars); reject shiki/syntect
- **Risk:** No real highlighting exists. highlightCode is a stub that returns a single <span>, and renderCodeBlock paints every code line in one codeTextFg colour. Users get monochrome code in an AI coding tool. Adding shiki would bring roughly 10MB of Oniguruma WASM plus grammars into the binary. syntect or tree-sitter-highlight via napi would add a native artifact per target.
- **Fix:** Now: highlight through web-tree-sitter highlight queries. The binary already ships tree-sitter.wasm and LANGUAGE_WASM_FILES grammars next to the executable, and OpenTUI core depends on web-tree-sitter 0.25.10, which suggests it has a tree-sitter client and code renderable. Highlight only completed fences and cache by content hash. Later: run highlighting in a Worker so parsing stays off the render thread. Verdict: TS orchestration over the existing WASM tree-sitter. No new language.
- **Evidence:** syntax-highlighter.tsx:9-19 stub ('Can be enhanced later'); markdown-renderer.tsx:604-645 renderCodeBlock uses a single fg. build-binary.ts:256-278 copies tree-sitter.wasm and grammar wasm with a sha256 manifest. node_modules/@opentui/core/package.json:61 web-tree-sitter 0.25.10. Cost: M (about 1 week, including highlight queries per language). Confidence: medium. Needs verification: OpenTUI's CodeRenderable/TreeSitterClient API surface in 0.2.2, and whether code-map's grammar set includes highlights.scm queries.

## [MEDIUM] correctness — cli/src/utils/text-layout.ts:60 — Wrap / grapheme width: DELEGATE to OpenTUI native text buffer (Zig); drop JS pre-wrap
- **Risk:** There are two width models. The CLI pre-wraps text in JS with string-width and splits by code point (Array.from / for-of), not by grapheme cluster. OpenTUI then lays the result out again with its own native width tables. ZWJ emoji, flags, and combining marks can therefore break mid-cluster or be measured differently from the native renderer, which causes misaligned tables, cursor drift, and ragged lines. It is also per-character JS work on every render for every message (wrapTextPreservingNewlines is called from about 10 components).
- **Fix:** Now: where a <text> box can wrap natively (wrapMode:'word' is already used in app.tsx), stop pre-wrapping. Keep JS measurement only where row counts must be known up front (input height, tables), and switch those to Intl.Segmenter grapheme iteration. Later: use OpenTUI's text-buffer measurement API, if exposed, so one width table exists. Rust unicode-width via napi: reject, since it still leaves two models.
- **Evidence:** text-layout.ts:4-58 measureLines and :60-107 wrapTextToVisualLines use string-width with Array.from(segment) code-point splitting. markdown-renderer.tsx:281 `for (const char of token)`; :820-866 table wrapText. app.tsx:186 native wrapMode:'word'. chat.tsx:1596-1611 computeInputLayoutMetrics per keystroke. Cost: M. Confidence: medium. Needs verification: whether OpenTUI's Zig width tables match string-width 7 for emoji/CJK, and whether a measurement API is public.

## [LOW] performance — cli/src/components/tools/diff-viewer.tsx:157 — Diff view: KEEP-TS (optionally adopt OpenTUI diff renderable later)
- **Risk:** Low. Unified-diff parsing is linear string work, and the view is already bounded (DIFF_INITIAL_MAX_LINES=80, DIFF_MAX_RENDER_NODES=400, collapsible hunks). There is no intra-line (word) diff and no syntax colouring of diff bodies.
- **Fix:** Keep the TS parser. Later: add word-level highlights with the `diff` package (OpenTUI already depends on diff 9.0.0) and tree-sitter colouring from the syntax-highlight finding, or use OpenTUI's native diff renderable if exported. Native: reject.
- **Evidence:** diff-viewer.tsx:59-61 render caps; :157-263 parseDiffIntoHunks; :274-310 side-by-side pairing; :6 reuses JS wrapTextToVisualLines, which inherits the width-model issue. node_modules/@opentui/core/package.json:49 diff 9.0.0. Cost: S. Confidence: high (parser), low (existence of an OpenTUI DiffRenderable).

## [MEDIUM] correctness — cli/src/utils/terminal-images.ts:114 — Terminal images: KEEP-TS protocols, route through renderer; replace Jimp decode later
- **Risk:** Inline images are raw iTerm2/Kitty escape strings produced outside OpenTUI's cell buffer, so the diff renderer does not know those cells are occupied. That causes overdraw or ghosting on scroll or re-render. Kitty is sent with f=100 (PNG only) and no placement id, so the image is re-transmitted on every render. Sixel returns null, and detection uses env vars only (no XTGETTCAP/Kitty query), which misses WezTerm, Ghostty, and tmux passthrough. Thumbnails decode with Jimp, which is pure JS and runs on the UI thread, so large screenshots stall the render.
- **Fix:** Now: transmit Kitty images once with i=<id> and then place them with a=p. Detect support with an active query (Kitty `a=q` / DA1) during the existing pre-OpenTUI OSC phase. Emit through a renderer post-process hook, if available, so cells are reserved. Move Jimp to a Worker. Later: use a native decoder (Bun image APIs or a napi decoder) only if profiling shows decode cost matters. Sixel encoding is pure CPU and could be a small Zig/Rust module, but it is low priority. Unlock: proper inline screenshots in Kitty, Ghostty, and WezTerm.
- **Evidence:** terminal-images.ts:17-44 env-only detection; :114-162 Kitty a=T,f=100 without persistent id; :195-198 sixel null. image-thumbnail.ts:29-76 Jimp.read plus per-pixel getPixelColor loop. index.tsx:307-318 OSC detection runs before OpenTUI (reusable for image capability queries). Cost: M. Confidence: medium. Needs verification: whether OpenTUI 0.2.2 has any graphics-protocol hook or cell-reservation API.

## [MEDIUM] performance — cli/src/utils/clipboard-image.ts:104 — Clipboard: KEEP-TS shell-out but make async; consider Rust arboard napi LATER
- **Risk:** Clipboard access is synchronous and blocks the render/input loop. Text copy uses execSync(pbcopy/xclip/xsel/clip), and image paste uses spawnSync(osascript/pngpaste, timeout 5000ms) inside a setTimeout(0) on the UI thread, so the TUI can freeze for up to 5s. It also depends on external tools (pngpaste, xclip/xsel, and nothing for Wayland wl-copy), so it silently fails on stock Linux Wayland.
- **Fix:** Now: switch to async Bun.spawn with timeouts, and add wl-copy/wl-paste to the probe chain. Keep OSC52 through the renderer for SSH. Later: add arboard (Rust) via napi-rs to get in-process text and image clipboard on all three OSes with no external tools. It is worth it only once single-binary distribution makes the missing-tool reports common, because it adds one .node file per target to package.
- **Evidence:** clipboard.ts:162-189 tryCopyViaPlatformTool execSync; :206-243 OSC52 with tmux/screen wrapping (good). clipboard-image.ts:74-99 spawnSync osascript; :104-140 pngpaste/osascript with 5000ms timeout. chat.tsx:1420-1440 onPasteImage calls readClipboardImage synchronously in setTimeout. Cost: S (async) / M (arboard napi and packaging). Confidence: high. Needs verification: arboard Wayland image support maturity.

## [MEDIUM] correctness — cli/src/components/multiline-input.tsx:199 — Input editing: MIGRATE to OpenTUI native textarea/EditBuffer (verify availability); otherwise KEEP-TS with grapheme fixes
- **Risk:** A 1255-line hand-rolled editor keeps its state in React/zustand and re-renders the whole input on every keystroke. Word boundaries and cursor moves use UTF-16 indices (text[pos], /\s/), so an emoji or surrogate pair can be split by backspace or word-jump. Tab expansion is a fixed 4 columns and ignores wide characters (renderPositionToOriginal). Undo/redo, selection, and IME composition are all DIY.
- **Fix:** Now: confirm whether OpenTUI 0.2.2 exports a native Textarea/EditBuffer renderable (Zig-side rope with grapheme-aware cursor). If it does, migrate MultilineInput onto it and keep the chat-specific key handling (mentions, history, paste routing) in TS. If it does not, move cursor arithmetic to Intl.Segmenter graphemes. Language: no new language, since the native part should be OpenTUI's. Unlocks: correct CJK/emoji editing and cheaper keystrokes on large pasted prompts.
- **Evidence:** multiline-input.tsx:44-90 UTF-16 boundary helpers; :93-94 CONTROL_CHAR_REGEX/TAB_WIDTH=4; :135-149 renderPositionToOriginal; :199-1255 component body. word-wrap-utils.ts:1-54 cursor up/down over lineStarts. chat.tsx:1596-1611 layout metrics per keystroke. Cost: M-L (1-2 weeks including tests). Confidence: medium. Needs verification: OpenTUI TextareaRenderable/EditBuffer existence and API in 0.2.2.

## [MEDIUM] performance — cli/src/hooks/use-chat-messages.ts:17 — Virtualization / large-session scroll: KEEP-TS, ADD WINDOWING (viewport culling)
- **Risk:** No virtualization exists. The last 15 top-level messages, plus every nested agent/tool subtree, are mounted in one scrollbox. 'Load previous' only grows the mounted set. A long agentic session with many subagents and diffs mounts thousands of renderables, and each stream flush re-runs layout for all of them. Scroll animation runs in JS setTimeout at 16ms and sets scrollTop each frame, which also triggers React state updates.
- **Fix:** Now: turn on the scrollbox's viewport culling if OpenTUI exposes it (needs verification). Otherwise render off-screen messages as fixed-height placeholders using measured heights cached per message id and width. Collapse or freeze completed messages into memoized static nodes. Later: let OpenTUI do native smooth scroll instead of JS tweening. Language: TS. The bottleneck is the mounted-tree size, not the JS speed.
- **Evidence:** use-chat-messages.ts:17 MESSAGE_BATCH_SIZE=15; :204-206 load-more only increases the count; :234-243 slice. chat.tsx:1823-1840 maps every visible message into <scrollbox stickyScroll>. use-scroll-management.ts:49-85 setTimeout tween at 16ms; :125-156 re-subscribes the listener every render (effect has no deps). Cost: M. Confidence: medium-high. Needs verification: OpenTUI ScrollBox viewportCulling option in 0.2.2.

## [LOW] performance — cli/src/utils/stream-chunk-processor.ts:43 — Stream chunk processing: KEEP-TS
- **Risk:** Low. Chunks are appended immutably into the block tree, which is cheap compared with the downstream markdown re-parse (the markdown finding). message-updater already batches flushes.
- **Fix:** Keep it. Optimize the markdown consumer rather than this layer.
- **Evidence:** stream-chunk-processor.ts:43-65 processTextChunk delegates to appendTextToAgentBlock/appendTextToRootStream. Cost: 0. Confidence: high.

## [MEDIUM] dependency-hygiene — cli/scripts/build-binary.ts:549 — Binary packaging (bun --compile + sidecar wasm/dylib): KEEP Bun; harden native-bundle fetch and legacy patching
- **Risk:** Single-binary distribution already works, but the build fetches @opentui/core-<platform> tarballs from the registry at build time and extracts them without checking dist.integrity or shasum. The legacy macOS lane rewrites OpenTUI's bundled source with a regex (open-tui-legacy-patch.ts), which breaks silently on any upstream loader change (it does throw if the match count is not 1). tree-sitter.wasm and grammars ship as sibling files, so the artifact is 'one binary plus N files'. Rewriting in Go or Rust would not remove the WASM grammars, the native renderer, or the Bun runtime the SDK depends on.
- **Fix:** Now: check the fetched tarball against metadata.versions[v].dist.integrity (SRI sha512) before extracting, or install the platform package with a lockfile. Pin exact OpenTUI versions (already done: 0.2.2) and keep the legacy-patch unit test. Later: retry embedding the WASM when Bun's --compile asset embedding is fixed on Windows, so the artifact becomes one file. No language change.
- **Evidence:** build-binary.ts:496-630 ensureOpenTuiNativeBundle: fetch metadata (:549) and tarball (:573), then tar -xzf (:608-619) with no integrity check. :167-174 patch/restore loader; :242-246 legacy dylib and rg copies; :248-278 sibling wasm and sha256 manifest. open-tui-legacy-patch.ts:1-35 regex rewrite of bundled source. Cost: S. Confidence: high.

## [LOW] performance — cli/src/chat.tsx:1 — TUI rewrite (Ratatui / Bubble Tea): REJECT
- **Risk:** A rewrite would throw away about 200 React components, zustand stores, tests, and the tight in-process link to the TS SDK/agent runtime. It would also need an IPC boundary for streaming events. OpenTUI already gives native (Zig) rendering, so a Ratatui rewrite would mostly improve the React/JS layer, not the terminal I/O. The real hot spots (markdown re-parse, pre-wrap, unvirtualized tree, sync clipboard) are algorithmic and can be fixed in TS or by moving onto existing OpenTUI-native renderables.
- **Fix:** Stay on React + OpenTUI. Reconsider only if the agent runtime itself moves out of the TS process (for example a Rust core over ACP, which `openbuff serve` already hints at in index.tsx:390-393). In that case a thin Ratatui client over ACP becomes viable. Unlocks available without a rewrite: native notifications via OSC 9 / OSC 777 / Kitty OSC 99 written from TS (a few lines, no native code), plus single-binary, image protocols, and large-session performance via the other findings.
- **Evidence:** chat.tsx:1-1894 deep coupling to hooks and stores; index.tsx:390-393 ACP serve path exists; libopentui.so native renderer present. Cost of rewrite: XL (months). Confidence: high. Needs verification: OSC 99/777 support matrix across terminals.

## [LOW] correctness — cli/src/hooks/use-terminal-dimensions.ts:7 — Terminal dimensions: KEEP-TS
- **Risk:** None. Thin sanitization over OpenTUI's resize-aware hook.
- **Fix:** Keep it.
- **Evidence:** use-terminal-dimensions.ts:7-50 wraps useOpenTuiDimensions with 80x24 fallbacks. Cost: 0. Confidence: high.

## Coverage receipt

### Subsystems
- cli

### Features
- tui-rendering-core
- markdown-parse-render
- syntax-highlight
- wrap-grapheme-width
- diff-view
- terminal-images
- clipboard
- input-editing
- virtualization-scroll
- stream-chunk-processing
- binary-packaging
- tui-rewrite-question
- terminal-dimensions

### Files
- cli/src/index.tsx
- cli/src/app.tsx
- cli/src/chat.tsx
- cli/package.json
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/syntax-highlighter.tsx
- cli/src/utils/text-layout.ts
- cli/src/utils/word-wrap-utils.ts
- cli/src/utils/terminal-images.ts
- cli/src/utils/image-display.ts
- cli/src/utils/image-thumbnail.ts
- cli/src/utils/clipboard.ts
- cli/src/utils/clipboard-image.ts
- cli/src/utils/stream-chunk-processor.ts
- cli/src/components/tools/diff-viewer.tsx
- cli/src/components/multiline-input.tsx
- cli/src/components/blocks/content-with-markdown.tsx
- cli/src/hooks/use-scroll-management.ts
- cli/src/hooks/use-terminal-dimensions.ts
- cli/src/hooks/use-chat-messages.ts
- cli/scripts/build-binary.ts
- cli/scripts/open-tui-legacy-patch.ts
- node_modules/@opentui/core/package.json
- node_modules/@opentui/core-linux-x64

### Domains
- performance
- correctness
- dependency-hygiene
