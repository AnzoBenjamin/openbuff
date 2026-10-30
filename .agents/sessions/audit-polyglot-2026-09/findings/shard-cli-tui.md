# Audit findings: shard-cli-tui

- Subsystems: cli-tui-shell, cli-startup-path, markdown-highlight-render, text-layout-graphemes, terminal-image-protocols, image-decode-pipeline, clipboard-integration, memory-v2-sqlite-repository, run-state-persistence, index-workspace-watcher, ripgrep-integration, fuzzy-matching
- Features: p7-t7-napi-kernels, p1-t6-web-tree-sitter, p1-t7-osc-notifications, p7-t3-tauri-desktop, startup-latency, keystroke-to-frame, large-file-rendering, sixel-kitty-image-pipeline, wayland-clipboard-images, memory-v2-sqlite-store
- Files covered: 22
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [HIGH] performance — cli/src/index.tsx:333 — Startup path serializes OSC theme probe and registry init before first frame (plan gap)
- **Risk:** Cold start pays up to 600ms of blocking OSC probing plus sequential awaited registry/skill/agent loads before the OpenTUI renderer is even created; none of this is language-bound and no locked roadmap item owns startup latency.
- **Fix:** Keep detection in TS (it must own stdin before OpenTUI) but run it concurrently with initializeApp via Promise.all; move agent/skill registry loads after first render. No native/napi work needed; this is orchestration.
- **Evidence:** cli/src/index.tsx:333-343 await detectTerminalTheme() before parseCliArgs; cli/src/index.tsx:371-388 sequential `await initializeApp` / `await initializeAgentRegistry` / `await initializeSkillRegistry` then createCliRenderer at cli/src/index.tsx:470; OSC budget cli/src/utils/terminal-color-detection.ts:15-16 (OSC_QUERY_TIMEOUT_MS=250, GLOBAL_OSC_TIMEOUT_MS=600)

## [MEDIUM] performance — cli/src/pre-init/tree-sitter-wasm.ts — web-tree-sitter wasm is loaded on the critical startup path (supports P1-T6 but must be lazy)
- **Risk:** tree-sitter.wasm is synchronously read from disk at module-eval time so the SDK's import chain can Parser.init eagerly, adding startup cost even in sessions that never render highlighted code.
- **Fix:** Defer Parser.init to first highlight request (post first frame) with an async loader; keep web-tree-sitter per the locked plan. A native tree-sitter napi would only be justified if wasm init/parses show up in profiles.
- **Evidence:** cli/src/index.tsx:8 `import './pre-init/tree-sitter-wasm'` as first import; cli/src/pre-init/tree-sitter-wasm.ts:77-93 readFileSync(siblingPath) at module scope; comment 'subsequent imports (the SDK / code-map) eagerly construct the parser' at cli/src/index.tsx:5-7

## [HIGH] performance — cli/src/utils/markdown-renderer.tsx — Markdown render path re-parses the entire document on every streaming chunk
- **Risk:** Every stream chunk re-parses the full markdown string with unified/remark and rebuilds the entire ReactNode tree; the incomplete-fence split re-renders the whole complete section each frame. Cost grows O(content length) per chunk on long answers.
- **Fix:** TS fix: cache the parsed/rendered AST prefix per block id and only re-parse the trailing paragraph/unclosed fence; keep remark in TS. A napi markdown parser is not justified.
- **Evidence:** cli/src/utils/markdown-renderer.tsx:1197 `const ast = processor.parse(markdown)` inside renderMarkdown; cli/src/utils/markdown-renderer.tsx:1254-1261 re-renders completeSection each call; sole streaming caller cli/src/components/blocks/content-with-markdown.tsx:31-32 (useMemo keyed on full content string)

## [MEDIUM] test-coverage — cli/src/utils/syntax-highlighter.tsx — Syntax highlighting is a stub; P1-T6 wasm tree-sitter must land incrementally or it regresses streaming frames
- **Risk:** Actual per-frame highlighting cost is currently zero, so P1-T6 will ADD wasm tree-sitter parse work into the streaming render path; if applied to whole files/large fences it will degrade keystroke-to-frame latency.
- **Fix:** Implement web-tree-sitter highlighting per P1-T6, but only for code blocks on screen (window by scroll viewport) and memoize per fence content. Reserve a native tree-sitter napi as a measured fallback only if wasm per-frame parse exceeds the keystroke budget.
- **Evidence:** cli/src/utils/syntax-highlighter.tsx:9-19 highlightCode returns `<span fg={fg}>{code}</span>` with comment 'Can be enhanced later'; no other highlighter references found in cli/src (code_search 'highlightCode' only hits this file)

## [HIGH] correctness — cli/src/utils/text-layout.ts — text-layout grapheme handling is code-point-based and O(n) stringWidth per keystroke/frame — the strongest napi-kernel candidate
- **Risk:** Wrapping splits on Unicode code points, not grapheme clusters: emoji ZWJ sequences, skin-tone modifiers, and combining marks can be split across lines and mis-measure width; stringWidth-per-char re-allocates per character on every keystroke and every streaming frame.
- **Fix:** Implement the P7-T7 grapheme-wrap napi kernel: intl_segment_graphemes + unicode-width + greedy wrap returning line splits, callable from both text-layout.ts and markdown-renderer. This is the clearest genuine napi candidate in the TUI layer.
- **Evidence:** cli/src/utils/text-layout.ts:31-33 `for (const ch of Array.from(segment))` in measureLines; cli/src/utils/text-layout.ts:80-84 same pattern in wrapTextToVisualLines; callers at cli/src/chat.tsx:1531-1535 (per keystroke), cli/src/utils/markdown-renderer.tsx:641-683 (per code-block line per frame), plus 10 more components (message-block, thinking, diff-viewer, agent-branch-*, tool-call-item...)

## [LOW] performance — cli/src/utils/fuzzy-match.ts — fuzzy-match is clearly a TS-correct component; nucleo napi is overkill at current scales
- **Risk:** The matcher is a simple greedy scorer used over small candidate sets (slash commands, @-suggestions, prompt history pages); napi overhead (JS<->Rust marshalling per keystroke) could exceed the compute it saves.
- **Fix:** Keep TS. Scope the P7-T7 nucleo kernel to prompt-history/agent-list search over large corpora only; do not route the command palette through napi.
- **Evidence:** cli/src/utils/fuzzy-match.ts:7-64 O(n*m) greedy match; callers: cli/src/commands/command-registry.ts, cli/src/components/command-palette-screen.tsx, cli/src/components/prompt-history-search-screen.tsx, cli/src/hooks/use-suggestion-engine.ts

## [HIGH] correctness — cli/src/utils/terminal-images.ts — Terminal image pipeline: sixel unimplemented, kitty chunking fragile, escape sequences rendered inside a plain text node
- **Risk:** Sixel renders nothing (falls back to metadata); kitty chunks are emitted without image id management or chunked-flag correctness (controlData repeats m semantics ambiguously), and sequences are emitted inside an OpenTUI <text> node with no cell-placement/z-order protocol, so reflows and scroll will corrupt or orphan images.
- **Fix:** This is where P7-T7 pays off: a napi image-decode/sixel-encode kernel (image crate) plus explicit OpenTUI protocol handling (cell budgeting, id reuse, DELETE after scroll) is justified. Supports and should EXTEND the locked plan: specify renderer integration, not just encoders.
- **Evidence:** cli/src/utils/terminal-images.ts:64-69 env-var-only detection; cli/src/utils/terminal-images.ts:183-186 sixel returns null; cli/src/utils/terminal-images.ts:110-155 kitty chunks with fixed 4096 and no id/m handling of responses; consumer cli/src/components/blocks/image-block.tsx:65-82 renders the escape string inside <text>

## [MEDIUM] performance — cli/src/utils/image-handler.ts — Image attach pipeline does up to 16 Jimp decode/encode attempts in JS
- **Risk:** Attaching a large image can run up to 16 full decode+resize+encode passes in pure JS before send, blocking the UI thread; thumbnail extraction also runs bilinear resize in JS.
- **Fix:** P7-T7 image kernel should cover encode/resize, not just decode: napi image-rs (or sharp) for resize+JPEG/PNG encode. Difficulty medium; unlocks attach-time latency and lower memory. Supports the locked plan with a scope clarification.
- **Evidence:** cli/src/utils/image-handler.ts:120-190 compressImageToFitSize loops DIMENSION_LIMITS x COMPRESSION_QUALITIES (4x4=16) each re-decoding `await Jimp.read(fileBuffer)`; cli/src/utils/image-thumbnail.ts:33-40 bilinear resize in JS; cli/src/utils/image-processor.ts:26-78 reuses pre-processed data (good)

## [MEDIUM] dependency-hygiene — cli/src/utils/clipboard-image.ts — Clipboard image reads spawnSync external tools incl. PowerShell on Windows; Wayland coverage is incidental
- **Risk:** Reading clipboard images shells out synchronously to osascript/pngpaste, xclip/wl-paste, or PowerShell with 5-10s timeouts on the interaction path; Wayland support depends on wl-paste being installed and behaves differently under compositors; PowerShell startup alone is ~1-2s.
- **Fix:** Candidate napi kernel: arboard (clipboard crate) behind a small napi binding for image get/put and text, with the existing OSC52 path kept for SSH. Difficulty medium (x11/wayland/win32/cocoa backends). Missing from the locked plan — add it.
- **Evidence:** cli/src/utils/clipboard-image.ts:96-140 readImageMacOS spawnSync pngpaste/osascript timeout 10000; cli/src/utils/clipboard-image.ts:172-200 readImageLinux xclip/wl-paste spawnSync; cli/src/utils/clipboard-image.ts:203-245 readImageWindows powershell spawnSync timeout 10000; readClipboardText powershell Get-Clipboard timeout 1000

## [LOW] performance — cli/src/utils/clipboard.ts — Text clipboard copy blocks the event loop via execSync
- **Risk:** copyTextToClipboard calls execSync (blocking) for pbcopy/xclip/clip on the local path, stalling the render loop briefly per copy action.
- **Fix:** Make platform-tool copy async (exec, not execSync) or fold into the arboard napi kernel from the clipboard-image finding. Low difficulty.
- **Evidence:** cli/src/utils/clipboard.ts:120-146 tryCopyViaPlatformTool execSync pbcopy/xclip/xsel/clip; cli/src/utils/clipboard.ts:196-216 tryCopyViaOsc52 writeSync to /dev/tty

## [MEDIUM] performance — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts — memory-v2: bun:sqlite is already native; the JS lexical fold is the cost, and FTS5 is probed but unused
- **Risk:** Retrieval does an admission scan plus a full JS fold (JSON.parse per event, stableJson re-serialization per projection upsert) over up to 10k events / 8MB payloads per query; the store records an fts5 capability but search() stays lexical-scan.
- **Fix:** TS-right with one SQL improvement: use the already-probed FTS5 (or a tokenized index table) to prefilter events server-side and fold only matches in JS. No napi layer warranted — bun:sqlite already is the native kernel.
- **Evidence:** cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:1185-1215 query() -> scanQueryRows(MAX_QUERY_EVENTS=10_000, MAX_QUERY_PAYLOAD_BYTES=8MiB) -> buildLexicalResult folds all events in JS; cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:2619-2633 fts5 capability probed and recorded but unused

## [LOW] state-mutation — cli/src/utils/run-state-storage.ts — Chat-state persistence serializes the whole session synchronously on the UI thread
- **Risk:** Every save synchronously deep-sanitizes and JSON.stringifies (pretty-printed, null-2) the full run state and message array plus three atomic writeFileSync+renameSync calls, blocking the render loop on large sessions.
- **Fix:** Move serialize+write off the render thread (Bun worker or async fs with a serialized queue). No native code needed; JSON stringify of MBs is milliseconds, the sync write is the stall.
- **Evidence:** cli/src/utils/run-state-storage.ts:247-300 saveChatState: sanitizeForChatPersistence(runState+messages) then writeJsonAtomic x3; called from cli/src/hooks/use-send-message.ts (saveChatState/saveCheckpoint referencedBy)

## [MEDIUM] correctness — cli/src/utils/index-workspace-watcher.ts — Recursive index watcher disabled on Linux+Bun; native (notify) watcher is the only real fix
- **Risk:** Recursive workspace watching is entirely disabled on Linux under Bun (fd retention in Bun's recursive watcher causing EMFILE/SIGILL), so index staleness detection there relies only on age-based sweeps and explicit SDK mutation deltas.
- **Fix:** Candidate napi kernel: notify-based recursive watcher with an event-loop-independent thread and native ignore filtering (gitignore-aware). This is a genuine gap the locked plan does not cover; difficulty medium.
- **Evidence:** cli/src/utils/index-workspace-watcher.ts:36-44 returns false when platform==='linux' && bunVersion; comment cites EMFILE and Bun HTTP SIGILL on large pnpm workspaces; ensureIndexWorkspaceWatcher silently skips at :78-83

## [LOW] performance — cli/src/native/ripgrep.ts — ripgrep stays an external native binary — TS is clearly right; only extraction latency on first use
- **Risk:** First search in a compiled binary pays a one-time self-extract + chmod of the bundled rg; subsequent calls are cached. Ripgrep is already the right native tool; a napi reimplementation would be wasted effort.
- **Fix:** TS-right as-is; optionally pre-warm extraction during initializeApp so the first search does not pay it. Keep rg as a process — embedding ripgrep as a napi lib adds link complexity for no keystroke benefit.
- **Evidence:** cli/src/native/ripgrep.ts:55-73 require() of platform rg binary then Bun.write extraction on first use, cached via rgPathPromise :82-91

## [LOW] performance — cli/src/utils/code-search-summary.ts — code-search-summary and terminal-color-detection are TS-right components (explicit no-napi)
- **Risk:** None — both are trivial string/regex handling; a native port would be pure overhead.
- **Fix:** No action; explicitly mark both TS-right in the roadmap so they are not swept into P7-T7 kernel work.
- **Evidence:** cli/src/utils/code-search-summary.ts:7-20 regex over split lines; cli/src/utils/terminal-color-detection.ts:44-507 withTimeout/sendOscQuery pure TS

## [MEDIUM] performance — cli/src/chat.tsx — Large-file / long-session rendering: no windowing in the chat render tree; chat.tsx monolith amplifies per-frame cost
- **Risk:** The chat surface is one ~1900-line component coordinating streaming, input layout, scroll, and queue state; render cost during streaming is dominated by React reconciliation of the whole message tree plus per-frame markdown re-parse (see separate finding), not by interpreter overhead.
- **Fix:** TS architecture work: window/virtualize rendered blocks (render only viewport + margin), memo per-block markdown by content hash, route keystroke layout through the P7-T7 kernel. This — not a language rewrite — is the lever the plan should name under a 'large file / long session rendering' item.
- **Evidence:** cli/src/chat.tsx:115-1893 single Chat component; cli/src/chat.tsx:386-395 useChatStreaming drives full-tree state; rerender-perf integration test exists at cli/src/__tests__/rerender-perf.integration.test.ts

## Coverage receipt

### Subsystems
- cli-tui-shell
- cli-startup-path
- markdown-highlight-render
- text-layout-graphemes
- terminal-image-protocols
- image-decode-pipeline
- clipboard-integration
- memory-v2-sqlite-repository
- run-state-persistence
- index-workspace-watcher
- ripgrep-integration
- fuzzy-matching

### Features
- p7-t7-napi-kernels
- p1-t6-web-tree-sitter
- p1-t7-osc-notifications
- p7-t3-tauri-desktop
- startup-latency
- keystroke-to-frame
- large-file-rendering
- sixel-kitty-image-pipeline
- wayland-clipboard-images
- memory-v2-sqlite-store

### Files
- cli/src/index.tsx
- cli/src/app.tsx
- cli/src/chat.tsx
- cli/src/pre-init/tree-sitter-wasm.ts
- cli/src/utils/text-layout.ts
- cli/src/utils/fuzzy-match.ts
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/syntax-highlighter.tsx
- cli/src/utils/terminal-images.ts
- cli/src/utils/terminal-color-detection.ts
- cli/src/utils/clipboard.ts
- cli/src/utils/clipboard-image.ts
- cli/src/utils/image-processor.ts
- cli/src/utils/image-handler.ts
- cli/src/utils/image-thumbnail.ts
- cli/src/utils/run-state-storage.ts
- cli/src/utils/index-workspace-watcher.ts
- cli/src/native/ripgrep.ts
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- cli/src/utils/code-search-summary.ts
- cli/src/components/blocks/image-block.tsx
- cli/src/components/blocks/content-with-markdown.tsx

### Domains
- performance
- correctness
- error-handling
- dependency-hygiene
