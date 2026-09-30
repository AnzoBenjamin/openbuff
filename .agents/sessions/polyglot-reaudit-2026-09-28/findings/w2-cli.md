# Audit findings: w2-cli

- Subsystems: cli
- Features: syntax-highlighting, markdown-rendering, text-layout, terminal-images, index-watcher, startup, diff-viewer, project-picker, init-command, memory-v2-concept-index, run-state-storage, binary-build
- Files covered: 16
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — cli/src/utils/syntax-highlighter.tsx:9 — [POLY] highlightCode is a no-op stub; every language renders as plain text, and markdown code fences never call it
- **Risk:** No language gets highlighting: TS/JS, Python, Rust, Go, Kotlin, shell, PowerShell, HCL/Terraform, SQL and the rest all fall back to monochrome text. The fence info string (py, python3, rs, golang, kt, sh, zsh, ps1, hcl, tf) is only echoed as a `// lang` header, which is also wrong comment syntax for Python, shell, SQL, HCL and similar languages. This is the P1-T6 gap.
- **Fix:** Implement P1-T6: add an alias normalizer for fence info strings (py/python3 to python, rs to rust, golang to go, kt/kts to kotlin, sh/zsh/bash/shell to bash, ps1/pwsh to powershell, tf/hcl to hcl, yml to yaml, and so on). Make renderCodeBlock emit styled spans per line before wrapping, and use a neutral header label instead of `// lang`.
- **Evidence:** syntax-highlighter.tsx:14-18 returns `<span fg={fg}>{code}</span>` with the comment 'Can be enhanced later'. markdown-renderer.tsx renderCodeBlock pushes `// ${code.lang}` and then plain spans with codeTextFg. code_search shows no caller of highlightCode in cli/src.

## [HIGH] correctness — cli/src/utils/text-layout.ts:26 — [POLY] Wrapping splits on code points, not grapheme clusters: ZWJ emoji, flags, combining marks and Indic conjuncts are mis-measured and can be split across lines
- **Risk:** Array.from(segment) plus stringWidth(ch) measures each code point on its own. A ZWJ family emoji is counted as about 6 columns instead of 2, and a regional-indicator flag as 2+2. Devanagari and Thai combining sequences can break mid-cluster. The result is early wraps and drifting input height/cursor metrics (computeInputLayoutMetrics). When a line break falls inside a ZWJ sequence, the terminal shows broken glyphs. markdown-renderer.tsx appendWrappedInlineSegment and wrapText have the same pattern (for-of over code points).
- **Fix:** Iterate graphemes with Intl.Segmenter using granularity 'grapheme' through one shared module-level instance (status-bar-chips.ts:132 already creates one; hoist it). Measure each grapheme with string-width and add an ASCII fast path. Add fixtures for ZWJ sequences, flags, skin-tone modifiers, combining accents, Hangul jamo and Devanagari.
- **Evidence:** text-layout.ts:26 and :84 `for (const ch of Array.from(segment))`. markdown-renderer.tsx wrapText and appendWrappedInlineSegment use `for (const char of token) { const charWidth = stringWidth(char)`. The only Intl.Segmenter in cli/src is status-bar-chips.ts:132.

## [MEDIUM] performance — cli/src/utils/text-layout.ts:4 — [BEST] measureLines re-tokenizes and re-measures the whole input on every keystroke, twice
- **Risk:** chat.tsx computeInputLayoutMetrics calls measureLines for the layout content and again for the cursor probe on every input or cursor change. That is O(n) regex splits plus a string-width call per token, and per code point for oversize tokens. Large pastes under LONG_TEXT_THRESHOLD and CJK text, which forces the per-char path, make typing lag.
- **Fix:** Measure once and return a line-start table, then derive the cursor line from it. Memoize per-line widths by line content, and short-circuit when every line is pure ASCII and shorter than cols.
- **Evidence:** chat.tsx inputLayoutMetrics useMemo depends on [inputValue, cursorPosition, inputWidth, terminalHeight]. text-layout.ts:146-147 has two measureLines calls, each running text.split(/(\s+)/) plus stringWidth.

## [MEDIUM] correctness — cli/src/utils/markdown-renderer.tsx — [POLY] RTL, CJK and Thai text has no bidi handling, and CJK/Thai never word-break because the wrapper only breaks on \s
- **Risk:** CJK and Thai text has no spaces, so each paragraph becomes one oversize token and gets split per code point. That works for CJK, but Thai breaks mid-word and kinsoku rules (no line-leading punctuation) are ignored. Mixed Arabic/Hebrew with code or paths gets no isolation, so terminal bidi reorders it unpredictably. Table padding also uses stringWidth on bidi text.
- **Fix:** Use Intl.Segmenter with granularity 'word' as the break-opportunity source (it covers Thai and CJK), apply simple kinsoku for CJK punctuation, and document that bidi is left to the terminal. Where supported, isolate inline code/paths with FSI/PDI marks.
- **Evidence:** wrapText and appendWrappedInlineSegment use `text.split(/(\s+)/)`, then fall back to per-char breaking when tokenWidth > maxWidth. There is no bidi or segmenter usage anywhere in the file.

## [HIGH] performance — cli/src/utils/markdown-renderer.tsx — [LANG] P1-T10: renderStreamingMarkdown re-parses the full document with remark on every chunk; per-block caching confirmed as the right mechanism
- **Risk:** Each streaming chunk runs processor.parse over the whole message, plus applyInlineFallbackFormatting, plus a full React node rebuild and a nextKey counter reset. Cost is O(total length) per chunk, so O(n^2) per message, and keys change on every chunk, forcing a full reconcile. The P1-T10 plan (block-prefix AST cache, re-parse only the trailing open block, memo by content hash) is the best mechanism in TS. A napi markdown parser (pulldown-cmark/comrak) would not remove the dominant React/cell cost, so keeping remark is correct.
- **Fix:** Split the source into top-level blocks (use mdast position offsets from the previous parse), cache the rendered ReactNode by block hash, and re-parse only from the last stable block boundary. Derive keys from block offset, not a global counter. Gate with the rerender-perf test.
- **Evidence:** renderStreamingMarkdown calls renderMarkdown(completeSection) on every call. renderMarkdown runs processor.parse(markdown) and createRenderState, whose counter restarts at 0. hasIncompleteCodeFence counts backticks over the whole content every call.

## [MEDIUM] correctness — cli/src/utils/markdown-renderer.tsx — [BEST] Streaming fence detection counts raw ``` occurrences; ~~~ fences, 4+ backtick fences and inline ``` break the split
- **Risk:** hasIncompleteCodeFence and lastIndexOf('```') ignore tilde fences, longer fences (````), and ``` inside inline code or indented blocks. A single inline ``` makes the rest of the message render as a raw pending section, and an open ~~~ fence gets parsed as prose while streaming, so code flickers as markdown.
- **Fix:** Detect open fences with a line-anchored scan that follows CommonMark (^ {0,3}(`{3,}|~{3,}) with the closing fence at least as long), or reuse remark's position data from the cached-prefix parse.
- **Evidence:** hasIncompleteCodeFence uses /```/g count % 2. renderStreamingMarkdown slices at content.lastIndexOf('```'). hasMarkdown also includes ``` only.

## [MEDIUM] performance — cli/src/utils/markdown-renderer.tsx — [BEST] Per-character React nodes when breaking long tokens; code blocks emit one span per visual line with no memo
- **Risk:** appendWrappedInlineSegment pushes segment.render(char, nextKey()) for every character of a long word or URL, and with inline styling it clones the element per character. A 2k-char minified line or base64 blob in a paragraph becomes 2k React elements.
- **Fix:** Accumulate characters into line-sized chunks and emit one node per chunk per visual line. Memoize renderCodeBlock output by (value, lang, width).
- **Evidence:** appendWrappedInlineSegment: `for (const char of token) { ... nodes.push(segment.render(char, nextKey()))`. collectInlineSegments renderChild uses React.cloneElement per segment.

## [MEDIUM] performance — cli/src/chat.tsx — [LANG] P1-T10: no viewport virtualization; all visible top-level messages mount inside scrollbox
- **Risk:** visibleTopLevelMessages.map renders every loaded message, and each one re-renders markdown. Long sessions slow down linearly. LoadPreviousButton paginates the head but does not window the body. Planned mechanism (TS windowing over OpenTUI scrollbox) confirmed correct.
- **Fix:** Virtualize on measured block heights, rendering only blocks intersecting the viewport plus overscan, with height caching keyed by (message id, width). Pair this with a memo of MessageWithAgents by content hash.
- **Evidence:** chat.tsx scrollbox body: `visibleTopLevelMessages.map((message, idx) => <MessageWithAgents .../>)`. There is no windowing in useChatMessages consumers in this file.

## [MEDIUM] performance — cli/src/index.tsx — [LANG] P1-T9: OSC theme probe, registry loads and eager wasm read are serial on the startup critical path; TS plan confirmed, Rust launcher not warranted
- **Risk:** The critical path runs in series: detectTerminalTheme is awaited before parseCliArgs, then initializeApp, initializeAgentRegistry and initializeSkillRegistry are awaited in sequence before the renderer is created. pre-init readFileSync of tree-sitter.wasm happens at module scope on every launch, including --help. A Rust launcher would not help, because the cost is JS-side sequencing and module evaluation, not process spawn. Bun --compile plus deferral is the best mechanism.
- **Fix:** Run the OSC probe concurrently with initializeApp (it must still finish before createCliRenderer claims stdin). Load agent and skill registries after the first frame. Make the pre-init wasm read lazy by publishing only the path and reading bytes on the first Parser.init. Measure with an X-2 cold-start row.
- **Evidence:** index.tsx: `await detectTerminalTheme()` precedes parseCliArgs. The awaits initializeApp, initializeAgentRegistry and initializeSkillRegistry are sequential and come before createCliRenderer. pre-init/tree-sitter-wasm.ts:77 runs readFileSync(siblingPath) at module top level.

## [HIGH] correctness — cli/src/utils/index-workspace-watcher.ts:36 — [LANG] P2-T9: watcher fully disabled on Linux+Bun; index freshness relies only on age sweeps and SDK deltas
- **Risk:** On the primary dev platform (Linux + Bun), edits made outside the agent (editor, git checkout, codegen) are not seen until an age-based sweep runs, so search and code-map return stale results. The plan (per-directory non-recursive watchers with an fd cap in TS, notify at P6-T6) is the right interim step. A napi watcher only to delete it later would be waste.
- **Fix:** Implement P2-T9: walk directories while honoring IGNORED_TOP_LEVEL plus .gitignore, and put non-recursive fs.watch on each directory up to an fd budget (for example 2k). Beyond the cap, fall back to markStale on a short interval, and add dirs on 'rename' events. Also watch .git/HEAD to catch checkouts.
- **Evidence:** index-workspace-watcher.ts:36 `return !(params.platform === 'linux' && params.bunVersion)`, and ensureIndexWorkspaceWatcher returns early.

## [LOW] correctness — cli/src/utils/index-workspace-watcher.ts:63 — [POLY] Deletion classification relies on path.extname, so extensionless files (Makefile, Dockerfile, Gemfile, BUILD, justfile) become ambiguous and force full markStale
- **Risk:** Deleting or renaming extensionless build files, common in Go, Ruby, Bazel and C projects, triggers a full stale mark instead of a targeted delete. IGNORED_TOP_LEVEL is JS-centric: it omits target (Rust), __pycache__/.venv/venv (Python), vendor (Go/PHP), .gradle, bin/obj (.NET), .dart_tool, zig-cache/.zig-cache and _build/deps (Elixir), so events from those trees are not filtered.
- **Fix:** Ask the index manager whether the path was indexed rather than using extname. Extend the ignore set per detected ecosystem, or reuse the indexer's ignore config and .gitignore.
- **Evidence:** line 63-66: `return path.extname(relativePath) ? { kind: 'deleted' } : { kind: 'ambiguous' }`. IGNORED_TOP_LEVEL at lines 13-25 lists only VCS dirs and JS build outputs.

## [MEDIUM] correctness — cli/src/utils/project-picker.ts:3 — [POLY] Project root detection is a home-dir check only; no manifest detection for non-JS ecosystems
- **Risk:** The picker appears only when cwd is home or above. Starting in a subdirectory of a Rust, Go, Python, JVM, .NET, Swift, Elixir, PHP, Ruby, Dart, Zig, CMake/Meson or Nix project never offers to jump to the true root, and getProjectRoot's behavior on non-git polyglot workspaces is not manifest-aware. Deep cwd starts in, for example, crates/foo/src index only a fragment.
- **Fix:** Add a manifest walk-up (Cargo.toml with [workspace], go.work/go.mod, pyproject.toml, pom.xml, settings.gradle(.kts)/build.gradle(.kts), *.sln/*.csproj, Package.swift, mix.exs, composer.json, Gemfile, pubspec.yaml, build.zig, CMakeLists.txt, meson.build, flake.nix, package.json workspaces). Offer the outermost workspace root the way gitRoot switching does.
- **Evidence:** project-picker.ts contains only shouldShowProjectPicker(startCwd, homeDir) using path.relative. There are no manifest names.

## [MEDIUM] api-contract — cli/src/commands/init.ts:27 — [POLY] /init writes a language-agnostic stub plus TypeScript-only agent type files regardless of project language
- **Risk:** The knowledge template is empty and does not detect the stack, so a Python, Go or Rust user gets no prefilled setup/test commands. .agents/types/*.ts is always copied, even into non-TS repos, where it is noise and implies agents must be written in TS.
- **Fix:** Detect ecosystems from manifests (the same table as the picker) and prefill Quickstart with idiomatic commands (cargo test, go test ./..., pytest/uv run, mvn/gradle test, dotnet test, swift test, mix test, and so on). Mention the languages in Architecture. Keep the TS type files but explain why they are there, or put them behind agent authoring.
- **Evidence:** INITIAL_KNOWLEDGE_FILE is a static template with blank Setup/Dev/Test. COMMON_TYPE_FILES always writes agent-definition.ts, tools.ts and util-types.ts.

## [LOW] error-handling — cli/src/commands/init.ts:70 — [BEST] Atomic create-by-link fails on filesystems without hard links (some FUSE/SMB/exFAT, WSL DrvFs) and aborts all of /init
- **Risk:** linkSync throws EPERM/ENOTSUP on such filesystems, rollback runs, and /init can never succeed there.
- **Fix:** On EPERM/ENOTSUP/EXDEV from linkSync, fall back to writeFileSync(target, content, { flag: 'wx' }), which is still no-clobber.
- **Evidence:** writeNewFileAtomically: writeFileSync(tmp, wx), then linkSync(tmp, target). Any error leads to unlink and rethrow.

## [MEDIUM] state-mutation — cli/src/utils/run-state-storage.ts:236 — [BEST] writeJsonAtomic has no fsync and a non-atomic EEXIST/EPERM fallback; the checkpoint temp name collides across same-pid writes
- **Risk:** Without fsync of the file and directory, a crash or power loss after rename can leave a zero-length chat-state.json. Journaling filesystems order data and metadata this way. The Windows EPERM fallback unlinks the target before renaming, which opens a window with no state file. saveCheckpoint's temp path is `.tmp.${pid}` with no uniqueness, so overlapping writes in one process clobber each other, and a crash mid-write is swept only on the next save.
- **Fix:** Open the temp file, write, fsyncSync(fd), close, rename, then fsync the directory (skipped on win32). On Windows retry rename with backoff instead of unlinking first. Add a random suffix to checkpoint temp names. Consider Bun.write followed by fsync.
- **Evidence:** writeJsonAtomic: writeFileSync(temp), renameSync, and in catch `fs.unlinkSync(filePath); fs.renameSync(tempPath, filePath)`. saveCheckpoint: tempPath = `${checkpointPath}.tmp.${process.pid}`.

## [LOW] state-mutation — cli/src/utils/run-state-storage.ts:333 — [BEST] saveChatState writes the envelope and two legacy sidecars as three separate files; readers can observe mixed turns in the sidecars
- **Risk:** The envelope is authoritative, but history views read run-state.json and chat-messages.json, which may be from different turns after a crash between writes. Every save also serializes the full state three times with 2-space pretty printing, which is O(session) I/O per turn for large sessions.
- **Fix:** Write sidecars only on session close or lazily, or drop them behind a compatibility flag. Use compact JSON for the envelope.
- **Evidence:** saveChatState calls writeJsonAtomic three times (chatStatePath, getRunStatePath(), getChatMessagesPath()). writeJsonAtomic uses JSON.stringify(value, null, 2).

## [LOW] performance — cli/src/services/memory-v2/concept-index.ts:236 — [BEST] Per-entry prepare() inside the corpus loop, JSON-text vectors, and non-transactional inserts
- **Risk:** db.prepare runs for each corpus entry, vectors are stored as JSON text (parse cost plus 3-4x size), and inserts and LRU pruning run outside a transaction. Each INSERT is its own fsync with journal_mode=DELETE, which can use a large part of the 1.5s timeout budget.
- **Fix:** Hoist the SELECT statement, wrap the insert/prune phase in one transaction, and store vectors as Float32Array BLOBs.
- **Evidence:** expandConceptRecallInner: `db.prepare('SELECT vector ...').get(...)` inside `for (const entry of params.corpus)`. insertVector.run runs per entry without BEGIN. vector column is TEXT and JSON.stringify(vector) is stored.

## [LOW] correctness — cli/src/services/memory-v2/concept-index.ts:65 — [POLY] conceptEmbedText truncates by UTF-16 code units (slice(0,512)); can split surrogate pairs in CJK/emoji text
- **Risk:** A lone surrogate in the embed text changes its hash and can make some embedders reject or garble input for non-Latin observations.
- **Fix:** Truncate on a grapheme or code point boundary, for example Array.from(s).slice(0, 512).join('') or Intl.Segmenter.
- **Evidence:** `.replace(/\s+/g, ' ').trim().slice(0, 512)`

## [MEDIUM] correctness — cli/src/utils/terminal-images.ts:17 — [LANG] P7-T7: detection misses WezTerm/Ghostty/Konsole/foot/tmux passthrough; sixel returns null; escape strings bypass the renderer. Rust napi image kernel confirmed
- **Risk:** Only iTerm.app and xterm-kitty/KITTY_WINDOW_ID are detected. WezTerm (iTerm2 and kitty protocols), Ghostty (kitty), Konsole, foot, mlterm, Windows Terminal 1.22+ (sixel) and VS Code are 'none'. Under tmux, sequences are not DCS-wrapped. The cache ignores the env parameter, so tests that pass a different env get a stale result. Kitty chunking puts the full control keys on every chunk, but the spec wants keys only on the first chunk and m=0 on the last. The plan's Rust napi kernel (image decode/resize + sixel encode) is the best mechanism, with TS for protocol framing.
- **Fix:** Detect via TERM_PROGRAM (WezTerm, ghostty, vscode), TERM (foot, xterm-ghostty), a DA1 query for sixel and the kitty graphics query (a=q). Add tmux passthrough wrapping. Key the cache by env or drop it when env is passed. Send control keys only on the first kitty chunk and add m=0 on the last. Implement sixel in the P7-T7 napi kernel.
- **Evidence:** detectTerminalImageSupport checks only TERM_PROGRAM==='iTerm.app' and TERM==='xterm-kitty'. cachedProtocol is module-global. generateKittyImageSequence uses `isLast ? controlData : `${controlData},m=1``. The sixel case returns null.

## [LOW] performance — cli/src/components/tools/diff-viewer.tsx:318 — [LANG] P4-T7: no word-level intra-line diff; parse is unmemoized per render. TS diff lib first confirmed
- **Risk:** Paired del/add lines are colored as whole lines. parseDiffIntoHunks re-runs on every render, including hunk toggles. The P4-T7 plan (TS word diff via the diff package's diffWordsWithSpace, or a grapheme-aware LCS, with imara-diff napi only if X-2 shows the need) is correct, because pairs are small and bounded by DIFF_MAX_RENDER_NODES. Tokenization should use Intl.Segmenter word granularity so CJK and identifiers diff sensibly.
- **Fix:** useMemo(parseDiffIntoHunks, [diffText]). Reuse pairSideBySideRows pairing in unified mode too, and highlight changed word runs with an inverse background.
- **Evidence:** DiffViewer body: `const parsedDiff = parseDiffIntoHunks(diffText)` with no memo. There is no word-diff code, and lineColor/colorForType are whole-line.

## [LOW] correctness — cli/src/components/tools/diff-viewer.tsx:492 — [POLY] Side-by-side padding uses String.padEnd (UTF-16 length), so CJK/emoji lines misalign the separator column
- **Risk:** leftSeg.padEnd(n) counts code units, not display columns. Wide characters push the right pane out of alignment.
- **Fix:** Pad by stringWidth, reusing padText from markdown-renderer through a shared text-layout helper.
- **Evidence:** `{leftSeg.padEnd(Math.max(1, sxsTextWidth - 1))}`

## [LOW] dependency-hygiene — cli/scripts/build-binary.ts:230 — [LANG] Binary build: bun --compile plus sibling wasm is appropriate; no Rust launcher needed. Minor: NEXT_PUBLIC values are unescaped in --define, and the tarball has no integrity check
- **Risk:** NEXT_PUBLIC_* values containing quotes break the build or inject code into defines. ensureOpenTuiNativeBundle downloads an npm tarball without verifying dist.integrity. The bun --compile approach is the best fit, since a Rust launcher adds a process hop without fixing JS startup cost.
- **Fix:** Use JSON.stringify(value) for define values. Verify the metadata dist.integrity (sha512) before extracting.
- **Evidence:** nextPublicEnvVars map: `"${value ?? ''}"`. tarballUrl is fetched and extracted with tar with no integrity check.

## [MEDIUM] test-coverage — cli/src/utils/text-layout.ts — [BEST] No grapheme, CJK, RTL or fence-alias fixtures guard wrapping and highlighting
- **Risk:** Regressions in the D12 grapheme kernel and P1-T6 alias mapping will not be caught. The existing tests exist (text-layout.test.ts, markdown-renderer.test.tsx), but the code has no segmenter or alias paths to test.
- **Fix:** Add table-driven fixtures: ZWJ families, flags, combining marks, Hangul, Thai, Arabic mixed with code, and fence aliases py/rs/golang/kt/sh/zsh/ps1/hcl/tf mapping to canonical languages.
- **Evidence:** There is no Intl.Segmenter in text-layout.ts or markdown-renderer.tsx, and no alias table exists anywhere. Test file names are from the referencedBy index; I did not read their contents.

## [LOW] security — cli/src/pre-init/tree-sitter-wasm.ts:35 — [BEST] Wasm is loaded from argv[0]'s directory before execPath, without checking the manifest hash
- **Risk:** argv[0] can be set by the caller, for example via exec -a, so a relative or spoofed argv[0] can point at an attacker-writable directory's tree-sitter.wasm. build-binary writes tree-sitter-manifest.json with sha256 values, but pre-init never verifies it.
- **Fix:** Prefer the realpath of execPath when it is not a bunfs path, and verify the sha256 against tree-sitter-manifest.json before publishing bytes.
- **Evidence:** candidates = [process.argv[0], process.execPath] and the first existing file wins. build-binary.ts writes tree-sitter-manifest.json.

## Coverage receipt

### Subsystems
- cli

### Features
- syntax-highlighting
- markdown-rendering
- text-layout
- terminal-images
- index-watcher
- startup
- diff-viewer
- project-picker
- init-command
- memory-v2-concept-index
- run-state-storage
- binary-build

### Files
- cli/src/utils/syntax-highlighter.tsx
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/text-layout.ts
- cli/src/utils/word-wrap-utils.ts
- cli/src/utils/terminal-images.ts
- cli/src/utils/index-workspace-watcher.ts
- cli/src/pre-init/tree-sitter-wasm.ts
- cli/src/index.tsx
- cli/src/chat.tsx
- cli/src/components/tools/diff-viewer.tsx
- cli/src/utils/project-picker.ts
- cli/src/commands/init.ts
- cli/src/services/memory-v2/concept-index.ts
- cli/src/utils/run-state-storage.ts
- cli/scripts/build-binary.ts
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
