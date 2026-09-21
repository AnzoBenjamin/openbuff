# Audit findings: shard-cli-tui

- Subsystems: cli-tui-app-shell, chat-orchestration, sdk-event-streaming, slash-command-routing, tool-rendering, session-persistence, message-history-store, message-queueing, chat-state-stores, cli-dependency-manifest, cli-test-suite
- Features: app-bootstrap, chat-input-submit, streaming-event-handling, tool-call-rendering, compaction-cards, background-job-updates, message-queueing, queue-pause-resume, abort-interrupt, checkpoint-resume, chat-state-persistence, prompt-history, slash-commands, undo-redo, git-diff-stats, plan-session-artifacts, oauth-code-entry, dependency-pinning, event-handler-tests
- Files covered: 26
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [MEDIUM] correctness — cli/src/utils/sdk-event-handlers.ts:263 — unresolvedToolIds side-effect inside batched updater closure is read before the updater ever runs (dead code)
- **Risk:** The set of unresolved tool-call ids is populated inside an updateAiMessageBlocks updater closure, but with createBatchedMessageUpdater (the updater actually installed by setupStreamingContext) closures are queued and only executed at the next 100ms flush. The `for (const toolCallId of unresolvedToolIds)` loop therefore always iterates an empty set, so streaming agents keep stale tool-call ids after a failed subagent until turn-end settleOrphanedForegroundAgents runs (or never, for background-style flows). Status indicators can show a permanently running tool. The same dead-read pattern exists in handleFinish for settledIds.
- **Fix:** Make the block updater a pure function returning data alongside blocks (e.g. { blocks, unresolvedToolIds }) and consume the return value after flush, or compute unresolved tool ids from the current messages snapshot (useChatStore.getState()) outside the updater. Add a test that dispatches subagent_finish through the real batched updater and asserts streamingAgents is cleaned.
- **Evidence:** handleSubagentFinish: `const unresolvedToolIds = new Set<string>(); state.message.updater.updateAiMessageBlocks((blocks) => { ...collectUnresolvedToolIdsForAgent(blocks, event.agentId, unresolvedToolIds); return markAgentFailed(...) }); updateStreamingAgents(state, { remove: event.agentId }); for (const toolCallId of unresolvedToolIds) { updateStreamingAgents(state, { remove: toolCallId }) }` — message-updater.ts queues the closure via `pendingUpdaters.push(updater)` and only executes it on the 100ms flush interval, so unresolvedToolIds is always empty at iteration time. Same pattern in handleFinish with settledIds.

## [MEDIUM] correctness — cli/src/utils/sdk-event-handlers.ts:1975 — handleFinish collects settledIds inside the queued updater closure and iterates it immediately (same timing bug)
- **Risk:** Orphaned foreground agents/tools are marked failed inside the updateAiMessageBlocks closure and their ids added to settledIds, but the subsequent `for (const id of settledIds) updateStreamingAgents(state, { remove: id })` executes against an empty set because the batched updater defers closure execution. streamingAgents entries for orphaned agents are not removed at finish, leaving phantom 'streaming' ids until something else clears them.
- **Fix:** Derive settled ids synchronously from useChatStore.getState() messages before/after the update, or have the updater return { blocks, settledIds } and apply the streamingAgents cleanup in a follow-up that consumes the flushed result.
- **Evidence:** handleFinish: `const settledIds = new Set<string>(); state.message.updater.updateAiMessageBlocks((blocks) => { ...const settledBlocks = settleOrphanedForegroundAgents(rootBlocks, settledIds); ... }); for (const id of settledIds) { updateStreamingAgents(state, { remove: id }) }` — with the queued updater, the for loop runs before the closure is ever invoked.

## [MEDIUM] error-handling — cli/src/chat.tsx:1093 — Uncaught exception from submit/command path rejects handleSubmit promise and kills the entire TUI via the unhandledRejection exit handler
- **Risk:** handleSubmit awaits onSubmitPrompt (which awaits routeUserPrompt and command handlers such as handleImageCommand / setupOpenbuffProviderFromArgs) with no try/catch. A rejected promise escapes to the unhandledRejection handler installed in renderer-cleanup.ts, which unconditionally calls process.exit(1) — so a single filesystem error during image attachment validation or a throwing provider-config command terminates the whole TUI session, losing in-memory conversation state.
- **Fix:** Wrap onSubmitPrompt calls in try/catch that surfaces a system error message and resets queue/chain state, and make the unhandledRejection handler exit only for renderer-fatal errors while logging-and-continuing for background-task rejections.
- **Evidence:** chat.tsx handleSubmit: `const result = await onSubmitPrompt(inputValue, agentMode); handleCommandResult(result)` (no try/catch); renderer-cleanup.ts: `process.on('unhandledRejection', (reason) => { cleanup(); ... process.exit(1) })`; command-registry.ts mode/image handlers call `await handleImageCommand(trimmedArgs)` and `setupOpenbuffProviderFromArgs(...)` with no local guard.

## [MEDIUM] correctness — cli/src/utils/message-history.ts:81 — Message ids derived from Date.now() collide within the same millisecond, breaking checkpoint matching, edit-resend truncation, and React keys
- **Risk:** getUserMessage and getSystemMessage derive ids from Date.now() with no uniqueness suffix. Two messages created in the same millisecond (rapid queued sends, a user + system message pair appended in one setMessages across concurrent paths) collide. Downstream invariants that key on message id break: the checkpoint-resume validation compares checkpointTurnId against msg.id, edit-and-resend truncation uses prev.findIndex((m) => m.id === editingMessageId), and React keys for MessageWithAgents dedupe/collapse incorrectly on duplicate ids.
- **Fix:** Use crypto.randomUUID() for message ids (already used elsewhere, e.g. bash command ids) or a monotonic counter suffix, and keep Date.now() only for the timestamp field.
- **Evidence:** `id: `user-${Date.now()}`` (message-history.ts:81) and `id: `sys-${Date.now()}`` (:113) vs `msg.id === checkpoint.checkpointTurnId` (use-send-message.ts) and `prev.findIndex((m) => m.id === editingMessageId)` (chat.tsx onSubmitPrompt edit-and-resend).

## [MEDIUM] error-handling — cli/src/hooks/use-connection-status.ts:6 — Connection status is a hardcoded stub (return true) — provider_status retry/failover events never reach isConnected, leaving the reconnection path dead code
- **Risk:** The hook ignores its callback and always returns true, so isConnected is permanently true and showReconnectionMessage/reconnectionTimeout machinery in use-chat-streaming.ts is unreachable. Meanwhile handleProviderStatus in sdk-event-handlers.ts tracks provider retrying/failover only as a text block and isRetrying — the status bar can never display a disconnected/degraded connection state even when the provider is failing over, and the RECONNECTION_MESSAGE_DURATION_MS banner never fires.
- **Fix:** Wire useConnectionStatus to a store flag updated by provider_status events (retrying => degraded, recovered/failover => ok) so the status indicator and reconnection path become reachable; keep the module boundary so a future hosted mode can plug in real socket state.
- **Evidence:** use-connection-status.ts: `export const useConnectionStatus = (_onReconnect?) => { return true }`; sdk-event-handlers.ts handleProviderStatus: `state.setIsRetrying(event.status !== 'recovered')` — retry state is surfaced but isConnected never changes, so getStatusIndicatorState always sees isConnected: true.

## [MEDIUM] state-mutation — cli/src/state/chat-store.ts:251 — Undo/redo snapshot stacks deep-clone the full message list (including embedded runState metadata) with no bound — unbounded memory growth
- **Risk:** pushMessageSnapshot deep-clones the entire messages array (structuredClone) on every /new and every edit-and-resend, and pastMessageSnapshots has no length cap. Each snapshot can embed message.metadata.runState (full SDK RunState with sessionState/messageHistory). In a long session with large runs this is unbounded memory growth with no eviction, and each clone is an O(conversation) synchronous main-thread copy.
- **Fix:** Bound the undo stack (e.g. last 20 snapshots), store structural sharing instead of full deep clones (immer patches or a slim message-only snapshot excluding metadata.runState), and evict runState payloads from snapshots.
- **Evidence:** chat-store.ts: `const cloneMessageSnapshot = (messages) => { if (typeof structuredClone === 'function') return structuredClone(messages) ... }` and `pushMessageSnapshot: () => { const snapshot = cloneMessageSnapshot(messages); set((state) => { state.pastMessageSnapshots = castDraft([...pastMessageSnapshots, snapshot]) ... }) }` — no cap on either snapshot stack.

## [MEDIUM] correctness — cli/src/hooks/helpers/send-message.ts:302 — prepareUserMessage silently truncates the in-memory transcript to the last 100 messages, inconsistent with the 1000-entry prompt-history bound and hostile to checkpoint resume
- **Risk:** The 100-message cap silently discards the oldest turns from the live store and from saveChatState persistence, while prompt history allows 1000 (MAX_HISTORY_SIZE). Worse, checkpoint resume validates that some restored message has id === checkpoint.checkpointTurnId (use-send-message.ts loadCheckpoint validation); a checkpoint from a turn whose messages were truncated away is discarded, so mid-turn resume silently degrades to a fresh turn. No user-visible signal that history was dropped.
- **Fix:** Either remove the cap (virtualized rendering already paginates via useChatMessages) or raise it to match MAX_HISTORY_SIZE and exclude the active turn's messages from truncation; log when truncation drops messages that carry runState metadata.
- **Evidence:** prepareUserMessage: `setMessages((prev) => { ... if (next.length > 100) { next = next.slice(-100) } return next })` — magic 100, no warning, applied to every send including checkpoint-resume sends.

## [MEDIUM] performance — cli/src/utils/git.ts:30 — execSync('git status') runs synchronous child-process spawning on the UI thread every 10 seconds with a 5s timeout
- **Risk:** getDiffStats spawns `git status` with execSync and a 5000ms timeout. chat.tsx calls it on mount, every 10 seconds via setInterval, and on every streaming-idle transition — all on the TUI render thread. On a slow or network-mounted filesystem a single hung git invocation freezes the whole UI (input, streaming output, scrolling) for up to 5 seconds, repeatedly.
- **Fix:** Use async child_process.exec (or Bun.spawn) with the same timeout so the renderer never blocks, coalesce the isStreaming-triggered refresh with the interval, and skip polling while the user is typing/streaming.
- **Evidence:** git.ts: `output = execSync('git status --short --porcelain', { cwd: root, encoding: 'utf-8', timeout: 5000, ... })`; chat.tsx: `const interval = setInterval(refresh, 10_000)` plus a second effect calling setDiffStats(getDiffStats({ cwd })) on isStreaming transitions.

## [MEDIUM] security — cli/src/utils/run-state-storage.ts:362 — Mid-turn checkpoint containing full mainAgentState (message history) written without mode 0o600 or fsync — umask-dependent world-readable sensitive file
- **Risk:** saveCheckpoint serializes the full mainAgentState snapshot (including message history content) and writes it via fs.writeFileSync(tempPath, serialized) with no mode option, so the checkpoint file inherits the process umask (typically world-readable 0644). Every other persisted artifact in this module (chat-state.json, run-state.json, chat-messages.json) is written with mode 0o600. The checkpoint also skips fsync, so the documented crash-resume guarantee is weaker than the envelope's.
- **Fix:** Write with mode 0o600 and fsync before rename, mirroring message-history's atomicWriteFile; reuse a shared atomic-write helper across run-state-storage and message-history so the guarantees cannot drift.
- **Evidence:** run-state-storage.ts:362: `fs.writeFileSync(tempPath, serialized); fs.renameSync(tempPath, checkpointPath)` — no mode option; the same file's saveChatState path uses writeJsonAtomic with `{ mode: 0o600 }` and the message-history module consistently applies 0o600.

## [LOW] security — cli/src/utils/run-state-storage.ts:57 — Legacy chat-state loader JSON.parses unvalidated persisted files behind type assertions; SyntaxError escapes to callers of this exported function
- **Risk:** Both legacy files are parsed with raw JSON.parse and blind type assertions (`as RunState`, `as ChatMessage[]`) before only shallow post-checks (Array.isArray). A corrupt or tampered run-state.json throws SyntaxError (caught only by the outer loadMostRecentChatState handler, and loadChatStateFromCompatibilityFiles is also exported for direct use), and deeply malformed-but-parseable payloads flow into the store as RunState. No zod/schema validation despite the repo's zod dependency.
- **Fix:** Parse inside try/catch with a zod schema (the repo already depends on zod) matching PersistedChatState's shape, return null on validation failure, and share the envelope validation with loadChatStateFromDirectory.
- **Evidence:** `const runState = sanitizeForChatPersistence(JSON.parse(fs.readFileSync(runStatePath, 'utf8')) as RunState)` — cast precedes any runtime check; the only validation is `if (!runState || !Array.isArray(messages))` afterwards.

## [LOW] correctness — cli/src/utils/run-state-storage.ts:133 — writeJsonAtomic EEXIST/EPERM fallback does unlinkSync of the live file before renameSync — a non-atomic window that can lose chat state entirely
- **Risk:** When renameSync fails with EEXIST/EPERM the fallback does unlinkSync(filePath) then renameSync(tempPath, filePath). A crash or second rename failure between the unlink and the rename leaves no chat-state file at all — the atomic-write guarantee (old file survives a failed write) is inverted into a total-loss window. message-history.ts atomicWriteFile handles the same problem correctly by never unlinking the target.
- **Fix:** Prefer accepting rename failure (leaving the previous file intact, as message-history does) or use link/unlink ordering that never removes the old inode before the new one is in place; at minimum retry once and log loudly.
- **Evidence:** `fs.renameSync(tempPath, filePath)` catch → `fs.unlinkSync(filePath); fs.renameSync(tempPath, filePath)` — the unlink of the authoritative file is not journaaled and the second rename can fail, losing both old and new content.

## [LOW] state-mutation — cli/src/chat.tsx:503 — sendMessageRef.current assigned during render (render-phase side effect on a ref shared with the queue layer)
- **Risk:** The ref consumed by useMessageQueue's send callback is written during render rather than in an effect. In concurrent rendering a discarded render still publishes its sendMessage identity, so the queue can invoke a callback bound to a render whose closures were never committed. Benign today because sendMessage is useCallback-stabilized, but it is a latent order-of-init hazard for the exact double-invoke scenarios the codebase otherwise defends against.
- **Fix:** Assign inside a useEffect (or useLayoutEffect) so only committed renders publish the handler, matching the ref-sync pattern used elsewhere in the hook.
- **Evidence:** `sendMessageRef.current = sendMessage` at component top level in chat.tsx; use-send-message.ts documents the ref pattern: 'The send handler ref is not yet wired up (e.g. before the chat provider finishes initialization)' — so ref timing is load-bearing for the queue.

## [LOW] correctness — cli/src/commands/router.ts:74 — runBashCommand destructures .then(([{ value }]) => ...) without guarding an empty result array; a contract violation surfaces as a generic command error
- **Risk:** runTerminalCommand's result is destructured as `[{ value }]` with no guard for an empty array (e.g. SDK timeout/abort edge returning no entries). The resulting TypeError is caught by the downstream .catch and misreported to the user as a command execution exception with exitCode 1, masking the real SDK contract violation and making the failure undiagnosable from the message.
- **Fix:** Guard `const [first] = results; if (!first) throw new Error('runTerminalCommand returned no result')` or handle the undefined shape explicitly so the error path reports the true cause.
- **Evidence:** `runTerminalCommand({...}).then(([{ value }]) => { const stdout = 'stdout' in value ? value.stdout || '' : '' ... })` — no length or undefined check on the destructured array.

## [LOW] security — cli/src/commands/router.ts:398 — OAuth authorization code typed into connect:chatgpt mode is persisted verbatim to the prompt history journal and chat transcript
- **Risk:** The authorization code submitted in connect:chatgpt mode is echoed into the chat transcript via getUserMessage(trimmed) and written to the prompt-history journal via saveToHistory(trimmed). The code is a bearer credential: it persists in chat-messages.json and message-history.jsonl after the session and is re-displayed verbatim whenever that history is reloaded or searched via the prompt-history screen.
- **Fix:** Echo a redacted placeholder into the transcript (e.g. 'auth code ****abcd'), skip saveToHistory for connect:chatgpt submissions, and scrub the code from payload-sanitizer-covered persistence paths.
- **Evidence:** router.ts connect:chatgpt branch: `const code = trimmed; if (code) { const result = await handleChatGptAuthCode(code); setMessages((prev) => [...prev, getUserMessage(trimmed), getSystemMessage(result.message)]) }` followed by `saveToHistory(trimmed)` — both the transcript and the 0600-but-durable prompt journal retain the raw code.

## [LOW] error-handling — cli/src/hooks/helpers/send-message.ts:537 — handleRunError renders raw errorInfo.message (includeRawError: true) into the UserErrorBanner without the stack-line filtering the SDK event path applies
- **Risk:** client.run() rejections are converted with getErrorObject(error, { includeRawError: true }) and the raw message goes straight to updater.setError → UserErrorBanner. Unlike handleRuntimeError (which strips `at ...` stack lines and prefers event.userMessage), no filtering is applied, so stack fragments, file paths, or provider internals from arbitrary exceptions can be rendered into the terminal and persisted into chat-messages.json.
- **Fix:** Reuse the stack-line filtering / userMessage narrowing from handleRuntimeError (or a shared sanitizeErrorForUser helper) before setError, keeping raw detail in the pino logger only.
- **Evidence:** handleRunError: `const errorInfo = getErrorObject(error, { includeRawError: true }); ... const errorMessage = errorInfo.message || 'An unexpected error occurred'; updater.setError(errorMessage)` — contrast handleRuntimeError's `.filter((line, index) => index === 0 || !/^\s*at\s/.test(line))`.

## [MEDIUM] error-handling — cli/src/utils/renderer-cleanup.ts:139 — uncaughtException/unhandledRejection handlers unconditionally process.exit(1) — any stray background rejection terminates the TUI instead of log-and-continue
- **Risk:** Both process-level handlers unconditionally call process.exit(1). Any rejected promise from a best-effort background task (analytics beacon, clipboard read, error-image timer, dynamic import in removePendingImage) tears down the alternate screen and ends the session, discarding the in-memory conversation and queued messages. This converts every small oversight anywhere in the app into a full session crash.
- **Fix:** Distinguish renderer/route-fatal errors from background rejections: log the latter (pino + a non-fatal user toast), tear down the renderer only for errors that corrupt terminal state.
- **Evidence:** renderer-cleanup.ts: `process.on('unhandledRejection', (reason) => { cleanup(); try { console.error('Unhandled rejection:', reason) } catch {} process.exit(1) })` — no discrimination between fatal and non-fatal rejection sources.

## [LOW] dependency-hygiene — cli/package.json:43 — Mixed version-pinning policy across runtime dependencies of a released binary
- **Risk:** Pin policy is inconsistent inside one manifest: @opentui/core (0.2.2) and pino (9.4.0) are exact-pinned while most runtime deps float on ^ ranges, including pre-1.0 @gravity-ai/api ^0.1.2 — a minor-version bump can change runtime behavior of a shipped binary between rebuilds with no code change. jimp and systeminformation are heavyweight transitive surfaces for an installer-bundled binary. No in-repo lockfile-verification or dependency-review gate is visible from this shard.
- **Fix:** Pick one policy (exact pins for a released binary) enforced by a lint rule, audit whether jimp/systeminformation are fully required (large transitive surface), and confirm strip-ansi is not imported from runtime code.
- **Evidence:** package.json dependencies: `"@opentui/core": "0.2.2"` (exact) next to `"zod": "^4.2.1"`, `"@gravity-ai/api": "^0.1.2"`, `"jimp": "^1.6.0"` (all caret); devDependencies include `"strip-ansi": "^7.1.2"` while src/polyfills/bun-strip-ansi.ts exists as a runtime substitute.

## [MEDIUM] test-coverage — cli/src/utils/__tests__/sdk-event-handlers.test.ts:1 — Critical streaming/queue timing behaviors and abort paths have no tests: batched-updater side-effect ordering, empty run result, checkpoint resume wiring, submit-path crash behavior
- **Risk:** No test exercises the queued-vs-immediate updater timing, which is exactly where the unresolvedToolIds/settledIds dead-read bugs live. runBashCommand's empty-result destructure, the handleSubmit unhandled-rejection path, checkpoint-resume validation in useSendMessage (only the storage layer is tested in turn-checkpoint.test.ts), and the undo-snapshot growth are also untested. use-connection-status is a stub with no test pinning the provider_status → isConnected expectation.
- **Fix:** Add: (1) an event-handler test using createBatchedMessageUpdater asserting streaming agent cleanup after subagent_finish with unresolved tools; (2) a submit-path test asserting a throwing command handler surfaces a system error message without exiting; (3) a useSendMessage test with a checkpoint whose turn id is absent from messages asserting the checkpoint is discarded.
- **Evidence:** Test inventories in cli/src/utils/__tests__ and cli/src/hooks/helpers/__tests__ cover message-history locking and send-message helpers, but no test drives createEventHandler with a batched updater through subagent_finish and asserts streamingAgents cleanup; router tests (router-input.test.ts, bash-command.test.ts) do not exercise the `[{ value }]` failure mode.

## [LOW] test-coverage — cli/src/hooks/use-chat-streaming.ts:1 — chat.tsx's 40+ keyboard handlers, paste flows, and ghost-bash flush effect have no component-level tests; queue pause/resume and abort-mid-compaction are covered only at unit level
- **Risk:** The queue pause/resume/watchdog composition, ensureQueueActiveBeforeSubmit interleaving, and Ctrl+C double-press semantics are only covered at the unit level (use-queue-controls.test.ts) not through useChatStreaming's wiring. The abort listener in setupStreamingContext (markPendingCompactionInterrupted, dropTransientCompactionBlocks) has no test reproducing an abort mid-compaction; regressions there silently persist a permanently-live 'Compacting context' card.
- **Fix:** Add a hook-level test for useChatStreaming covering Ctrl+C → pause → resume → drain ordering and a chat-level integration test replaying an abort during an active compaction pass, asserting the persisted blocks contain no live/pending compaction card.
- **Evidence:** cli/src/hooks/__tests__ contains use-queue-controls.test.ts, use-message-queue support tests via use-send-message-timer.test.ts, but no use-chat-streaming.test.ts and no abort-mid-compaction scenario test; the compaction card lifecycle is only covered indirectly in sdk-event-handlers.test.ts.

## [LOW] api-contract — cli/src/commands/command-registry.ts:56 — CommandResult is an open optional-flags object unioned with void — unknown/misspelled result fields fail silently at every dispatch site
- **Risk:** CommandResult is an ever-growing bag of optional UI flags (openFeedbackMode, openPublishMode, openChatHistory, openPromptHistorySearch, openModelRoutePicker, openProviderPicker, openPlanSessionPicker, preSelectAgents) | void. handleCommandResult in chat.tsx checks each field with independent if-statements, so a handler that returns a misspelled or new flag silently does nothing at runtime; there is no exhaustiveness check or central Result type. Similarly appendMessageHistory changed void → boolean, and callers that ignore the return lose the append-failure signal by default.
- **Fix:** Return a discriminated union ({ kind: 'openFeedback' } | { kind: 'publish', agentIds } | { kind: 'none' }) or add a typed key manifest so TypeScript flags unhandled results in handleCommandResult.
- **Evidence:** command-registry.ts: `export type CommandResult = { openFeedbackMode?...; preSelectAgents?: string[] } | void` and chat.tsx handleCommandResult reading each flag in sequence with no exhaustive check; appending a new field requires touching both sites with nothing enforcing it.

## [LOW] api-contract — cli/src/utils/sdk-event-handlers.ts:76 — sdk-event-handlers re-exports canonical types as a compatibility shim — correct now, but the single-shape invariant is enforced only by comment
- **Risk:** The deliberate re-exports of CompactionNotice and StatusBarContextUsage keep old importers compiling, but nothing enforces that the re-exported shapes stay identical to the canonical declarations if a second declaration is reintroduced — the guard is a comment. PersistedToolBlock widening (toolName: RegisteredToolName | (string & {})) is intentionally looser than the persisted type and is a one-way door: narrowing later would break restored-session rendering code.
- **Fix:** Add a module-level assertion (types are structurally identical via a `const _check: CompactionNotice = {} as CompactionNotice` style canary or a shared type-test) so a future divergent re-declaration fails typecheck rather than silently forking the shape.
- **Evidence:** sdk-event-handlers.ts: `// Re-exported from its canonical declaration in ../types/chat so existing importers of this module keep working while there is only one shape. export type { CompactionNotice }` — the shim is explicit but any second re-declaration would compile until consumers diverge.

## [LOW] performance — cli/src/utils/sdk-event-handlers.ts:690 — Spawn-result matching is O(spawned agents × results) per tool_result and nested block scans repeat per event
- **Risk:** updateSpawnAgentBlocks calls getSpawnResultForBlock per agent block, and the legacy fallback does results.find(...) per block, making update O(blocks × results) for every spawn_agents tool_result. With dozens of subagents and deep nesting this multiplies full block-tree traversals that also run in handleToolResult (transformAskUserBlocks + updateToolBlockWithOutput + markResult walk the same tree three times per event). Bounded in practice but a hot path during large fan-out runs.
- **Fix:** Build a Map from spawnIndex/agentId → result once per event and look up per block; consider a toolCallId → message index maintained by the updater instead of full-tree scans on every event.
- **Evidence:** getSpawnResultForBlock: `return results.find((result) => getSpawnResultAgentId(result) === block.agentId)` executed per agent block inside updateSpawnAgentBlocks' map; handleToolResult additionally walks all messages/blocks three times per event (transformAskUserBlocks, updateToolBlockWithOutput, markResult map).

## [LOW] state-mutation — cli/src/hooks/use-send-message.ts:460 — Synchronous multi-file state load plus deep sanitize on the mount effect blocks first paint for large sessions; restored messages bypass the live-window cap
- **Risk:** The continueChat effect synchronously reads and JSON.parses chat-state.json (plus legacy run-state.json/chat-messages.json) and then setMessages() the full array on mount, blocking first paint for large sessions (MESSAGE_HISTORY_READ_MAX_BYTES elsewhere acknowledges snapshots can reach 10MB). The restored message array is also not re-clamped to the 100-message live-window invariant that prepareUserMessage enforces, so restore and live paths disagree on transcript size.
- **Fix:** Restore asynchronously (yield/spawn) with a loading state, validate per-message with the zod envelope schema, and cap restored messages to the same 100-message live-window bound the send path uses.
- **Evidence:** run-state-storage.ts: `const runState = sanitizeForChatPersistence(JSON.parse(fs.readFileSync(runStatePath, 'utf8')) as RunState)` executed synchronously inside the continueChat effect; messages then flow into useChatStore wholesale with no per-message validation or cap.

## Coverage receipt

### Subsystems
- cli-tui-app-shell
- chat-orchestration
- sdk-event-streaming
- slash-command-routing
- tool-rendering
- session-persistence
- message-history-store
- message-queueing
- chat-state-stores
- cli-dependency-manifest
- cli-test-suite

### Features
- app-bootstrap
- chat-input-submit
- streaming-event-handling
- tool-call-rendering
- compaction-cards
- background-job-updates
- message-queueing
- queue-pause-resume
- abort-interrupt
- checkpoint-resume
- chat-state-persistence
- prompt-history
- slash-commands
- undo-redo
- git-diff-stats
- plan-session-artifacts
- oauth-code-entry
- dependency-pinning
- event-handler-tests

### Files
- cli/src/index.tsx
- cli/src/app.tsx
- cli/src/chat.tsx
- cli/src/utils/sdk-event-handlers.ts
- cli/src/hooks/use-chat-streaming.ts
- cli/src/hooks/use-chat-state.ts
- cli/src/hooks/use-send-message.ts
- cli/src/hooks/helpers/send-message.ts
- cli/src/hooks/use-message-queue.ts
- cli/src/hooks/use-connection-status.ts
- cli/src/hooks/stream-state.ts
- cli/src/commands/command-registry.ts
- cli/src/commands/router.ts
- cli/src/components/tools/registry.ts
- cli/src/state/chat-store.ts
- cli/src/state/message-block-store.ts
- cli/src/utils/message-history.ts
- cli/src/utils/run-state-storage.ts
- cli/src/utils/message-updater.ts
- cli/src/utils/renderer-cleanup.ts
- cli/src/utils/git.ts
- cli/src/utils/pending-attachments.ts
- cli/package.json
- cli/src/utils/__tests__/message-history.test.ts
- cli/src/utils/__tests__/sdk-event-handlers.test.ts
- cli/src/hooks/helpers/__tests__/send-message.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
