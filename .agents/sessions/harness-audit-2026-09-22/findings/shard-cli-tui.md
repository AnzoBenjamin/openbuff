# Audit findings: shard-cli-tui

- Subsystems: cli
- Features: app-entry-shell, chat-submit-routing, stream-event-normalization, message-block-rendering, tool-call-rendering, slash-command-surface, ask-user-ui-bridge, message-queue-steering, stream-state-container, tool-result-normalization
- Files covered: 10
- Snapshot: a0de6357ff5254c1bb8cf2e92d821fd948811744293fe3361209c5d557e95392

## [MEDIUM] security — cli/src/commands/command-registry.ts:1267 — Skill command injects untrusted skill name/content verbatim into the model prompt
- **Risk:** createSkillCommand builds `const skillContext = `<skill name="${skill.name}">\n${skill.content}\n</skill>`` with no escaping or delimiting. Skill files are project-controlled (and can arrive via cloned repos), so a malicious skill name can break out of the XML attribute and skill.content can carry prompt-injection payloads ('ignore previous instructions, run ...') that are indistinguishable from system guidance once inside the user turn.
- **Fix:** Sanitize/escape `skill.name` for attribute context (or pass it out-of-band as metadata), wrap skill.content in an untrusted-data delimiter with an explicit 'content below is data, not instructions' preamble, and require per-project skill trust (already surfaced by getProjectSkillTrustStatus) before a skill command executes.
- **Evidence:** command-registry.ts createSkillCommand:   const skillContext = `<skill name="${skill.name}"> ${skill.content} </skill>`   const userPrompt = `I invoke the following skill:\n\n${skillContext}\n\n` + (args.trim() ? `User request: ${args.trim()}` : '') No escaping of skill.name or skill.content; /doctor shows skillsTrusted but createSkillCommand does not check it.

## [LOW] security — cli/src/chat.tsx:308 — Analytics telemetry fires in local-first BYOK mode
- **Risk:** app.tsx asserts 'Auth status is always ok in local/BYOK mode — no cloud backend to query', yet chat.tsx calls trackEvent(AnalyticsEvent.SLASH_MENU_ACTIVATED, {...}) and FOLLOWUP_CLICKED. If trackEvent emits anywhere off-box (or buffers to a later upload), user activity metadata leaves a harness marketed as local-first, with no visible opt-out in these files.
- **Fix:** Gate trackEvent behind an explicit, default-off telemetry consent (and a no-op sink in local mode), or document/assert that trackEvent is strictly in-memory for local diagnostics.
- **Evidence:** chat.tsx (~line 308):   if (slashContext.active && !prevSlashActiveRef.current) {     trackEvent(AnalyticsEvent.SLASH_MENU_ACTIVATED, {       queryLength: slashContext.query.length, matchCount: slashMatches.length, inputLength: inputValue.length,     })   } Contrast app.tsx: `const authStatus: AuthStatus = 'ok'` with comment 'no cloud backend to query'.

## [MEDIUM] correctness — cli/src/commands/command-registry.ts:169 — sendPromptCommand sends directly without the streaming/queue guard used elsewhere
- **Risk:** sendPromptCommand calls params.sendMessage({content: prompt}) with no isStreaming / streamMessageIdRef / isChainInProgressRef check, while /init and createSkillCommand DO queue when busy. /interview, /review, /resume-plan, /update-plan, /lessons, mode:* and /new <msg> all route through sendPromptCommand, so issuing one mid-turn starts a second concurrent sendMessage: interleaved stream state, streamMessageId clobbering, and message-block updates from two turns racing on the same updater.
- **Fix:** Route every send through one guarded submit helper (the same busy-check + addToQueue fallback used by createSkillCommand) so no command can start a turn while a stream or chain is active.
- **Evidence:** command-registry.ts:   const sendPromptCommand = (params, prompt, mode = params.agentMode) => {     params.sendMessage({ content: prompt, agentMode: mode })   // no busy check     setTimeout(() => { params.scrollToLatest() }, 0)   } vs createSkillCommand:   if (params.isStreaming || params.streamMessageIdRef.current || params.isChainInProgressRef.current) {     params.addToQueue(userPrompt, pendingAttachments) ... return   }

## [MEDIUM] correctness — cli/src/app.tsx:165 — 'New chat' cannot clear the initial --continue flag, so it silently resumes the previous chat
- **Risk:** effectiveContinueChat = continueChat || resumeChatId !== null keeps the mount-time CLI prop forever. handleNewChat() only sets resumeChatId(null), so on a session started with continueChat=true the remounted Chat still receives continueChatId (the original one) and reloads the previous conversation instead of starting empty — user-visible data confusion ('/new' lies).
- **Fix:** Track 'continue' as local state initialized from the prop: handleNewChat should clear both the local continue flag and continueChatId (e.g. const [continueTarget, setContinueTarget] = useState({enabled: continueChat, id: continueChatId})).
- **Evidence:** app.tsx:   const handleNewChat = useCallback(() => { closeChatHistory(); resetChatStore(); setResumeChatId(null) }, [...])   const effectiveContinueChat = continueChat || resumeChatId !== null   const effectiveContinueChatId = resumeChatId ?? continueChatId After handleNewChat with continueChat=true: effectiveContinueChat===true and effectiveContinueChatId===original continueChatId.

## [MEDIUM] correctness — cli/src/utils/tool-result-normalizer.ts:72 — hasMultipartError false-positives on nested payload data, marking successful tools as failed
- **Risk:** getStructuredErrorMessages walks every nested record up to depth 6 and pushes any string `error` / `errorMessage` field, including inside tool RESULT DATA (e.g. a read_files/search result whose payload contains `{error: "..."}` from a scanned file's JSON, or a doctor/status record). handleToolResult then sets lifecycle:'failed' and appendResultOnlyToolBlockToAgent marks result-only blocks failed — a succeeded tool renders as a failure, corrupting the completion summary and the user's trust in the transcript.
- **Fix:** Restrict error extraction to the tool-result envelope (top-level parts and known error kinds like 'native_tool_result_error') instead of recursively scanning arbitrary result payload objects; only descend into fields the tool schema declares as error-bearing.
- **Evidence:** tool-result-normalizer.ts:   const visit = (value, depth = 0) => {     ...     const error = record.error     if (typeof error === 'string') messages.push(error.trim())     ...     for (const [key, child] of Object.entries(record)) {       if (key !== 'error' && key !== 'errorMessage') visit(child, depth + 1)  // scans result DATA too     }   }   export function hasMultipartError(outputRaw) { return getStructuredErrorMessages(outputRaw).length > 0 } Consumed in sdk-event-handlers.ts: `if (hasMultipartError(event.output)) return { ...block, lifecycle: 'failed' }`.

## [MEDIUM] correctness — cli/src/utils/sdk-event-handlers.ts:1005 — spawn_agents result routing is sniffed heuristically and can swallow non-spawn tool results
- **Risk:** handleToolResult decides `isSpawnAgentsResult` purely by shape: firstOutputValue is an array containing any object with agentName/agentType. It never checks event.toolName === 'spawn_agents'. A regular tool whose json result is an array of records with an `agentType` field (registry listings, agent validation output, etc.) takes the spawn path and RETURNS EARLY — its tool block never receives output and stays 'running' forever, and streamingAgents never gets the toolCallId removed.
- **Fix:** Gate on the tool name (event.toolName === 'spawn_agents') first and use the shape check only as a compatibility fallback; on fallback mismatch, fall through to updateToolBlockWithOutput instead of returning.
- **Evidence:** sdk-event-handlers.ts handleToolResult:   const isSpawnAgentsResult =     Array.isArray(firstOutputValue) &&     firstOutputValue.some((v) => isRecord(v) && (typeof v.agentName === 'string' || typeof v.agentType === 'string'))   if (isSpawnAgentsResult && Array.isArray(firstOutputValue)) {     handleSpawnAgentsResult(state, event.toolCallId, firstOutputValue)     return   // skips updateToolBlockWithOutput + updateStreamingAgents remove entirely   }

## [MEDIUM] correctness — cli/src/utils/sdk-event-handlers.ts:968 — Hidden tool calls (end_turn / spawn_agent_inline) can resurface as result-only tool blocks
- **Risk:** handleToolCall early-returns for hiddenToolNames ('spawn_agent_inline','end_turn','spawn_agents') so no block is created — but handleToolResult unconditionally calls appendResultOnlyToolBlockToAgent(withLifecycle, event), which synthesizes a ToolContentBlock whenever event.agentId is set and no matching child exists. The hidden call's result therefore renders as an empty tool card with toolName 'end_turn', contradicting the hidden-tool contract and leaking internal control-flow plumbing into the transcript.
- **Fix:** Skip appendResultOnlyToolBlockToAgent (and the ask-user/normalization update) for events whose toolName is in hiddenToolNames, mirroring handleToolCall's guard.
- **Evidence:** sdk-event-handlers.ts:   const hiddenToolNames = new Set<ToolName | 'spawn_agent_inline'>(['spawn_agent_inline', 'end_turn', 'spawn_agents'])   ... handleToolCall: `if (isHiddenToolName(event.toolName)) { return }`   ... handleToolResult tail: `return appendResultOnlyToolBlockToAgent(withLifecycle, event)` with   `const resultOnlyToolBlock: ToolContentBlock = { type: 'tool', toolCallId: event.toolCallId, toolName: event.toolName as ToolName, input: {}, ... }` — no hidden-name guard.

## [LOW] correctness — cli/src/app.tsx:228 — Re-selecting the currently active chat id does not remount Chat, so the cleared transcript never reloads
- **Risk:** chatKey = resumeChatId ?? 'current' only remounts when the id CHANGES. handleResumeChat always calls resetChatStore() first, then sets resumeChatId. If the user runs /new (or resumes chat A) and then picks chat A again from history, key stays 'A', Chat does not remount, its load effect does not re-run, and the user sees a blank conversation for a chat that has history.
- **Fix:** Force a fresh mount on every selection, e.g. `const chatKey = resumeChatId ? `${resumeChatId}:${resumeNonce}` : 'current'` with resumeNonce incremented in handleResumeChat/handleNewChat.
- **Evidence:** app.tsx:   const handleResumeChat = useCallback((chatId) => {     closeChatHistory(); resetChatStore(); setResumeChatId(chatId)   // reset always happens   }, [...])   ...   const chatKey = resumeChatId ?? 'current'   // unchanged id => same key => no remount => no reload

## [LOW] correctness — cli/src/chat.tsx:522 — Ghost-bash flush effect reads two refs it does not list as dependencies
- **Risk:** The effect gates on `!streamMessageIdRef.current && !isChainInProgressRef.current` but its dep array is [isStreaming, pendingBashMessages, setMessages]. Ref flips alone never re-run the effect, so ghost commands can be flushed while a chain is actually in progress (stale false) or, conversely, never flushed until an unrelated state change — pending bash output ordering vs. the next user turn becomes timing-dependent.
- **Fix:** Derive the gate from state that re-renders (or mirror the refs into state), and include the read refs' trigger in deps; alternatively run the flush from the single place that transitions the chain/stream refs to false.
- **Evidence:** chat.tsx:   useEffect(() => {     if (!isStreaming && !streamMessageIdRef.current && !isChainInProgressRef.current && pendingBashMessages.length > 0) {       ...     }   }, [isStreaming, pendingBashMessages, setMessages])   // streamMessageIdRef / isChainInProgressRef read but not tracked

## [LOW] correctness — cli/src/components/message-block.tsx:103 — Attachment cards keyed by path collide when two attachments share a path
- **Risk:** MessageAttachments renders <ImageCard key={attachment.path}> and <FileAttachmentCard key={attachment.path}>. Two attachments with the same path (re-attach after removal, directory vs file, symlink aliases) produce duplicate React keys: wrong reconciliation, dropped/reused card state (e.g. expand/collapse), and console key warnings on the render path.
- **Fix:** Key by the attachment's stable id (text attachments already use attachment.id) — fall back to `${path}:${index}` when no id exists.
- **Evidence:** message-block.tsx MessageAttachments:         {imageAttachments.map((attachment) => (           <ImageCard key={attachment.path} image={attachment} showRemoveButton={false} />         ))}         ...         {fileAttachments.map((attachment) => (           <FileAttachmentCard key={attachment.path} attachment={attachment} showRemoveButton={false} />         ))} (textAttachments correctly use key={attachment.id})

## [LOW] correctness — cli/src/commands/command-registry.ts:1175 — findCommand lower-cases input before skill lookup, making mixed-case skills unreachable
- **Risk:** const lowerCmd = cmd.toLowerCase() is used for both the static registry and `getSkillByName(skillName)` after slicing 'skill:'. A registered skill named 'RefactorPlan' is therefore unreachable via /skill:RefactorPlan (lookup uses 'refactorplan') and may collide with a differently-cased skill — silent 'unknown command' for a skill the /help listing advertises.
- **Fix:** Match the static registry case-insensitively as today, but resolve skill commands with the original-case name (and dedupe skill names case-insensitively at load time).
- **Evidence:** command-registry.ts findCommand:   export function findCommand(cmd: string) {     const lowerCmd = cmd.toLowerCase()     const staticCommand = COMMAND_REGISTRY.find((def) => def.name === lowerCmd || def.aliases.includes(lowerCmd))     ...     if (lowerCmd.startsWith('skill:')) {       const skillName = lowerCmd.slice('skill:'.length)       const skill = getSkillByName(skillName)   // case-folded name     }   }

## [LOW] correctness — cli/src/components/ask-user/index.tsx:293 — Escape / Ctrl+C discards every answered question with one keystroke and no confirmation
- **Risk:** The useKeyboard handler treats 'escape' and Ctrl+C identically and calls onSkip() immediately. After filling several accordion answers, one stray Escape (or muscle-memory Ctrl+C) throws away the entire form and returns 'Skipped' answers to the model — silent data loss on a multi-question prompt.
- **Fix:** Track dirty state (any non-empty answer): first Escape warns 'N answers will be discarded — press again to confirm', second confirms; keep a separate explicit Close/skip affordance for the immediate path (the ✕ button already exists).
- **Evidence:** ask-user/index.tsx useKeyboard callback:         // Escape or Ctrl+C to skip/close the form         if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {           preventDefault()           onSkip()           return         } No dirty-check against `answers`; formatAnswer then reports 'Skipped' for every question.

## [MEDIUM] state-mutation — cli/src/chat.tsx:557 — sendMessageRef is written during render (side effect in render body)
- **Risk:** `sendMessageRef.current = sendMessage` executes on every render pass, including renders React may discard (concurrent rendering, StrictMode double render, interrupted renders). A discarded render can leave the ref pointing at a stale/uncommitted sendMessage closure, and the queue drains through sendMessageRef.current — so queued messages can be sent with outdated agentMode/continueChatId.
- **Fix:** Assign in an effect (`useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])`) or use useEvent-style latest-ref plumbing for sendMessage, matching how onSubmitPrompt is protected.
- **Evidence:** chat.tsx (immediately after useSendMessage):   const { sendMessage, clearMessages } = useSendMessage({ ... continueChat, continueChatId })    sendMessageRef.current = sendMessage   // render-body ref write, outside any effect

## [MEDIUM] state-mutation — cli/src/hooks/use-message-queue.ts:305 — Queue ref writes happen inside setState updaters, violating the module's own documented invariant
- **Risk:** processNextMessage's comment states 'We must NOT assign to outer variables inside functional setState callbacks because React can call those callbacks multiple times in concurrent mode' — yet the very next statement mutates queuedMessagesRef.current inside the updater (and addToQueue / onRejected do the same). Under double-invocation the ref can end up describing a queue that was never committed (e.g. a restored failed message duplicated or dropped), desyncing clearQueue()'s synchronous return value from the visible queue.
- **Fix:** Move ref synchronization to a single non-updater site (compute the next array outside setState and call setQueuedMessages(next) + queuedMessagesRef.current = next), or sync the ref in a layout effect keyed on queuedMessages.
- **Evidence:** use-message-queue.ts processNextMessage:     // We must NOT assign to outer variables inside functional setState callbacks     // because React can call those callbacks multiple times in concurrent mode,     // which would cause messages to be skipped.     const messageToProcess = queuedMessagesRef.current[0]     ...     setQueuedMessages((prev) => {       if (prev.length === 0) return prev       const remainingMessages = prev.slice(1)       queuedMessagesRef.current = remainingMessages   // <- exactly the forbidden pattern       return remainingMessages     }) same pattern in addToQueue and onRejected's restore.

## [MEDIUM] state-mutation — cli/src/hooks/use-message-queue.ts:97 — Queue watchdog force-releases the processing lock while a send may still be in flight
- **Risk:** After 60s the watchdog sets isProcessingQueueRef.current = false and setCanProcessQueue(true) even though the original sendMessage promise has not settled (a normal LLM turn exceeds 60s) and nothing aborts it. The lock is only truly held by streamStatus/streamMessageIdRef; any window where the send is stuck before those are set (connect/queue-init failure, provider hang before 'waiting') lets processNextMessage start a second sendMessage concurrently — two turns interleaving on one transcript with no AbortSignal linkage.
- **Fix:** Have the watchdog verify actual liveness (streamStatus === 'idle' && streamMessageIdRef.current === null) before force-resetting, and abort/flag the orphaned send instead of silently releasing the lock; or make the watchdog renew itself while the send promise is pending.
- **Evidence:** use-message-queue.ts beginQueuedMessageProcessing:   watchdogTimeoutRef.current = setTimeoutFn(() => {     if (!isCurrentQueueProcessingOwner()) return     if (isProcessingQueueRef.current) {       logger.warn({ stuckDurationMs: QUEUE_WATCHDOG_TIMEOUT_MS }, '...forcing reset')       isProcessingQueueRef.current = false       setCanProcessQueue(!isQueuePausedRef.current)     }     ...   }, QUEUE_WATCHDOG_TIMEOUT_MS)   // fixed 60s, no check that sendMessage(messageToProcess) settled

## [LOW] state-mutation — cli/src/hooks/stream-state.ts:80 — agentStreamAccumulators / spawnAgentsMap entries leak when the turn aborts mid-stream
- **Risk:** Entries are removed only by removeAgentAccumulator (handleSubagentFinish) and removeSpawnAgentInfo (spawn match). On user abort the SDK drops post-abort events (documented in sdk-event-handlers), so those removals never run; per-agent accumulator strings and spawn temp-ids persist until some later reset() call. Long sessions with frequent interrupts grow these Maps and keep stale temp agent ids that can falsely match a later spawn.
- **Fix:** Reset the controller at the single turn boundary (start of every sendMessage / on abort), and clear spawnAgentsMap entries older than the current toolCallId prefix on tool_result of their spawn call.
- **Evidence:** stream-state.ts:     setAgentAccumulator: (agentId, value) => { state.agentStreamAccumulators.set(agentId, value) },     removeAgentAccumulator: (agentId) => { state.agentStreamAccumulators.delete(agentId) }, Removal is driven solely by handleSubagentFinish / spawn resolution in sdk-event-handlers; the only bulk cleanup is `reset()`, not invoked from any code in this shard.

## [LOW] state-mutation — cli/src/commands/command-registry.ts:474 — /exit kills the process with SIGINT without flushing stream/queue/persisted state
- **Risk:** handler: () => { process.kill(process.pid, 'SIGINT') } bypasses stopStreaming, the message-queue cleanup, and any transcript persistence path: an in-flight turn's blocks, queued user messages (queuedMessagesRef), and the pending bash ghost list are dropped with no snapshot — unlike /new which at least pushMessageSnapshot()s first.
- **Fix:** Run an explicit shutdown sequence before signalling: pushMessageSnapshot()/persist transcript, clearQueue() with a discard notice, stopStreaming(), then process.exit or SIGINT.
- **Evidence:** command-registry.ts:   defineCommand({     name: 'exit',     aliases: ['quit', 'q'],     handler: () => {       process.kill(process.pid, 'SIGINT')     },   }), Compare the 'new' handler which calls useChatStore.getState().pushMessageSnapshot() and params.stopStreaming() before mutating state.

## [LOW] state-mutation — cli/src/chat.tsx:999 — editingMessageIdRef is referenced ~400 lines before its declaration (init-order hazard)
- **Risk:** onSubmitPrompt (useEvent callback) reads `editingMessageIdRef.current`, but the `const editingMessageIdRef = useRef<string | null>(null)` declaration sits much later in the component body with the comment 'Edit & resend...'. Today this only works because the callback runs after render completes; any synchronous invocation (e.g. a useEvent implementation that calls through during the first render, or test harnesses calling the handler immediately) throws a TDZ ReferenceError and silently kills the submit path.
- **Fix:** Hoist the ref declaration above onSubmitPrompt (next to the other refs from useChatState) so the binding is initialized before the first closure creation.
- **Evidence:** chat.tsx ordering:   const onSubmitPrompt = useEvent(async (content, mode, options?) => {     ...     const editingMessageId = editingMessageIdRef.current   // ~line 570     ...   })   ...   // Edit & resend: capture the edited message id at click time ...   const editingMessageIdRef = useRef<string | null>(null)   // ~line 999, declared after first use site

## [MEDIUM] error-handling — cli/src/chat.tsx:1095 — handlePublish awaits mutateAsync with no catch — publish failure becomes an unhandled rejection
- **Risk:** handlePublish = async (agentIds) => { await publishMutation.mutateAsync(agentIds) } and its callers (ChatInputBar publish flow) do not attach a .catch. A rejected publish (network/auth/validation error from the mutation) surfaces as an unhandled promise rejection on the TUI process — exactly the crash class the P6.1 guard in onSubmitPrompt was added to prevent — with no inline error message.
- **Fix:** Wrap in try/catch: log via logger.error and showClipboardMessage('Publish failed: ...') (or feed createErrorMessage into messages), matching the review/followup handlers' pattern.
- **Evidence:** chat.tsx:   const handlePublish = useCallback(     async (agentIds: string[]) => {       await publishMutation.mutateAsync(agentIds)   // no try/catch, returned promise unobserved at call site     },     [publishMutation],   ) Sibling handlers (handleReviewOptionSelect, followup click) do `.catch((error) => { logger.error(...) })`.

## [MEDIUM] error-handling — cli/src/utils/sdk-event-handlers.ts:1985 — Runtime error fallback surfaces raw event.message to the UI, leaking internals
- **Risk:** When event.userMessage is absent, handleRuntimeError strips only stack-frame lines (`/^\s*at\s/`) from event.message and pushes the remainder through updater.setError. Absolute file paths, provider request ids, model/API error bodies and config locations inside the raw message are shown verbatim in the terminal — and terminal text is user-copyable/paste-able into bug reports. Only the first line is kept when it is the first line; multi-line internal dumps after line 1 survive.
- **Fix:** Map known error shapes to stable user-facing text (as event.userMessage is meant to do) and relegate the raw message to logger only; if a fallback must render, render the first line only plus 'run /doctor or see logs for details'.
- **Evidence:** sdk-event-handlers.ts handleRuntimeError:   const message = event.message     .split('\n')     .filter((line, index) => index === 0 || !/^\s*at\s/.test(line))     .join('\n')     .trim()   state.message.updater.setError(message || 'The agent runtime reported an error.') Only `at `-prefixed lines are filtered; everything else from the raw runtime message reaches the UI.

## [LOW] error-handling — cli/src/hooks/use-message-queue.ts:322 — Failed queued sends pause the queue silently with no user-visible reason
- **Risk:** onRejected restores the message and sets queuePausedState(true) + setCanProcessQueue(false), logging only at warn level. The user sees the queue badge flip to paused (via useQueueUi text) but never learns their message failed to send or why; the message then sits indefinitely until manual resume, looking like a hang. The 'sendMessage handler not initialized' rejection from use-chat-streaming is likewise reduced to the same silent pause.
- **Fix:** Surface a system/error message (createErrorMessage or a status-bar error chip) carrying err.message, and offer one-key retry; keep the pause but label it 'paused after send failure'.
- **Evidence:** use-message-queue.ts processNextMessage onRejected:       onRejected: (rejectedMessage) => {         // A queued prompt is user data. Put it back at the front and pause the queue ...         setQueuedMessages((current) => { const restored = [rejectedMessage, ...current]; queuedMessagesRef.current = restored; return restored })         isQueuePausedRef.current = true         setQueuePausedState(true)         setCanProcessQueue(false)       }, The only diagnostics path is logger.warn inside completeQueuedMessageProcessing's .catch.

## [LOW] error-handling — cli/src/commands/command-registry.ts:665 — Command handlers echo raw internal error.message strings into the chat transcript
- **Risk:** /setup, /models, /provider, /info, /index, /memory all do `getSystemMessage(error instanceof Error ? error.message : String(error))`. Config/provider errors routinely contain absolute paths, env var names and provider endpoint details, which are then persisted into chat-messages.json and shown in the transcript — and with edit/feedback flows they can be re-sent to the model.
- **Fix:** Pass errors through a redacting formatter (basename-only paths, no env values) and prefix with the command name plus a 'see logs for full detail' hint, reserving raw text for logger.
- **Evidence:** command-registry.ts (provider handler):       } catch (error) {         message = error instanceof Error ? error.message : String(error)       }       params.setMessages((prev) => [...prev, getUserMessage(params.inputValue.trim()), getSystemMessage(message)]) Identical pattern in setup/models/info/context/index/memory handlers.

## [MEDIUM] performance — cli/src/chat.tsx:459 — Synchronous git/index subprocess polling on the UI thread (10s git + 2s index peek)
- **Risk:** getDiffStats({ cwd }) runs `git status --short`-class subprocess work synchronously inside setInterval(refresh, 10_000) plus an immediate call on every streaming→idle transition; peekIndexStatus() runs every 2s. On a large repo each git call can take hundreds of ms, blocking the event loop and stuttering token-by-token streaming rendering; the idle poll keeps paying this cost even when the terminal is not visible/focused.
- **Fix:** Run diff stats asynchronously (async getDiffStats with AbortSignal, or a debounced/child-process callback), skip polling while isStreaming, and back off the interval when the process is idle or the tab unfocused.
- **Evidence:** chat.tsx:   useEffect(() => {     const cwd = getProjectRoot() ?? process.cwd()     const refresh = () => setDiffStats(getDiffStats({ cwd }))   // sync fs/subprocess work     refresh()     const interval = setInterval(refresh, 10_000)     return () => clearInterval(interval)   }, []) plus `const interval = setInterval(() => setIndexStatus(peekIndexStatus()), 2_000)` and a second sync getDiffStats on isStreaming change.

## [MEDIUM] performance — cli/src/hooks/stream-state.ts:80 — rootStreamBuffer accumulates the entire turn's root text with no cap
- **Risk:** appendRootStreamBuffer does `state.rootStreamBuffer += value` for every root text chunk, duplicating the full streamed response as a second in-memory string for the lifetime of the turn (used only for PLAN extraction). Long turns / large file dumps double the peak memory of the message blocks and cause O(n) string re-allocation per chunk; only tool/job output is capped (JOB_OUTPUT_CHAR_CAP in sdk-event-handlers), not this buffer.
- **Fix:** Cap or window the buffer: for PLAN extraction only the tail (last N KB) plus an offset is needed after the plan block is found; otherwise stop appending once planExtracted is true and clear the buffer on turn end.
- **Evidence:** stream-state.ts:     appendRootStreamBuffer: (value: string) => {       state.rootStreamBuffer += value     }, Called from sdk-event-handlers createStreamChunkHandler for every root text chunk:       if (destination.textType === 'text') state.streaming.streamRefs.setters.appendRootStreamBuffer(text) No length bound anywhere in the two files.

## [LOW] performance — cli/src/chat.tsx:1770 — createPasteHandler(...) allocates a new handler object on every render of the input bar
- **Risk:** onPaste={createPasteHandler({ text: inputValue, cursorPosition, onChange: setInputValue, ... })} builds a fresh closure set per keystroke-render and passes it to ChatInputBar, defeating any memoization of the input bar (and of paste-path consumers) during typing — the hottest render path in the TUI.
- **Fix:** Memoize with useMemo over [inputValue, cursorPosition, ...stable callbacks] or move construction into a small hook that keeps a stable identity via refs.
- **Evidence:** chat.tsx render body:             onPaste={createPasteHandler({               text: inputValue,               cursorPosition,               onChange: setInputValue,               onPasteImage: chatKeyboardHandlers.onPasteImage,               ...               cwd: getProjectRoot() ?? process.cwd(),             })} Fresh object/closures each render; compare MessageBlock which is memo()ized precisely to avoid this class of churn.

## [LOW] performance — cli/src/components/message-block.tsx:160 — why-did-you-update comparison object is built every render even when the debug hook is disabled
- **Risk:** useWhyDidYouUpdateById('MessageBlock', messageId, { ...~20 fields... }, { enabled: getCliEnv().CODEBUFF_PERF_TEST === 'true' }) constructs the large props snapshot literal (including blocks, markdownOptions, metadata) on every render of every message regardless of the enabled flag, adding per-message allocation and a getCliEnv() lookup to the streaming render hot path.
- **Fix:** Compute the snapshot lazily inside the hook (pass a getter or gate the call site on a hoisted const enabled = ...), so production renders skip building it entirely.
- **Evidence:** message-block.tsx:     useWhyDidYouUpdateById(       'MessageBlock',       messageId,       {         messageId, blocks, content, isUser, isAi, isLoading, timestamp, ... metadata, isLastMessage,       },       { logLevel: 'debug', enabled: getCliEnv().CODEBUFF_PERF_TEST === 'true' },     ) The object literal is evaluated eagerly at the call site before `enabled` is ever consulted.

## [LOW] performance — cli/src/utils/tool-result-normalizer.ts:72 — Deep error scan is recomputed multiple times per tool_result on the stream hot path
- **Risk:** getStructuredErrorMessages walks the full multipart output (depth 6, every object entry) and is re-invoked via hasMultipartError at least twice per tool_result (markResult in handleToolResult and again in appendResultOnlyToolBlockToAgent), plus once per render of error-showing tool cards. For large tool outputs (read_files blobs) this is repeated full-tree scanning during streaming.
- **Fix:** Memoize per outputRaw reference (WeakMap) or compute the error list once in handleToolResult and thread it through to the block update / card renderers.
- **Evidence:** tool-result-normalizer.ts:   export function hasMultipartError(outputRaw: unknown): boolean {     return getStructuredErrorMessages(outputRaw).length > 0   } Sdk consumers in one event: `const hasError = hasMultipartError(event.output)` (appendResultOnlyToolBlockToAgent) and `if (hasMultipartError(event.output)) return { ...block, lifecycle: 'failed' }` (markResult), plus 9 tool card components calling getStructuredErrorMessages.

## [LOW] performance — cli/src/hooks/use-message-queue.ts:347 — Message queue is unbounded with no cap or overflow notice
- **Risk:** addToQueue appends unconditionally (`const newQueue = [...prev, queuedMessage]`). A user (or a script driving stdin) can enqueue arbitrarily many prompts with full attachment arrays while a long turn runs; memory grows without bound and there is no UX signal that the queue is very deep beyond the preview title, so the backlog can silently span many turns.
- **Fix:** Cap the queue (e.g. 50 entries / N chars) with a visible 'queue full' rejection message, and surface queuedCount in the status bar at all depths.
- **Evidence:** use-message-queue.ts:   const addToQueue = useCallback((message: string, attachments: PendingAttachment[] = []) => {     const queuedMessage = { content: message, attachments }     setQueuedMessages((prev) => {       const newQueue = [...prev, queuedMessage]   // no length/size check       queuedMessagesRef.current = newQueue       return newQueue     })   }, [])

## [LOW] dependency-hygiene — cli/src/hooks/use-chat-streaming.ts:111 — Unused queryClient pulls @tanstack/react-query context into the streaming hook for nothing
- **Risk:** const queryClient = useQueryClient() is assigned and never read (the 'Reconnection handler' comment says no cloud auth to invalidate in Openbuff). It adds a hard runtime requirement that a QueryClientProvider wraps the TUI (useQueryClient throws otherwise), keeps an unnecessary dependency in the CLI's critical path, and invites future code to mutate global query state from a UI streaming hook.
- **Fix:** Delete the useQueryClient() call and the useQueryClient import; if reconnect cache invalidation is ever needed again, inject it via a narrow callback prop.
- **Evidence:** use-chat-streaming.ts:   import { useQueryClient } from '@tanstack/react-query'   ...   const queryClient = useQueryClient()   const [, startUiTransition] = useTransition() `queryClient` appears nowhere else in the 257-line file (reconnection path explicitly says 'no cloud auth to invalidate in Openbuff').

## [MEDIUM] test-coverage — cli/src/chat.tsx:107 — No tests for the Chat submit / queue / edit-resend / error-surface paths
- **Risk:** chat.tsx's onSubmitPrompt (snapshot+truncate edit-resend, attachment preservation, P6.1 catch/finally restore), handleSubmit, ghost-bash flush, and queue interplay are the core user-turn orchestration and have zero direct test coverage — referenced test files in this shard cover only command-args, router-input, bash-command, command-suggestions, use-queue-controls and sdk-event-handlers. Regressions in turn truncation (wrong slice index) or queue-guard bypass would ship unnoticed.
- **Fix:** Add hook/component tests driving onSubmitPrompt with a fake sendMessage: assert edit-resend truncates at the edited id and pushes exactly one snapshot, attachments survive preserveInputValue, a throwing routeUserPrompt yields the inline error and restores input, and busy-state submits land in the queue.
- **Evidence:** No test file references `Chat`, `onSubmitPrompt`, `use-chat-streaming`, `use-send-message` behavior or `routeUserPrompt`; the only send-message-adjacent tests are cli/src/hooks/helpers/__tests__/send-message.test.ts (createStreamController usage) and cli/src/hooks/__tests__/use-queue-controls.test.ts (queue primitives). The 1844-line chat.tsx turn orchestration itself is untested.

## [MEDIUM] test-coverage — cli/src/utils/tool-result-normalizer.ts:72 — No tests for tool-result error detection, including its false-positive failure mode
- **Risk:** getStructuredErrorMessages / hasMultipartError decide whether a tool block renders 'failed' and whether completion summaries count a failure, but no test file references this module (its referencedBy list is all components + sdk-event-handlers). The recursive scan's failure mode — result DATA containing an `error` field flipping a successful tool to failed — is exactly the kind of negative case a test would catch.
- **Fix:** Add unit tests: multipart outputs with envelope errors, nested payload `error` data (must NOT count), native_tool_result_error kinds, depth>6 shapes, and the cancelled+file_mutation_result mapping used by getCanonicalMutationResult.
- **Evidence:** tool-result-normalizer.ts referencedBy lists only cli/src/components/tools/*.tsx, cli/src/utils/completion-summary.ts, implementor-helpers.ts, sdk-event-handlers.ts — no __tests__ consumer anywhere in the graph for getToolOutputValues/getStructuredErrorMessages/hasMultipartError/isTerminalToolBlock.

## [LOW] test-coverage — cli/src/components/ask-user/index.tsx:35 — Ask-user form keyboard matrix and answer formatting are untested
- **Risk:** MultipleChoiceForm encodes a large hand-rolled state machine (expandedIndex/focusedOptionIndex/submitFocused/lastFocusBeforeSubmit/isTypingCustom/suppressNextHoverFocusRef) plus formatAnswer's multi-select + custom-text merging. With no tests, subtle regressions (e.g. custom+selected merging, multiSelect toggle of CUSTOM_OPTION_INDEX, mouse-vs-keyboard double-click rule) silently change what answers reach the model.
- **Fix:** Extract the keyboard reducer and formatAnswer into pure functions and test: arrow/Tab/Shift-Tab traversal across question boundaries, Enter on Custom vs option, multiSelect set semantics, and that unanswered questions format as 'Skipped'.
- **Evidence:** ask-user/index.tsx: ~250 lines of useCallback state machine inside the component (handleSelectOption, handleToggleOption, handleCustomSubmit, formatAnswer, useKeyboard) with zero corresponding test files in cli/src/components/ask-user/.

## [LOW] test-coverage — cli/src/utils/sdk-event-handlers.ts:968 — Hidden-tool and spawn-result-routing branches of the event handlers have no failure-mode tests
- **Risk:** cli/src/utils/__tests__/sdk-event-handlers.test.ts covers part of the surface, but the branches this audit found buggy — hidden tool names flowing into appendResultOnlyToolBlockToAgent, the shape-sniffing isSpawnAgentsResult early return, and settleOrphanedForegroundAgents at finish — appear untested. These are exactly the out-of-order/abnormal-event paths that only fail in production streams.
- **Fix:** Extend the handler tests with: tool_result for a hidden tool name (assert NO block is created), a non-spawn tool_result whose json value is an array of {agentType} records (assert the tool block still receives output), and a finish event with a still-'running' agent/tool block (assert failed settlement + streamingAgents removal).
- **Evidence:** sdk-event-handlers.ts handleToolResult/appendResultOnlyToolBlockToAgent/handleFinish contain the untested branches (`if (isHiddenToolName(event.toolName)) return` exists only in handleToolCall; `isSpawnAgentsResult` shape sniff; settleOrphanedForegroundAgents). referencedBy shows one test file, agents/e2e/editor-orchestrator-contract.e2e.test.ts and create-run-config.ts — none exercising hidden-tool result routing.

## [LOW] api-contract — cli/src/utils/tool-result-normalizer.ts:100 — isTerminalToolBlock casts lifecycle to `never`, disabling exhaustiveness checking on a shared vocabulary
- **Risk:** TERMINAL_TOOL_LIFECYCLES.has(block.lifecycle as never) type-laundering means a new value added to ToolContentBlock['lifecycle'] (as 'queued'/'running' already are, and as jobStateToToolLifecycle keeps extending) compiles here without error and is silently treated as non-terminal — orphan settling in handleFinish and queued-flip logic in handleToolStart then mis-handle the block with no compiler signal.
- **Fix:** Type the set as Set<ToolContentBlock['lifecycle']> and call .has(block.lifecycle) directly (or use an explicit switch with a `never` exhaustiveness guard like jobStateToToolLifecycle does).
- **Evidence:** tool-result-normalizer.ts:   export const TERMINAL_TOOL_LIFECYCLES = new Set(['succeeded', 'failed', 'cancelled'] as const)   export function isTerminalToolBlock(block: ToolContentBlock): boolean {     return Boolean(block.lifecycle && TERMINAL_TOOL_LIFECYCLES.has(block.lifecycle as never))   } The `as never` cast exists purely to silence the Set<'succeeded'|'failed'|'cancelled'> vs full lifecycle union mismatch.

## [LOW] api-contract — cli/src/commands/command-registry.ts:92 — CommandResult is an untyped bag of boolean flags plus one string payload, inviting contract drift
- **Risk:** CommandResult = { openFeedbackMode?: boolean; ...; openPlanSessionPicker?: string; preSelectAgents?: string[] } | void — `openPlanSessionPicker` reads as a boolean flag but carries a command name string, and `| void` means handlers may return undefined implicitly. Callers (chat.tsx handleCommandResult) must truthiness-check it and forward it as `setPlanSessionPickerCommand(result.openPlanSessionPicker)`, so any rename/reshape of the picker command name is an invisible breaking change for command handlers defined across the registry.
- **Fix:** Discriminate the result: `type CommandResult = {kind: 'open-picker', picker: 'plan-session', command: string} | {kind: 'open-mode', mode: ...} | {kind: 'none'} | void`, or at minimum rename the field to planSessionPickerCommand and drop `| void` in favor of explicit undefined.
- **Evidence:** command-registry.ts:   export type CommandResult = {     openFeedbackMode?: boolean     openPublishMode?: boolean     openChatHistory?: boolean     openPromptHistorySearch?: boolean     openReviewScreen?: boolean     openModelRoutePicker?: boolean     openProviderPicker?: boolean     openPlanSessionPicker?: string   // string payload on a boolean-looking flag     preSelectAgents?: string[]   } | void Consumed in chat.tsx: `if (result.openPlanSessionPicker) setPlanSessionPickerCommand(result.openPlanSessionPicker)`.

## [LOW] api-contract — cli/src/app.tsx:222 — authStatus is hardcoded to 'ok', making the AuthStatus contract and its downstream states dead code
- **Risk:** AuthedSurface accepts authStatus: AuthStatus and forwards it to getStatusIndicatorState, whose vocabulary almost certainly includes non-'ok' values — but App pins `const authStatus: AuthStatus = 'ok'` with a comment that BYOK has no backend. Any local provider credential failure is therefore never reported through the auth channel the status bar contract exposes, and future callers of the AuthedSurface prop will silently receive a lie.
- **Fix:** Derive authStatus from actual local provider config validity (e.g. resolveModelNameForAgent / provider status) or narrow the prop type to the single supported value and delete the unreachable status-indicator branches.
- **Evidence:** app.tsx:   // Auth status is always 'ok' in local/BYOK mode — no cloud backend to query   const authStatus: AuthStatus = 'ok' passed into <AuthedSurface authStatus={authStatus} ...> → Chat → getStatusIndicatorState({ ..., authStatus, ... }), which then has unreachable failure rendering.

## Coverage receipt

### Subsystems
- cli

### Features
- app-entry-shell
- chat-submit-routing
- stream-event-normalization
- message-block-rendering
- tool-call-rendering
- slash-command-surface
- ask-user-ui-bridge
- message-queue-steering
- stream-state-container
- tool-result-normalization

### Files
- cli/src/app.tsx
- cli/src/chat.tsx
- cli/src/hooks/use-chat-streaming.ts
- cli/src/hooks/stream-state.ts
- cli/src/utils/sdk-event-handlers.ts
- cli/src/components/message-block.tsx
- cli/src/commands/command-registry.ts
- cli/src/components/ask-user/index.tsx
- cli/src/hooks/use-message-queue.ts
- cli/src/utils/tool-result-normalizer.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
