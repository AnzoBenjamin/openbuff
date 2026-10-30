# Audit findings: r6-cli-tui

- Subsystems: cli-tui-rendering, cli-durability, cli-index-watching
- Features: native-markdown-rendering, syntax-style-memoization, viewport-windowing, streaming-message-batching, turn-snapshots, turn-bisection, mid-turn-checkpoint, run-journal, chat-state-persistence, workspace-index-watching, terminal-images, text-layout-graphemes
- Files covered: 13
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [HIGH] correctness — cli/src/components/image-card.tsx:64 — Terminal image escape sequences are injected into an OpenTUI <text> renderable, not written raw to stdout
- **Risk:** generateITerm2ImageSequence/generateKittyImageSequence (terminal-images.ts) return raw terminal escape strings, and ImageCard renders them as `<text>{thumbnailSequence}</text>`. OpenTUI owns the screen buffer and draws text cell-by-cell; ESC ]1337 / ESC _G bytes inside a TextRenderable are rendered as literal garbage glyphs, not interpreted by the terminal. The kitty path partially 'works' only because index.tsx passes kittyImageTransport:'raw' to the renderer for the whole app, but the iTerm2 path is dead-wrong output and kitty sequences drawn via <text> are at best redundant/at worst corrupt cells. This hand-rolled pipeline is NOT the best implementation — it duplicates what the native renderable already provides.
- **Fix:** Drop the hand-rolled sequence emitters and rely on OpenTUI 0.5's native image renderable/transport (index.tsx already sets kittyImageTransport:'raw' for kitty), or route sequences through a raw-stdout writer outside the render tree. Keep renderInlineImage only for the (rare) non-OpenTUI headless path.
- **Evidence:** image-card.tsx:64 `setThumbnailSequence(sequence)` then :123 `<text>{thumbnailSequence}</text>`; terminal-images.ts generateITerm2ImageSequence returns `\x1b]1337;File=...\x07` and generateKittyImageSequence returns `\x1b_G...\x1b\\` as plain strings.

## [MEDIUM] correctness — cli/src/utils/turn-snapshots.ts:470 — Concurrent snapshot captures can fork the private ref chain (last-writer-wins update-ref)
- **Risk:** createTurnSnapshot has no serialization. capturePreDispatchSnapshot's Promise.race deliberately leaves a timed-out shell snapshot running in the background; the immediately following turn's createTurnSnapshot can then run concurrently. Both read the same parent via revParse, both commit-tree with -p parent, and both update-ref — last writer wins, so one commit silently falls off the chain (its snapshot is lost to /undo-turn and bisection walks a truncated history). No lock like the bisection guard protects this path.
- **Fix:** Serialize captures with an in-process single-flight queue keyed by repo (mirroring the bisection guard), and make the ref move a compare-and-swap: git update-ref refs/openbuff/turns <new> <expected-old> with retry-on-race.
- **Evidence:** turn-snapshots.ts:~470-500 (parent read then update-ref without CAS); capturePreDispatchSnapshot Promise.race at ~530-560 resolves the timeout while createTurnSnapshot continues; no single-flight lock analogous to bisectRunning/acquireTurnBisectionLock.

## [MEDIUM] state-mutation — cli/src/utils/turn-snapshots.ts:658 — Snapshot retention mutates the repo-global refs/replace namespace (graft)
- **Risk:** Retention grafts the oldest kept snapshot via git replace --graft, writing refs/replace/<sha> — a repo-global namespace outside the module's documented 'private ref only' model. Replace refs are honored by the user's own git log/diff for those objects (changing displayed history for snapshot commits) and are pushed by git push --mirror, accumulating one entry per prune cycle. The code discloses this but does not bound or isolate it.
- **Fix:** Either move retention into the openbuff namespace (e.g. store a retention watermark ref under refs/openbuff/turns-keep and list only from there), or at minimum guard against pre-existing refs/replace entries and add a cleanup path; never silently accumulate a second global ref namespace.
- **Evidence:** turn-snapshots.ts:~640-690 runGitCommand ['replace', '--graft', graftTarget]; module docblock 'Private ref namespace' claim vs the disclosed refs/replace side effect in the prune docblock.

## [MEDIUM] correctness — cli/src/utils/turn-snapshots.ts:940 — runTurnBisection rewrites the tracked working tree with no guard against concurrent agent turns or user edits
- **Risk:** Bisection checks out each probed snapshot into the tracked working tree and restores the newest tree at the end, but the only guards pause snapshot creation (bisectRunning + cross-process lock). An agent turn running concurrently (or user edits) during probes mutates files between checkout and test run, corrupting probe verdicts; the final unconditional checkoutSnapshotTree can also clobber concurrent user/agent writes. Nothing pauses agent runs or verifies the tree still matches the snapshot before each probe.
- **Fix:** Refuse to start bisection while a run is active (reuse the run-ownership state from use-message-queue/use-send-message), snapshot/pause agent turns during bisection, and before each probe verify the tracked tree still matches the checked-out snapshot (write-tree compare) — on drift, abort as inconclusive instead of reporting a false first-failing turn.
- **Evidence:** turn-snapshots.ts runTurnBisection probeFn: checkoutSnapshotTree → runSuite with no tree-state validation; createTurnSnapshot only checks bisectRunning || isTurnBisectionLockHeld; nothing gates useSendMessage/send-message paths during bisection.

## [MEDIUM] correctness — cli/src/utils/text-layout.ts:44 — Array.from code-point splitting breaks grapheme-cluster width accounting in text wrapping
- **Risk:** Both measureLines and wrapTextToVisualLines hard-wrap oversized segments with 'for (const ch of Array.from(segment))' — Array.from splits by code point, not grapheme cluster. stringWidth() of an individual code point inside a multi-codepoint grapheme (ZWJ emoji family sequences, skin-tone modifiers, combining marks) is wrong (surrogate halves count 1 each; ZWJ counts 0), so column accounting drifts and wraps land mid-grapheme, corrupting rendered alignment for CJK-emoji-heavy chat content. SPEC D47's 'native grapheme width' is not actually met by this loop.
- **Fix:** Iterate grapheme clusters with the built-in Intl.Segmenter({granularity:'grapheme'}) (zero-dependency, correct for ZWJ/combining sequences) instead of Array.from, or accumulate via a grapheme-aware iterator; add a ZWJ-emoji wrap test.
- **Evidence:** text-layout.ts appendSegment 'for (const ch of Array.from(segment))' with stringWidth(ch) (hard-wrap); identical pattern in wrapTextToVisualLines; use-viewport-window.ts estimateTextLines uses per-raw-line stringWidth (safe) but wrapTextPreservingNewlines output is what actually renders.

## [MEDIUM] performance — cli/src/hooks/use-viewport-window.ts:947 — Anchor layout effect runs on every render and snapshots three O(N) arrays per scroll tick
- **Risk:** The scroll-anchoring useLayoutEffect has no dependency array, so it runs after EVERY render of the hook consumer — including every scroll-position state update during scrolling and every streaming flush — and each run allocates a fresh snapshot object plus copies messageIds/offsets/heights (three O(N) arrays) even when nothing above the viewport changed. computeTopSpacer also re-runs an O(N) scan outside useMemo on every render. On a long session this is per-scroll-tick O(N) allocation and copying.
- **Fix:** Give the anchor effect an explicit dep array (offsets, heights, messageIds, availableWidth, scrollTop) so it only runs when layout inputs change, and memoize topSpacer with the same deps.
- **Evidence:** use-viewport-window.ts:~947 useLayoutEffect(() => {...}) with no dep array; anchorPrevRef.current = {width, ids: messageIds, offsets, heights} (new object + already-copied arrays each run); computeTopSpacer linear scan at ~1021 outside useMemo.

## [MEDIUM] state-mutation — cli/src/utils/run-state-storage.ts:270 — writeJsonAtomic fallback (unlink-then-rename) leaves a non-atomic window that can destroy the authoritative chat-state envelope
- **Risk:** writeJsonAtomic's EEXIST/EPERM fallback unlinks the EXISTING authoritative file and then renames the temp into place. A crash (or a second rename failure) between unlinkSync and renameSync destroys the only authoritative resume state — exactly the crash the temp+rename scheme exists to prevent. On Windows (where the fallback exists for) this is a real window on every write that hits EPERM.
- **Fix:** Use rename-with-backup semantics (rename old → .bak, rename temp → target, unlink .bak on success) or copy_file_range/write directly with fsync; never unlink the authoritative file before its replacement is in place.
- **Evidence:** run-state-storage.ts writeJsonAtomic: `if (!['EEXIST','EPERM'].includes(code)) throw; fs.unlinkSync(filePath); fs.renameSync(tempPath, filePath)` — two-step target replacement on the versioned envelope path.

## [LOW] security — cli/src/utils/run-state-storage.ts:455 — Checkpoint temp file lacks 0600 mode and the stale-tmp sweep can delete a concurrent writer's in-flight temp
- **Risk:** saveCheckpoint writes its temp file with default mode (umask-dependent, typically 0644) while saveChatState deliberately uses 0o600 — the mid-turn checkpoint carries the full serialized mainAgentState (context, possibly sensitive content) world-readable until rename. Also the stale-tmp sweep unlinks ANY `<file>.tmp.<pid>.<ts>` in the directory, including a temp file just written by a CONCURRENT openbuff process mid-write, causing that process's renameSync to fail (checkpoint lost for that writer).
- **Fix:** Pass mode 0o600 to writeFileSync, restrict the sweep to files owned by this pid (`prefix + process.pid + '.'`), and tolerate ENOENT from a raced sweep instead of sweeping all pids.
- **Evidence:** run-state-storage.ts saveCheckpoint: `const tempPath = ...; for (const entry of fs.readdirSync(dir)) if (entry.startsWith(`${CHECKPOINT_FILENAME}.tmp.`) && entry !== path.basename(tempPath)) fs.unlinkSync(...); fs.writeFileSync(tempPath, serialized)` — no mode option, sweeps foreign tmp files.

## [MEDIUM] correctness — cli/src/utils/index-workspace-watcher.ts:100 — Per-event existsSync/statSync in the watcher callback is synchronous main-thread fs on the event hot path
- **Risk:** Every raw watcher event (including bursts from builds/git checkout) synchronously runs existsSync + statSync via classifyIndexWatchPath on the main thread before the 75ms debounce. A `bun install` or `git checkout` fanning out thousands of events serializes thousands of stat calls per burst on the UI-adjacent thread, and deleted-path classification double-stats (existsSync then statSync in the try).
- **Fix:** Classify lazily/debounced: collect raw relative paths in the existing Set-based buffer and classify inside the 75ms flush (bounded batch), or move existsSync/statSync off the event-callback hot path.
- **Evidence:** index-workspace-watcher.ts:~100 classifyIndexWatchPath (existsSync+statSync) called from feedClassification for every event; recursive watcher callback and the pool's onRawEvent both call it synchronously.

## [LOW] correctness — cli/src/utils/index-workspace-watcher.ts:160 — New-directory events degrade the whole session to markStale (over-invalidation) and warn latch silently caps at 32 dirs
- **Risk:** feedClassification sets ambiguous=true for ANY ambiguous classification, including the benign 'a new directory appeared' case, so every legitimate directory creation forces manager.markStale() — a full conservative invalidation — instead of indexing just the new subtree. Separately, once >32 distinct failed directories warn (createBoundedWarnLatch maxKeys), further per-dir watch failures are fully silent with no aggregate counter, so a systemic watch failure on a huge repo degrades invisibly.
- **Fix:** Split ambiguity kinds: a confirmed new directory should enqueue a targeted addDir (and index that path), not flip the whole session to markStale; keep markStale for genuinely unclassifiable events.
- **Evidence:** index-workspace-watcher.ts feedClassification: `if (classified.kind === 'ambiguous') { ambiguous = true }` before the directory addDir branch; index-dir-watch.ts onMessage 'watch-error'/'watch-failed' keys the latch by `dir:${message.dir}` with DEFAULT_MAX_WARN_KEYS=32 total keys.

## [MEDIUM] api-contract — cli/src/utils/run-journal-path.ts:73 — Macro cohesion (C): four durability layers with independent keys and no defined recovery precedence
- **Risk:** Four durability layers coexist with independent keys and fail-open semantics but no cross-linked recovery order: chat-state.json envelope (versioned, keyed by chatId), turn-checkpoint.json (keyed by promptId/userMessageId), run-journal sqlite (keyed by seq/runId), and refs/openbuff/turns (keyed by tracked tree). Each validates only itself. A crash mid-turn can resume messages from the envelope of turn N+1 while restoring the tracked tree from turn N-1's snapshot, or replay journal events whose checkpoint was discarded — the layers overlap (journal AND checkpoint both capture agent state; envelope AND journal both capture messages) without a defined precedence, so recovery can mix states across layers.
- **Fix:** Define one recovery order (journal seq → checkpoint turnId → chat-state envelope → snapshot ref) in a single coordinator that validates the turn id across ALL layers before applying any of them, and document which layer is authoritative for which artifact (messages vs agent state vs tracked tree).
- **Evidence:** run-state-storage.ts getCheckpointPath/saveCheckpoint (checkpointTurnId = userMessageId); turn-snapshots.ts TURN_SNAPSHOT_REF + label 'turn'/'shell'; run-journal-path.ts resolveRunJournalPath + openRunJournalForRun fail-open; use-send-message.ts wires all three but only clearCheckpoint on completion (:670).

## [LOW] correctness — cli/src/utils/tree-sitter-client.ts:220 — Untrusted-fallback mkdtemp dir is never cleaned up and parsersRegistered=true is recorded even when zero parsers registered
- **Risk:** When the per-user cache dir is owned by another uid (or inspect fails), getTreeSitterDataPath falls back to mkdtempSync('codebuff-tree-sitter-untrusted-') and NOTHING ever removes that directory — every run on a shared host leaks a temp dir plus the worker's content-addressed cache copies. Separately parsersRegistered is set true even when buildDefaultParsers() returned zero parsers (assets missing), so a client created later in the same long-lived process (after an upgrade fixes assets) can never register parsers without a restart.
- **Fix:** Register a process-exit cleanup for the untrusted mkdtemp dir (or reuse one pid-private dir per process), and only set parsersRegistered=true when parsers.length > 0 so a later call can retry after assets appear.
- **Evidence:** tree-sitter-client.ts getTreeSitterDataPath: `return mkdtempSync(path.join(os.tmpdir(), 'codebuff-tree-sitter-untrusted-'))` (two call sites, no rmSync anywhere in the module); getSharedTreeSitterClient sets parsersRegistered=true unconditionally inside the try.

## [LOW] performance — cli/src/components/image-card.tsx:57 — Synchronous fs.readFileSync + base64 encode of the full image on the render path per card
- **Risk:** loadThumbnail synchronously reads the FULL image file and base64-encodes it on the UI thread for every mounted ImageCard whose status is ready; for a multi-MB screenshot this blocks the render loop per card, and it re-runs whenever the image object identity changes (attachment re-renders). Only the first ~4x3 cells are ever displayed for inline previews.
- **Fix:** Read asynchronously (fs.promises) with the existing cancelled guard, and memoize base64 per path (or read once in image-processor and pass processedImage through) so re-mounts don't re-read.
- **Evidence:** image-card.tsx:57 `const imageData = fs.readFileSync(image.path); base64Data = imageData.toString('base64')` inside useEffect; effect deps `[image, canShowInlineImages]` re-run per card instance.

## [LOW] test-coverage — cli/src/utils/terminal-images.ts:220 — DA1 image-capability parser remains an unwired test-only path; production detection stays env-only
- **Risk:** parseDa1ImageCapability is exported and unit-tested but has zero production call sites — the docblock itself says detectTerminalImageSupport() still decides purely from env vars, so terminals that support images but don't set TERM_PROGRAM/TERM markers (common: kitty inside tmux, ghostty, wezterm) get 'none' and images degrade to metadata even though the DA1 probe parser exists and is tested. The capability the spec asks for is present in code but not in the product.
- **Fix:** Wire the bounded DA1 probe at startup (index.tsx capability-detection pass) and merge per the documented precedence, or delete the parser until the wiring lands so the export does not imply shipped behavior.
- **Evidence:** terminal-images.ts parseDa1ImageCapability docblock 'TODO(P1-T7-wiring): this parser has no production call site yet'; referencedBy lists only the unit test; index.tsx:759 calls detectTerminalImageSupport() only.

## Coverage receipt

### Subsystems
- cli-tui-rendering
- cli-durability
- cli-index-watching

### Features
- native-markdown-rendering
- syntax-style-memoization
- viewport-windowing
- streaming-message-batching
- turn-snapshots
- turn-bisection
- mid-turn-checkpoint
- run-journal
- chat-state-persistence
- workspace-index-watching
- terminal-images
- text-layout-graphemes

### Files
- cli/src/chat.tsx
- cli/src/index.tsx
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/text-layout.ts
- cli/src/utils/terminal-images.ts
- cli/src/utils/opentui-syntax-style.ts
- cli/src/utils/tree-sitter-client.ts
- cli/src/utils/index-workspace-watcher.ts
- cli/src/utils/index-dir-watch.ts
- cli/src/utils/turn-snapshots.ts
- cli/src/utils/run-journal-path.ts
- cli/src/utils/run-state-storage.ts
- cli/src/hooks/use-viewport-window.ts

### Domains
- correctness
- performance
- state-mutation
- error-handling
- security
- api-contract
- test-coverage
