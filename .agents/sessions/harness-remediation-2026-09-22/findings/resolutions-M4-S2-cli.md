# Audit findings: resolutions-M4-S2-cli

- Subsystems: cli
- Features: app-entry-shell, chat-submit-routing, stream-event-normalization, message-block-rendering, slash-command-surface, ask-user-ui-bridge, message-queue-steering, stream-state-container, tool-result-normalization
- Files covered: 11

## [MEDIUM] state-mutation — cli/src/chat.tsx — [ESCALATED] sendMessageRef written during render
- **Risk:** concurrent/StrictMode render can leave the ref pointing at a discarded closure; queue drains through sendMessageRef.current
- **Fix:** File cli/src/chat.tsx: replace the render-body write with useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage]). Test: none needed (behavioral no-op in practice).
- **Evidence:** chat.tsx:532 sendMessageRef.current = sendMessage in the render body (searched; no useEffect assignment found). UseEvent-protected onSubmitPrompt pattern unchanged.

## [MEDIUM] state-mutation — cli/src/hooks/use-message-queue.ts — [ESCALATED] Queue ref writes inside setState updaters violate the module's own invariant
- **Risk:** double-invoked updater can leave the ref describing a queue that was never committed
- **Fix:** File cli/src/hooks/use-message-queue.ts: compute the next array outside setState, then setQueuedMessages(next) + queuedMessagesRef.current = next at a single non-updater site (or sync the ref in a layout effect keyed on the array). Test: cli/src/hooks/__tests__/use-message-queue.test.ts (new) — double-invoked updater cannot desync clearQueue().
- **Evidence:** use-message-queue.ts:274-276 processNextMessage sets queuedMessagesRef.current inside the updater; onRejected restore (286-290) and addToQueue (~318-324) share the pattern; the module's own 'must NOT assign' comment sits immediately above.

## [LOW] state-mutation — cli/src/hooks/use-message-queue.ts — [ALREADY-RESOLVED] Queue watchdog force-releasing the processing lock: watchdog removed
- **Risk:** possible audit staleness
- **Fix:** none — superseded by the queueProcessingRun ownership mechanism
- **Evidence:** Searched cli/src/hooks/use-message-queue.ts for WATCHDOG/watchdog — zero matches; the 60s force-release path no longer exists (queue ownership now tracked via queueProcessingRun.releaseQueueProcessingOwner).

## [MEDIUM] state-mutation — cli/src/hooks/stream-state.ts — [ESCALATED] rootStreamBuffer accumulates the whole turn with no cap
- **Risk:** rootStreamBuffer accumulates the entire turn's text — peak memory and O(n) reallocation per chunk
- **Fix:** File cli/src/hooks/stream-state.ts: stop appending once plan extraction completes (clear the buffer when planExtracted flips true), and cap retained tail at ~64KB with an offset field for the extractor. Test: cli/src/hooks/__tests__/stream-state.test.ts (new) — buffer stays bounded on a multi-MB turn.
- **Evidence:** stream-state.ts:65-67 appendRootStreamBuffer does state.rootStreamBuffer += value with no cap; nothing bounds it during the turn.

## [MEDIUM] correctness — cli/src/utils/sdk-event-handlers.ts — [ESCALATED] spawn_agents result routing shape-sniffs instead of gating on toolName
- **Risk:** non-spawn tool results with agent-shaped array values get swallowed and their blocks stay 'running'
- **Fix:** File cli/src/utils/sdk-event-handlers.ts: add event.toolName === 'spawn_agents' to the isSpawnAgentsResult condition; keep the shape check as a compatibility fallback. Test: cli/src/utils/__tests__/sdk-event-handlers.test.ts — a non-spawn tool_result whose json value is an array of {agentType} records still receives updateToolBlockWithOutput.
- **Evidence:** sdk-event-handlers.ts:907-918 isSpawnAgentsResult checks only the array-record shape (agentName/agentType), never event.toolName; non-spawn array results take the spawn path and return early.

## [MEDIUM] correctness — cli/src/utils/sdk-event-handlers.ts — [ESCALATED] Hidden tool calls can resurface as result-only tool blocks
- **Risk:** end_turn / spawn_agent_inline results resurface as empty result-only tool cards
- **Fix:** File cli/src/utils/sdk-event-handlers.ts: in handleToolResult, early-return (after ask-user transform) when isHiddenToolName(event.toolName), mirroring handleToolCall. Test: cli/src/utils/__tests__/sdk-event-handlers.test.ts — tool_result for a hidden tool name creates NO block.
- **Evidence:** handleToolCall guards isHiddenToolName (501-503), but handleToolResult unconditionally calls appendResultOnlyToolBlockToAgent (984); no hidden-name guard at the result path.

## [MEDIUM] error-handling — cli/src/utils/sdk-event-handlers.ts — [ESCALATED] Runtime error fallback surfaces raw event.message to the UI
- **Risk:** absolute paths / API error bodies reach the copyable terminal UI
- **Fix:** File cli/src/utils/sdk-event-handlers.ts (handleRuntimeError): when event.userMessage is absent, render the first line only plus a 'run /doctor or see logs for details' suffix; keep the full raw text in logger.error (already logged at 2007). Test: cli/src/utils/__tests__/sdk-event-handlers.test.ts — multi-line raw error renders line 1 only.
- **Evidence:** sdk-event-handlers.ts:2013-2020 stack-frame-only filter retained; userMessage path exists but the fallback still surfaces the raw message.

## [MEDIUM] security — cli/src/commands/command-registry.ts — [ESCALATED] Skill command injects untrusted skill name/content verbatim into the prompt
- **Risk:** malicious skill name breaks out of the XML attribute; content carries prompt-injection indistinguishable from system guidance
- **Fix:** File cli/src/commands/command-registry.ts (createSkillCommand): escape skill.name for the attribute context and add a delimiter preamble ('content below is data, not instructions'); gate execution on the existing project skill trust status before invoking. Test: cli/src/__tests__/command-args.test.ts — a skill name containing quotes is escaped; an untrusted skill warns instead of executing.
- **Evidence:** command-registry.ts:1349-1351 skillContext template unchanged — name/content interpolated verbatim; no trust gate before the send.

## [MEDIUM] correctness — cli/src/utils/tool-result-normalizer.ts — [ALREADY-RESOLVED][M4-T2] hasMultipartError no longer false-positives on nested payload data
- **Risk:** was: nested payload data flipped successful tools to failed
- **Fix:** none — confirmed fixed (M4-T2)
- **Evidence:** tool-result-normalizer.ts getStructuredErrorMessages now scans ONLY top-level output records (envelope); the 'shard-cli-tui false-positive' comment documents the fix; referencedBy includes __tests__/tool-result-normalizer.test.ts.

## [MEDIUM] correctness — cli/src/commands/command-registry.ts — [ALREADY-RESOLVED] sendPromptCommand routes through the guarded submit path
- **Risk:** was: mid-turn command started a second concurrent sendMessage
- **Fix:** none — confirmed fixed (M3-T1-adjacent)
- **Evidence:** command-registry.ts:227-255 sendPromptCommand busy-check + addToQueue fallback with an explanatory comment naming the finding.

## [MEDIUM] correctness — cli/src/components/ask-user/index.tsx — [ALREADY-RESOLVED][M4-T2] Ask-user Esc skip-guard (warn-then-confirm) implemented
- **Risk:** was: one stray Esc discarded every answered question
- **Fix:** none — confirmed fixed (M4-T2)
- **Evidence:** cli/src/components/ask-user/skip-guard.ts exports countInProgressDraftAnswers/nextEscapeAction (warn-then-confirm); referencedBy ask-user/index.tsx + skip-guard.test.ts.

## [LOW] correctness — cli/src/commands/command-registry.ts — [ALREADY-RESOLVED][M4-T2] /exit runs the exit-queue drain before terminating
- **Risk:** was: /exit dropped queued prompts without persisting
- **Fix:** none — confirmed fixed (M4-T2)
- **Evidence:** cli/src/hooks/helpers/exit-queue-drain.ts createQueuedPromptDrainer; registered in chat.tsx:404-417 and run inline by /exit (command-registry.ts exitWithAnalyticsFlush flow).

## [MEDIUM] correctness — cli/src/chat.tsx — [ESCALATED] Synchronous git/index subprocess polling on the UI thread
- **Risk:** sync git/index subprocess polling on the UI thread (10s git + 2s index) blocks the event loop and stutters streaming
- **Fix:** File cli/src/chat.tsx: make getDiffStats async with AbortSignal (or debounce), skip refresh while isStreaming, and back off when idle. Test: cli/src/__tests__/unit (new) — assert no sync subprocess call on the render path.
- **Evidence:** chat.tsx:447-460 both intervals still call the synchronous getDiffStats + peekIndexStatus inside setInterval.

## [LOW] security — cli/src/chat.tsx — [ALREADY-RESOLVED] Analytics telemetry is a no-op in local-first BYOK mode
- **Risk:** residual: none beyond dead call sites
- **Fix:** none — the audit's concern (off-box emission) is moot in the current scaffold
- **Evidence:** cli/src/utils/analytics.ts: trackEvent, flushAnalytics, and initAnalytics are explicit no-ops ('analytics scaffold removed (local-only mode)'); no PostHog client is initialized, so telemetry cannot leave the box.

## [MEDIUM] test-coverage — cli/src/chat.tsx — [ESCALATED] No tests for Chat submit / queue / edit-resend / error-surface paths
- **Risk:** turn orchestration regressions ship unnoticed
- **Fix:** File cli/src/__tests__/chat-submit.test.tsx (new): drive onSubmitPrompt with a fake sendMessage — assert edit-resend truncates at the edited id and pushes exactly one snapshot, attachments survive preserveInputValue, a throwing routeUserPrompt yields the inline error and restores input, and busy-state submits land in the queue.
- **Evidence:** Searched cli for onSubmitPrompt-driving tests; found only use-chat-input.test.ts (hook passthrough) and use-queue-controls.test.ts; the 1800-line chat.tsx submit/queue/edit-resend orchestration remains untested.

## [MEDIUM] test-coverage — cli/src/utils/tool-result-normalizer.ts — [ALREADY-RESOLVED][M4-T2] Tool-result-normalizer now has unit tests
- **Risk:** was: no test file referenced the module
- **Fix:** none — confirmed fixed (M4-T2)
- **Evidence:** cli/src/utils/__tests__/tool-result-normalizer.test.ts exists and covers getStructuredErrorMessages/hasMultipartError/getCanonicalMutationResult per referencedBy.

## [MEDIUM] error-handling — cli/src/chat.tsx — [ESCALATED] handlePublish awaits mutateAsync with no catch
- **Risk:** publish failure becomes an unhandled rejection on the TUI process
- **Fix:** File cli/src/chat.tsx (handlePublish): wrap in try/catch — logger.error plus showClipboardMessage('Publish failed: <message>') (matching handleReviewOptionSelect), and keep the promise observed. Test: none strictly needed; optional component test asserting no unhandled rejection on a rejecting mutation.
- **Evidence:** chat.tsx:1033-1035 handlePublish still awaits mutateAsync with no try/catch.

## [LOW] error-handling — cli/src/commands/command-registry.ts — [ESCALATED] Command handlers echo raw error.message strings into the transcript
- **Risk:** config/provider errors carry absolute paths and env names into the persisted transcript
- **Fix:** File cli/src/commands/command-registry.ts: route caught errors through a shared redacting formatter (basename-only paths, no env values) prefixed with the command name and a 'see logs for full detail' hint; reserve raw text for logger. Test: cli/src/__tests__/command-args.test.ts — a path-bearing error renders basename only.
- **Evidence:** command-registry.ts:669-672 setup handler catches with error.message; models handler (~694-696) same pattern; unchanged elsewhere (/provider, /info, /index, /memory).

## [MEDIUM] correctness — cli/src/app.tsx — [ESCALATED] handleNewChat cannot clear the initial --continue flag
- **Risk:** '/new' silently resumes the previous chat when the session started with --continue
- **Fix:** File cli/src/app.tsx: track continue as local state (const [continueTarget, setContinueTarget] = useState({enabled: continueChat, id: continueChatId})); handleNewChat clears both; derive the effective values from that state. Test: cli/src/__tests__/unit (new) — after handleNewChat on a continueChat session, effectiveContinueChat is false.
- **Evidence:** app.tsx:155-163 handleNewChat clears resumeChatId only; effectiveContinueChat = continueChat || resumeChatId !== null keeps the mount-time prop forever.

## [LOW] correctness — cli/src/app.tsx — [ESCALATED] Re-selecting the current chat id does not remount Chat
- **Risk:** re-selecting the active chat id leaves a blank transcript
- **Fix:** File cli/src/app.tsx: const chatKey = resumeChatId ? `${resumeChatId}:${resumeNonce}` : 'current' with resumeNonce incremented in handleResumeChat and handleNewChat. Test: cli/src/__tests__/unit — re-selecting the same chat id remounts Chat.
- **Evidence:** app.tsx:221 chatKey = resumeChatId ?? 'current'; no resumeNonce exists (searched).

## [LOW] correctness — cli/src/chat.tsx — [ESCALATED] Ghost-bash flush effect reads refs it does not track
- **Risk:** ghost-bash flush fires on stale ref values (timing-dependent ordering vs. the next user turn)
- **Fix:** File cli/src/chat.tsx: mirror the refs into state (or derive the gate from a state value that re-renders) and include the trigger in the dep array; alternatively run the flush from the single transition point that clears the chain/stream refs. Test: cli/src/__tests__/chat-submit.test.tsx — flush does not fire while a chain is in progress.
- **Evidence:** chat.tsx:474-479 the flush effect gates on !streamMessageIdRef.current && !isChainInProgressRef.current but the dep array remains [isStreaming, pendingBashMessages, ...] without the refs.

## [LOW] correctness — cli/src/components/message-block.tsx — [ESCALATED] Attachment cards keyed by collidable path
- **Risk:** duplicate React keys when two attachments share a path (wrong reconciliation, console warnings)
- **Fix:** File cli/src/components/message-block.tsx: key image/file cards by a stable id when present, falling back to `${path}:${index}`. Test: cli/src/components/__tests__/message-block.test.tsx — duplicate paths render distinct keys.
- **Evidence:** message-block.tsx:99-117 image/file attachment cards still key by attachment.path.

## [LOW] correctness — cli/src/commands/command-registry.ts — [ESCALATED] findCommand lower-cases skill lookup names
- **Risk:** mixed-case skills unreachable via /skill:<Name>
- **Fix:** File cli/src/commands/command-registry.ts (findCommand): resolve skill commands with the original-case name (const skillName = cmd.slice('skill:'.length)), keeping case-insensitive matching for the static registry. Test: cli/src/__tests__/command-args.test.ts — '/skill:RefactorPlan' resolves a mixed-case skill.
- **Evidence:** command-registry.ts:1251-1256 findCommand lower-cases the skill name before getSkillByName; unchanged.

## [LOW] state-mutation — cli/src/chat.tsx — [ESCALATED] editingMessageIdRef declared ~400 lines after first use
- **Risk:** TDZ ReferenceError if the useEvent closure ever runs during the first render
- **Fix:** File cli/src/chat.tsx: hoist `const editingMessageIdRef = useRef<string | null>(null)` above onSubmitPrompt (next to the other useChatState refs). Test: existing suites; typecheck-only.
- **Evidence:** chat.tsx:548-550 onSubmitPrompt reads editingMessageIdRef; declaration sits at line 940 (after first use).

## [LOW] performance — cli/src/chat.tsx — [ALREADY-RESOLVED] createPasteHandler allocation on every render: construction no longer in render body
- **Risk:** possible audit staleness
- **Fix:** none — superseded by the chatKeyboardHandlers memoization
- **Evidence:** Searched chat.tsx for createPasteHandler — zero matches; the paste-handler construction no longer sits in the Chat render body (input bar now receives handlers via chatKeyboardHandlers useMemo at 1140).

## [LOW] performance — cli/src/components/message-block.tsx — [ESCALATED] useWhyDidYouUpdateById props snapshot built eagerly on every render
- **Risk:** per-message allocation on every render even when debug hook disabled
- **Fix:** File cli/src/hooks/use-why-did-you-update.ts + cli/src/components/message-block.tsx: accept a getter (props: () => T) or hoist `const perfEnabled = getCliEnv().CODEBUFF_PERF_TEST === 'true'` to module scope and early-return before building the snapshot. Test: optional — assert no snapshot allocation when disabled (perf-only).
- **Evidence:** message-block.tsx:163-175 useWhyDidYouUpdateById call still evaluates the ~20-field props literal eagerly; enabled flag consulted inside the hook only.

## [LOW] performance — cli/src/utils/tool-result-normalizer.ts — [ESCALATED] getStructuredErrorMessages recomputed multiple times per tool_result
- **Risk:** deep envelope error scan recomputed multiple times per tool_result
- **Fix:** File cli/src/utils/tool-result-normalizer.ts: memoize getStructuredErrorMessages per outputRaw reference (WeakMap), or compute once in handleToolResult and thread the result through. Test: cli/src/utils/__tests__/tool-result-normalizer.test.ts — repeated calls on the same outputRaw reuse the cached list.
- **Evidence:** sdk-event-handlers.ts invokes hasMultipartError at least twice per tool_result (markResult 959, appendResultOnlyToolBlockToAgent) and 9+ tool cards call getStructuredErrorMessages per render; output is capped at JOB_OUTPUT_CHAR_CAP (50k) which bounds worst-case cost.

## [LOW] performance — cli/src/hooks/use-message-queue.ts — [ESCALATED] Message queue is unbounded with no cap or overflow notice
- **Risk:** unbounded queue growth with full attachment arrays during a long turn
- **Fix:** File cli/src/hooks/use-message-queue.ts (addToQueue): cap at 50 entries — return the queue unchanged and log/notice 'queue full' beyond it; surface queuedCount in the status bar at all depths. Test: cli/src/hooks/__tests__/use-message-queue.test.ts — the 51st enqueue is rejected with a visible notice.
- **Evidence:** use-message-queue.ts:320-324 addToQueue still appends unconditionally; no cap or overflow notice exists.

## [LOW] dependency-hygiene — cli/src/hooks/use-chat-streaming.ts — [ESCALATED] Unused useQueryClient pulls @tanstack/react-query into the streaming hook
- **Risk:** hard runtime requirement that a QueryClientProvider wraps the TUI
- **Fix:** File cli/src/hooks/use-chat-streaming.ts: delete the useQueryClient() call and the @tanstack/react-query import. Test: typecheck-only — bun run typecheck.
- **Evidence:** use-chat-streaming.ts:6,101 useQueryClient still imported and called; queryClient unused (reconnection comment confirms no cloud auth to invalidate).

## [LOW] test-coverage — cli/src/components/ask-user/index.tsx — [PARTIALLY-RESOLVED][M4-T2] Ask-user keyboard matrix partially covered via extracted pure helpers
- **Risk:** subtle keyboard/merge regressions change what answers reach the model
- **Fix:** File cli/src/components/ask-user/__tests__/multiple-choice-form.test.ts: extract the keyboard reducer into a pure function and test arrow/Tab traversal across question boundaries, Enter on Custom vs option, multiSelect set semantics, and 'Skipped' formatting for unanswered questions.
- **Evidence:** cli/src/components/ask-user/__tests__ contains skip-guard.test.ts and validation.test.ts; the extracted helpers cover the dirty-count/warn-confirm logic, though the full keyboard matrix (traversal, multiSelect semantics) remains partially uncovered.

## [LOW] api-contract — cli/src/utils/tool-result-normalizer.ts — [ESCALATED] isTerminalToolBlock casts lifecycle to never, disabling exhaustiveness checking
- **Risk:** new lifecycle values compile silently as non-terminal, breaking orphan settlement
- **Fix:** File cli/src/utils/tool-result-normalizer.ts: type the set as Set<ToolContentBlock['lifecycle']> and call .has(block.lifecycle) directly (or switch with a never exhaustiveness guard). Test: typecheck-only.
- **Evidence:** tool-result-normalizer.ts isTerminalToolBlock keeps TERMINAL_TOOL_LIFECYCLES.has(block.lifecycle as never).

## [LOW] api-contract — cli/src/commands/command-registry.ts — [ESCALATED] CommandResult is an untyped flag bag with a string payload on a boolean-looking field
- **Risk:** string payload on a boolean-looking flag; implicit-undefined handlers
- **Fix:** File cli/src/commands/command-registry.ts: rename to planSessionPickerCommand and drop '| void' in favor of explicit undefined (or discriminate the result union). Test: typecheck-only after updating the chat.tsx consumer.
- **Evidence:** command-registry.ts:108-120 CommandResult keeps openPlanSessionPicker?: string with '| void'.

## [LOW] api-contract — cli/src/app.tsx — [ESCALATED] authStatus hardcoded to 'ok' making the AuthStatus contract dead code
- **Risk:** AuthStatus contract and downstream non-ok states are dead code
- **Fix:** File cli/src/app.tsx: derive authStatus from local provider config validity (resolveModelNameForAgent/provider status) or narrow the prop type to the single supported value and delete unreachable status-indicator branches. Test: cli/src/__tests__/unit — non-'ok' states unreachable or derived.
- **Evidence:** app.tsx:207-209 authStatus pinned to 'ok' with the BYOK comment; unchanged.

## [LOW] correctness — cli/src/chat.tsx — [SUMMARY] shard-cli-tui dispositions: ALREADY-RESOLVED 8, PARTIALLY-RESOLVED 1, ESCALATED 23, ACCEPTED 0, FIXED 0
- **Risk:** none
- **Fix:** See per-finding entries.
- **Evidence:** SUMMARY: shard-cli-tui had 32 findings: ALREADY-RESOLVED 8 (Esc skip-guard, sendPromptCommand guard, tool-result false positives + tests, analytics no-op, watchdog removal, paste-handler memo, exit drain, tool-result tests), PARTIALLY-RESOLVED 1 (ask-user keyboard helpers), ESCALATED 23 (each with exact file/change/test plan above). All 32 located by snippet; three audit line numbers drifted but snippets matched.

## Coverage receipt

### Subsystems
- cli

### Features
- app-entry-shell
- chat-submit-routing
- stream-event-normalization
- message-block-rendering
- slash-command-surface
- ask-user-ui-bridge
- message-queue-steering
- stream-state-container
- tool-result-normalization

### Files
- cli/src/app.tsx
- cli/src/chat.tsx
- cli/src/commands/command-registry.ts
- cli/src/utils/sdk-event-handlers.ts
- cli/src/utils/tool-result-normalizer.ts
- cli/src/components/ask-user/index.tsx
- cli/src/hooks/use-message-queue.ts
- cli/src/hooks/stream-state.ts
- cli/src/hooks/use-chat-streaming.ts
- cli/src/components/message-block.tsx
- cli/src/hooks/helpers/exit-queue-drain.ts

### Domains
- correctness
- state-mutation
- security
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
