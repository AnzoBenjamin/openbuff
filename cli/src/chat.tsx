import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import type { FeedbackCategory } from '@codebuff/common/constants/feedback'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useShallow } from 'zustand/react/shallow'

import { routeUserPrompt, addBashMessageToHistory } from './commands/router'
import { ChatInputBar } from './components/chat-input-bar'
import { Button } from './components/button'
import { CommandPaletteScreen } from './components/command-palette-screen'
import { OutputReaderScreen } from './components/output-reader-screen'
import { QueueScreen } from './components/queue-screen'
import { AttachmentRecoveryScreen } from './components/attachment-recovery-screen'
import { useOutputReaderStore } from './state/output-reader-store'
import { PromptHistorySearchScreen } from './components/prompt-history-search-screen'
import { ModelRoutePicker } from './components/model-route-picker'
import { PlanSessionPickerScreen } from './components/plan-session-picker-screen'
import {
  ProviderPickerScreen,
  type ProviderPickerSelection,
} from './components/provider-picker-screen'
import { LoadPreviousButton } from './components/load-previous-button'
import { MessageListWindow } from './components/message-list-window'
import { ReviewScreen } from './components/review-screen'
import { PendingBashMessage } from './components/pending-bash-message'
import { StatusBar } from './components/status-bar'
import { TopBanner } from './components/top-banner'
import { getSlashCommandsWithSkills } from './data/slash-commands'
import { useAgentValidation } from './hooks/use-agent-validation'
import { useAskUserBridge } from './hooks/use-ask-user-bridge'
import { useChatInput } from './hooks/use-chat-input'
import {
  useChatKeyboard,
  type ChatKeyboardHandlers,
} from './hooks/use-chat-keyboard'
import { useChatMessages } from './hooks/use-chat-messages'
import { useChatState } from './hooks/use-chat-state'
import { useChatStreaming } from './hooks/use-chat-streaming'
import { useChatUI } from './hooks/use-chat-ui'
import { useClipboard } from './hooks/use-clipboard'
import { useEvent } from './hooks/use-event'

import { useInputHistory } from './hooks/use-input-history'
import { usePublishMutation } from './hooks/use-publish-mutation'
import { useSendMessage } from './hooks/use-send-message'
import {
  getMentionSuggestionStatus,
  useSuggestionEngine,
} from './hooks/use-suggestion-engine'
import { getProjectRoot } from './project-files'
import { useChatHistoryStore } from './state/chat-history-store'
import { useChatStore } from './state/chat-store'
import { useReviewStore } from './state/review-store'
import { useFeedbackStore } from './state/feedback-store'
import { useMessageBlockStore } from './state/message-block-store'
import { usePublishStore } from './state/publish-store'
import { trackEvent } from './utils/analytics'
import { showClipboardMessage } from './utils/clipboard'
import { readClipboardImage } from './utils/clipboard-image'
import { consumeCapturedEarlyInput } from './utils/early-input-capture'
import { getSystemMessage } from './utils/message-history'
import { createErrorMessage } from './utils/send-message-helpers'
import { forkConversationBeforeMessage } from './utils/conversation-fork'
import { isTurnBisectionRunning } from './utils/turn-snapshots'
import { getInputModeConfig } from './utils/input-modes'
import {
  addCustomOpenbuffProvider,
  handleOpenbuffProviderCommand,
  setupOpenbuffProviderFromArgs,
} from './utils/openbuff-provider'
import { getDiffStatsAsync, type DiffStats } from './utils/git'
import {
  peekIndexStatus,
  shouldForceStatusLineForIndex,
  type IndexStatusPeek,
} from './utils/index-status'

import {
  type ChatKeyboardState,
  createDefaultChatKeyboardState,
} from './utils/keyboard-actions'
import { loadLocalAgents } from './utils/local-agent-registry'
import { logger } from './utils/logger'
import {
  addClipboardPlaceholder,
  addPendingFileFromPath,
  addPendingFileMention,
  addPendingImageFromFile,
  validateAndAddImage,
  hasProcessingFiles,
  hasProcessingImages,
} from './utils/pending-attachments'
import { getLoadedSkills } from './utils/skill-registry'
import {
  getStatusIndicatorState,
  type AuthStatus,
} from './utils/status-indicator-state'
import { createPasteHandler, LONG_TEXT_THRESHOLD } from './utils/strings'
import { setTerminalTitle } from './utils/terminal-title'
import {
  computeInputLayoutMetrics,
  inputWrapColumns,
  multilineInputMeasurementKey,
} from './utils/text-layout'

import type { CommandResult } from './commands/command-registry'
import type { InputValue, PendingAttachment } from './types/store'
import type { MultilineInputHandle } from './components/multiline-input'
import type { MatchedSlashCommand } from './hooks/use-suggestion-engine'
import { type AgentMode } from './utils/constants'
import { useConfiguredModelName } from './hooks/use-configured-model-name'
import type { FileTreeNode } from '@codebuff/common/util/file'
import type {
  CompactionNotice,
  StatusBarContextUsage,
} from './utils/sdk-event-handlers'
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'
import {
  setExitStreamSignal,
  setQueuedPromptDrain,
} from './hooks/use-exit-handler'
import { createQueuedPromptDrainer } from './hooks/helpers/exit-queue-drain'
import { whenRegistriesReady } from './services/deferred-registries'
import { createJsonDocument } from './utils/output-document'
import { conversationUpdateKeys } from './utils/conversation-updates'
import { useConversationControls } from './hooks/use-conversation-controls'
import { retryPendingAttachment } from './utils/pending-attachments'

import {
  type MentionReplacement,
  resolveMentionReplacement,
  buildMentionReplacement,
} from './utils/mention-helpers'

/**
 * Policy for when the status-bar git diff-stats refresh may fork a git
 * subprocess across an isStreaming transition (wasStreaming → isStreaming).
 *
 * Pins the streaming hot-path invariant documented on the diff-stats effects
 * below: a stream never spawns git from this component. The steady-stream
 * half is enforced by the 10s interval poller gating on
 * `!isStreamingRef.current`; the falling edge applies this predicate
 * directly and refreshes exactly once. A regression that re-introduces
 * spawns during streaming must change this predicate's truth table or
 * bypass it, both reviewable in isolation.
 */
export function shouldSpawnDiffStatsForStreamingTransition(
  wasStreaming: boolean,
  isStreaming: boolean,
): boolean {
  return wasStreaming && !isStreaming
}

export const Chat = ({
  headerContent,
  initialPrompt,
  claimInitialPrompt,
  agentId,
  fileTree,
  fileInventoryState,
  inputRef,

  continueChat,
  continueChatId,
  authStatus,
  initialMode,
  gitRoot,
  onSwitchToGitRoot,
}: {
  headerContent: React.ReactNode
  initialPrompt: string | null
  claimInitialPrompt?: (prompt: string) => boolean
  agentId?: string
  fileTree: FileTreeNode[]
  fileInventoryState?: 'loading' | 'loaded' | 'unavailable'
  inputRef: React.MutableRefObject<MultilineInputHandle | null>

  continueChat: boolean
  continueChatId?: string
  authStatus: AuthStatus
  initialMode?: AgentMode
  gitRoot?: string | null
  onSwitchToGitRoot?: () => void
}) => {
  const [forceFileOnlyMentions, setForceFileOnlyMentions] = useState(false)
  const [modelRoutePickerOpen, setModelRoutePickerOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [promptHistoryOpen, setPromptHistoryOpen] = useState(false)
  const [queueScreenOpen, setQueueScreenOpen] = useState(false)
  const [attachmentManagerOpen, setAttachmentManagerOpen] = useState(false)
  const attachmentManagerOpenRef = useRef(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const modeMenuOpenRef = useRef(false)
  const readerRequest = useOutputReaderStore((state) => state.request)
  const transcriptHeaderRef = useRef<BoxRenderable | null>(null)
  const [transcriptTarget, setTranscriptTarget] = useState<{ messageId: string; token: number } | null>(null)
  const [unreadUpdates, setUnreadUpdates] = useState(0)
  const observedUpdates = useRef<Set<string> | null>(null)
  const wasReading = useRef(false)
  useLayoutEffect(() => {
    if (readerRequest || queueScreenOpen || attachmentManagerOpen) {
      useChatStore.getState().setInputFocused(false)
      wasReading.current = true
    } else if (wasReading.current) {
      wasReading.current = false
      useChatStore.getState().setInputFocused(true)
      inputRef.current?.focus()
    }
  }, [readerRequest, queueScreenOpen, attachmentManagerOpen, inputRef])
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const editOriginDraft = useRef<{
    input: InputValue
    attachments: PendingAttachment[]
  } | null>(null)
  const restoreEditDraft = useEvent(() => {
    const saved = editOriginDraft.current
    editOriginDraft.current = null
    setEditingMessageId(null)
    if (!saved) return
    const store = useChatStore.getState()
    store.setInputValue(saved.input)
    store.setInputFocused(true)
    const identity = (attachment: PendingAttachment) =>
      attachment.kind === 'image' ? attachment.path : attachment.id
    const existing = new Set(store.pendingAttachments.map(identity))
    for (const attachment of saved.attachments) {
      if (!existing.has(identity(attachment)))
        store.addPendingAttachment(attachment)
    }
    inputRef.current?.focus()
  })
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [planSessionPickerCommand, setPlanSessionPickerCommand] = useState<
    string | null
  >(null)

  const { validate: validateAgents } = useAgentValidation()

  // Subscribe to ask_user bridge to trigger form display
  useAskUserBridge()

  // Get chat state from extracted hook
  const {
    inputValue,
    cursorPosition,
    lastEditDueToNav,
    setInputValue,
    inputFocused,
    setInputFocused,
    slashSelectedIndex,
    setSlashSelectedIndex,
    agentSelectedIndex,
    setAgentSelectedIndex,
    focusedAgentId,
    setFocusedAgentId,
    messages,
    setMessages,
    agentMode,
    setAgentMode,
    toggleAgentMode,
    isRetrying,
    pendingBashMessages,
    refs: {
      activeAgentStreamsRef,
      isChainInProgressRef,
      activeSubagentsRef,
      abortControllerRef,
      sendMessageRef,
    },
  } = useChatState()

  const { statusMessage } = useClipboard()

  // Set initial mode from CLI flag on mount
  useEffect(() => {
    if (initialMode) {
      setAgentMode(initialMode)
    }
  }, [initialMode, setAgentMode])

  // Boot-window keystroke replay: main() captures stdin bytes typed before the
  // renderer existed (see utils/early-input-capture.ts) and stops the capture
  // just before creating the renderer, so this is the first component that can
  // receive them. consumeCapturedEarlyInput() is a one-shot TAKE — the module
  // clears its text when it hands it over — so a Chat remount (chatKey change)
  // can never replay the same text twice, and when there is nothing to replay
  // it returns undefined and this effect is a no-op.
  //
  // APPEND only, and deliberately NOT submitted: the user typed this text
  // before the input was live, so it belongs in the input box exactly where
  // they left it. This stays independent of the initialPrompt auto-submit flow
  // in use-chat-input.ts — that flow submits the CLI-flag prompt on its own
  // timer and does not read the input value, so the two never interact.
  //
  // lastEditDueToNav stays false: the append is a plain text edit, so the
  // history-navigation guards in use-chat-input treat it as user typing.
  useEffect(() => {
    const captured = consumeCapturedEarlyInput()
    if (captured) {
      setInputValue((prev) => ({
        text: prev.text + captured,
        cursorPosition: prev.text.length + captured.length,
        lastEditDueToNav: false,
      }))
    }
  }, [setInputValue])

  // Additional selector for active agent types to derive phase-aware status labels
  const activeAgentTypes = useChatStore((state) => state.activeAgentTypes)

  // Use extracted chat messages hook for message tree and pagination
  const {
    messageTree,
    visibleTopLevelMessages,
    hiddenMessageCount,
    handleCollapseToggle,
    isUserCollapsing,
    handleLoadPreviousMessages,
    handleToggleAll,
    revealMessage,
  } = useChatMessages({ messages, setMessages })

  // Use extracted UI hook for scroll, terminal dimensions, and theme
  const {
    scrollRef,
    scrollToLatest,
    scrollUp,
    scrollDown,
    adjustScrollTop,
    isAtBottomNow,
    scrollIntentRef,
    pauseFollowing,
    appliedScrollboxProps,
    isAtBottom,
    hasOverflow,
    terminalWidth,
    terminalHeight,
    separatorWidth,
    messageAvailableWidth,
    isCompactHeight,
    isNarrowWidth,
    theme,
    markdownPalette,
  } = useChatUI({
    messages,
    isUserCollapsing,
    readingPaused: readerRequest !== null || queueScreenOpen || attachmentManagerOpen,
  })
  const conversationControls = useConversationControls({
    scrollRef,
    enabled: () => !modeMenuOpenRef.current && !attachmentManagerOpenRef.current && useOutputReaderStore.getState().request === null && !queueScreenOpen && !commandPaletteOpen && !promptHistoryOpen && !modelRoutePickerOpen && !providerPickerOpen && !askUserState && !reviewMode,
    onEnter: () => { setInputFocused(false); pauseFollowing() },
    onLeave: () => { setInputFocused(true); inputRef.current?.focus() },
    onCommands: () => setCommandPaletteOpen(true),
    composerHasFocus: () => inputRef.current?.hasFocus?.() ?? true,
  })

  // P1-T9: the agent/skill registries load asynchronously after startup
  // (services/deferred-registries). The reads below happen once at mount, so
  // re-run them when the deferred loads settle — without this gate the
  // slash-command skill suggestions and the local agent list would observe
  // the (still-empty) registries and stay empty for the whole session.
  const [registriesLoaded, setRegistriesLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    void whenRegistriesReady().then(() => {
      if (!cancelled) setRegistriesLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const localAgents = useMemo(
    () => loadLocalAgents(agentMode),
    [agentMode, registriesLoaded],
  )
  const inputMode = useChatStore((state) => state.inputMode)
  const setInputMode = useChatStore((state) => state.setInputMode)
  const askUserState = useChatStore((state) => state.askUserState)

  // Get loaded skills for slash commands (re-read once the deferred
  // registry loads settle — see the registriesLoaded gate above).
  const loadedSkills = useMemo(() => getLoadedSkills(), [registriesLoaded])

  // Merge skill commands and game-dev preset commands into the slash command list
  const filteredSlashCommands = useMemo(() => {
    const allCommands = getSlashCommandsWithSkills(loadedSkills, fileTree)
    return allCommands
  }, [loadedSkills, fileTree])

  const {
    slashContext,
    mentionContext,
    slashMatches,
    agentMatches,
    fileMatches,
    slashSuggestionItems,
    agentSuggestionItems,
    fileSuggestionItems,
    fileSuggestionStatus,
    retryFileSuggestions,
  } = useSuggestionEngine({
    disableAgentSuggestions: forceFileOnlyMentions || inputMode !== 'default',
    inputValue: inputMode === 'bash' ? '' : inputValue,
    cursorPosition,
    slashCommands: filteredSlashCommands,
    localAgents,
    fileTree,
    currentAgentMode: agentMode,
  })

  useEffect(() => {
    if (!mentionContext.active) {
      setForceFileOnlyMentions(false)
    }
  }, [mentionContext.active])

  // Track when slash menu is activated
  const prevSlashActiveRef = useRef(false)
  useEffect(() => {
    if (slashContext.active && !prevSlashActiveRef.current) {
      trackEvent(AnalyticsEvent.SLASH_MENU_ACTIVATED, {
        queryLength: slashContext.query.length,
        matchCount: slashMatches.length,
        inputLength: inputValue.length,
      })
    }
    prevSlashActiveRef.current = slashContext.active
  }, [
    slashContext.active,
    slashContext.query,
    slashMatches.length,
    inputValue.length,
  ])

  // Reset suggestion menu indexes when context changes
  useEffect(() => {
    if (!slashContext.active) {
      setSlashSelectedIndex(0)
      return
    }
    setSlashSelectedIndex(0)
  }, [slashContext.active, slashContext.query, setSlashSelectedIndex])

  useEffect(() => {
    if (slashMatches.length > 0 && slashSelectedIndex >= slashMatches.length) {
      setSlashSelectedIndex(slashMatches.length - 1)
    }
    if (slashMatches.length === 0 && slashSelectedIndex !== 0) {
      setSlashSelectedIndex(0)
    }
  }, [slashMatches.length, slashSelectedIndex, setSlashSelectedIndex])

  useEffect(() => {
    if (!mentionContext.active) {
      setAgentSelectedIndex(0)
      return
    }
    setAgentSelectedIndex(0)
  }, [mentionContext.active, mentionContext.query, setAgentSelectedIndex])

  useEffect(() => {
    const totalMatches = agentMatches.length + fileMatches.length
    if (totalMatches > 0 && agentSelectedIndex >= totalMatches) {
      setAgentSelectedIndex(totalMatches - 1)
    }
    if (totalMatches === 0 && agentSelectedIndex !== 0) {
      setAgentSelectedIndex(0)
    }
  }, [
    agentMatches.length,
    fileMatches.length,
    agentSelectedIndex,
    setAgentSelectedIndex,
  ])

  const openFileMenuWithTab = useCallback(() => {
    const safeCursor = Math.max(0, Math.min(cursorPosition, inputValue.length))

    let wordStart = safeCursor
    while (wordStart > 0 && !/\s/.test(inputValue[wordStart - 1])) {
      wordStart--
    }

    const before = inputValue.slice(0, wordStart)
    const wordAtCursor = inputValue.slice(wordStart, safeCursor)
    const after = inputValue.slice(safeCursor)
    const mentionWord = wordAtCursor.startsWith('@')
      ? wordAtCursor
      : `@${wordAtCursor}`

    const text = `${before}${mentionWord}${after}`
    const nextCursor = before.length + mentionWord.length

    setInputValue({
      text,
      cursorPosition: nextCursor,
      lastEditDueToNav: false,
    })
    setForceFileOnlyMentions(true)
  }, [cursorPosition, inputValue, setInputValue])

  const { saveToHistory, navigateUp, navigateDown, resetHistoryNavigation } =
    useInputHistory(inputValue, setInputValue, { inputMode, setInputMode })

  // Use extracted streaming hook for connection, timer, queue, and exit handling
  const {
    isConnected,
    showReconnectionMessage,
    mainAgentTimer,
    timerStartTime,
    streamStatus,
    isWaitingForResponse,
    isStreaming,
    setStreamStatus,
    queuedMessages,
    queuePaused,
    streamMessageIdRef,
    queueError,
    queueAttachmentNotice,
    hasQueuedAttachmentReads,
    attachmentRemovalCount,
    getQueuedAttachmentRevision,
    updateQueuedAttachment,
    cancelQueuedAttachmentRetry,
    removeQueuedAttachment,
    undoQueuedAttachmentRemoval,
    queueRemovalCount,
    cancelQueuedMessages,
    updateQueuedMessage,
    removeQueuedMessage,
    moveQueuedMessage,
    undoQueueRemoval,
    addToQueue,
    stopStreaming,
    setCanProcessQueue,
    pauseQueue,
    resumeQueue,
    clearQueue,
    isQueuePausedRef,
    isProcessingQueueRef,
    queuedCount,
    shouldShowQueuePreview,
    queuePreviewTitle,
    pausedQueueText,
    inputPlaceholder,
    handleCtrlC,
    ensureQueueActiveBeforeSubmit,
    nextCtrlCWillExit,
  } = useChatStreaming({
    agentMode,
    inputValue,
    setInputValue,
    terminalWidth,
    separatorWidth,
    isChainInProgressRef,
    activeAgentStreamsRef,
    sendMessageRef,
  })

  // Exit-path queue drain (reliability finding exit-handler-drops-queued-prompts):
  // the Ctrl-C/SIGINT path exits through use-exit-handler, which has no
  // access to the queue; register the same drain the /exit command runs so
  // prompts queued during an active stream persist to session history
  // instead of being dropped on that path too. The drain body lives in
  // hooks/helpers/exit-queue-drain.ts so its partial-failure semantics stay
  // unit-testable.
  useEffect(() => {
    setExitStreamSignal(() => abortControllerRef.current?.signal)
    setQueuedPromptDrain(
      createQueuedPromptDrainer({
        pushMessageSnapshot: () =>
          useChatStore.getState().pushMessageSnapshot(),
        clearQueue,
        saveToHistory,
      }),
    )
    return () => {
      setExitStreamSignal(undefined)
      setQueuedPromptDrain(undefined)
    }
  }, [clearQueue, saveToHistory, abortControllerRef])

  // M4.3: Context-window usage for the status bar (updated via context_window
  // PrintModeEvent from the agent runtime).
  // Canonical shape (StatusBarContextUsage): its optional
  // `compactionTriggerTokens` is only present once the runtime reports its
  // model-aware compaction trigger budget on the context_window event.
  const [contextWindowUsage, setContextWindowUsage] =
    useState<StatusBarContextUsage | null>(null)

  // Accumulated context-compaction notice for the turn in progress (reset to
  // null when a new run starts, inside useSendMessage). Drives the status-bar
  // compaction chip.
  const [compactionNotice, setCompactionNotice] =
    useState<CompactionNotice | null>(null)

  // M9.3: Session-cost accumulator (sum of per-turn cost in cents from
  // onTotalCost callbacks). Model name + git diff-stats for the status bar.
  const [sessionCostCents, setSessionCostCents] = useState<number>(0)
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null)
  const [indexStatus, setIndexStatus] = useState<IndexStatusPeek>(null)

  // Resolve the model name for the active agent mode from the provider config.
  const modelName = useConfiguredModelName(
    agentMode,
    `${modelRoutePickerOpen}:${providerPickerOpen}:${registriesLoaded}`,
  )

  // Current isStreaming value, readable from the effects below so they do
  // not have to re-subscribe when it changes.
  const isStreamingRef = useRef(false)

  // Poll git diff stats: on mount and periodically while idle. The git call
  // runs off the render thread (getDiffStatsAsync). A per-effect AbortController
  // + cancelled flag ensures a late-resolving result after unmount does not
  // call setState, and only the latest in-flight refresh wins. The interval
  // callback is a no-op while isStreaming is true, so no git subprocess is
  // forked on the streaming hot path; the falling-edge effect below refreshes
  // exactly once when the stream completes.
  //
  // Streaming-path spawn count, before → after (the streaming half is
  // pinned by shouldSpawnDiffStatsForStreamingTransition below; counting
  // getDiffStatsAsync invocations while a stream is active verifies the
  // rest): a stream that holds isStreaming true for T seconds previously
  // forked floor(T / 10) extra git subprocesses from this interval, on top
  // of the one per falling edge — e.g. a 60s stream forked ≥6 spawns during
  // streaming plus 1 after, vs exactly 1 spawn (after) now. The index-status
  // poller below applies the same pause.
  useEffect(() => {
    const cwd = getProjectRoot() ?? process.cwd()
    let cancelled = false
    const controller = new AbortController()
    const refresh = () => {
      if (isStreamingRef.current) return
      getDiffStatsAsync({ cwd, signal: controller.signal })
        .then((stats) => {
          if (!cancelled) setDiffStats(stats)
        })
        .catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 10_000)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(interval)
    }
  }, [])
  // Refresh diff stats only on the falling edge of isStreaming (stream just
  // completed) via the pinned shouldSpawnDiffStatsForStreamingTransition
  // predicate. The shared ref doubles as the previous-value tracker, so the
  // rising edge still does not spawn — and then immediately abort — a
  // subprocess.
  useEffect(() => {
    const wasStreaming = isStreamingRef.current
    isStreamingRef.current = isStreaming
    if (
      !shouldSpawnDiffStatsForStreamingTransition(wasStreaming, isStreaming)
    ) {
      return
    }
    const cwd = getProjectRoot() ?? process.cwd()
    let cancelled = false
    const controller = new AbortController()
    getDiffStatsAsync({ cwd, signal: controller.signal })
      .then((stats) => {
        if (!cancelled) setDiffStats(stats)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [isStreaming])

  // Peek index status from the existing singleton (~2s). getStatus() may
  // schedule an age-stale refresh; do not call ensureBuilt() from the UI.
  // Pause polling while streaming to avoid unnecessary work on the hot path.
  useEffect(() => {
    if (isStreaming) return
    const refresh = () => setIndexStatus(peekIndexStatus())
    refresh()
    const interval = setInterval(refresh, 2_000)
    return () => clearInterval(interval)
  }, [isStreaming])

  // When streaming completes, flush any pending bash commands into history (ghost mode only)
  // Non-ghost mode commands are already in history and will be cleared when user sends next message
  useEffect(() => {
    if (
      !isStreaming &&
      !streamMessageIdRef.current &&
      !isChainInProgressRef.current &&
      pendingBashMessages.length > 0
    ) {
      // Only flush ghost mode commands (those not already added to history) to UI
      const ghostModeMessages = pendingBashMessages.filter(
        (msg) => !msg.isRunning && !msg.addedToHistory,
      )

      // Add ghost mode messages to UI history
      for (const msg of ghostModeMessages) {
        addBashMessageToHistory({
          command: msg.command,
          stdout: msg.stdout,
          stderr: msg.stderr ?? null,
          exitCode: msg.exitCode,
          cwd: msg.cwd || process.cwd(),
          setMessages,
        })
      }

      // Mark ghost mode messages as added to history (so they don't show as ghost UI)
      // but keep them in pendingBashMessages so they get sent to LLM with next user message
      if (ghostModeMessages.length > 0) {
        const ghostIds = new Set(ghostModeMessages.map((m) => m.id))
        useChatStore.setState((state) => ({
          pendingBashMessages: state.pendingBashMessages.map((m) =>
            ghostIds.has(m.id) ? { ...m, addedToHistory: true } : m,
          ),
        }))
      }
    }
  }, [isStreaming, pendingBashMessages, setMessages])

  const { sendMessage, clearMessages } = useSendMessage({
    inputRef,
    activeSubagentsRef,
    isChainInProgressRef,
    setStreamStatus,
    setContextWindowUsage,
    setCompactionNotice,
    setCanProcessQueue,
    abortControllerRef,
    agentId,
    onBeforeMessageSend: validateAgents,
    mainAgentTimer,
    scrollToLatest: (options) => {
      if (isProcessingQueueRef.current && !isAtBottomNow()) return
      scrollToLatest(options)
    },
    onTotalCost: (costCents) => setSessionCostCents((prev) => prev + costCents),
    onTimerEvent: () => {},
    isQueuePausedRef,
    isProcessingQueueRef,
    resumeQueue,
    continueChat,
    continueChatId,
  })

  sendMessageRef.current = sendMessage

  const onSubmitPrompt = useEvent(
    async (
      content: string,
      mode: AgentMode,
      options?: {
        preserveInputValue?: boolean
        editMessageId?: string
        preservePromptWhitespace?: boolean
        onAccepted?: () => void
        propagateError?: boolean
      },
    ) => {
      let preserveInput = options?.preserveInputValue === true
      const editId = options?.editMessageId
      if (
        editId &&
        (content.trim().startsWith('/') ||
          content.trim().startsWith('!') ||
          useChatStore.getState().inputMode !== 'default')
      ) {
        restoreEditDraft()
        preserveInput = true
      }
      let committedEdit = false
      if (editId && !preserveInput) {
        if (
          !content.trim() &&
          useChatStore.getState().pendingAttachments.length === 0
        )
          return
        if (
          isStreaming ||
          isChainInProgressRef.current ||
          streamMessageIdRef.current ||
          isTurnBisectionRunning() ||
          hasProcessingImages() ||
          hasProcessingFiles()
        ) {
          showClipboardMessage(
            'Wait for the current run and attachments, or stop the run before resending this edit.',
          )
          return
        }
        if (editId !== editingMessageId) return
        const current = useChatStore.getState()
        const fork = forkConversationBeforeMessage(
          current.runState,
          current.messages,
          editId,
        )
        if (fork.status !== 'ready') {
          showClipboardMessage(fork.reason, { durationMs: 5000 })
          return
        }
        current.pushMessageSnapshot()
        clearMessages(fork.runState)
        current.setMessages(fork.messages)
        setEditingMessageId(null)
        committedEdit = true
      }
      ensureQueueActiveBeforeSubmit()

      // P6.1: Guard the top-level submit path so an unexpected rejection is
      // caught, logged, and surfaced as a visible inline error message instead
      // of becoming an unhandled rejection that can crash the TUI. Action
      // submissions never write to the draft, even while awaiting a result.
      try {
        const submission = routeUserPrompt({
          abortControllerRef,
          agentMode: mode,
          inputRef,
          inputValue: content,
          preserveInputValue: preserveInput,
          preservePromptWhitespace: options?.preservePromptWhitespace,
          onPromptAccepted: options?.onAccepted,
          isChainInProgressRef,
          isStreaming,
          streamMessageIdRef,
          addToQueue,
          clearMessages,
          saveToHistory,
          scrollToLatest,
          sendMessage,
          setCanProcessQueue,
          setInputFocused,
          setInputValue,
          setMessages,
          stopStreaming,
        })
        // The send drains the edit's attachments before its first await.
        // Restore the earlier draft immediately; never restore after a run.
        if (committedEdit && useChatStore.getState().inputValue === '')
          restoreEditDraft()
        const result = await submission
        return result
      } catch (error) {
        logger.error(
          { error, contentLength: content.length, agentMode: mode },
          '[submit] Prompt submission failed with an unexpected error',
        )
        setMessages((prev) => [
          ...prev,
          createErrorMessage(
            '⚠️ Something went wrong while handling your message. Please try again.',
          ),
        ])
        setTimeout(() => scrollToLatest(), 0)
        if (options?.propagateError) throw error
        return undefined
      }
    },
  )

  const handleFollowupClick = useEvent((event: Event) => {
    const request = event as CustomEvent<import('./utils/followup-request').FollowupSubmissionDetail>
    const detail = request.detail
    if (!detail || typeof detail.complete !== 'function') return
    event.preventDefault()
    if (typeof detail.prompt !== 'string' || !Number.isInteger(detail.index) || typeof detail.toolCallId !== 'string') {
      detail.complete(false, 'This followup has invalid captured content.')
      return
    }
    if (modeMenuOpenRef.current || attachmentManagerOpenRef.current || conversationControls.activeRef.current ||
      useOutputReaderStore.getState().request !== null || queueScreenOpen || commandPaletteOpen ||
      promptHistoryOpen || modelRoutePickerOpen || providerPickerOpen || askUserState || reviewMode || planSessionPickerCommand) {
      detail.complete(false, 'Return to the conversation before sending this followup.')
      return
    }
    let accepted = false
    void onSubmitPrompt(detail.prompt, agentMode, {
      preserveInputValue: true,
      preservePromptWhitespace: true,
      propagateError: true,
      onAccepted: () => {
        if (accepted) return
        accepted = true
        useChatStore.getState().markFollowupClicked(detail.toolCallId, detail.index)
        trackEvent(AnalyticsEvent.FOLLOWUP_CLICKED, {
          promptLength: detail.prompt.length, index: detail.index, agentMode,
        })
        detail.complete(true)
      },
    }).then(() => {
      if (!accepted) detail.complete(false, 'The followup was not accepted. Check the conversation for the readiness or validation issue, then retry.')
    }).catch((error) => {
      detail.complete(false, error instanceof Error ? error.message : 'Failed to send this followup. Try again.')
    })
  })
  useEffect(() => {
    globalThis.addEventListener('codebuff:send-followup', handleFollowupClick)
    return () => globalThis.removeEventListener('codebuff:send-followup', handleFollowupClick)
  }, [handleFollowupClick])

  // handleSlashItemClick is defined later after feedback/publish stores are available

  const handleMentionItemClick = useCallback(
    (index: number) => {
      if (mentionContext.startIndex < 0) return

      const resolved = resolveMentionReplacement(
        index,
        agentMatches,
        fileMatches,
        false,
      )
      if (!resolved) return
      if (resolved.selectedFile) {
        addPendingFileMention(
          resolved.selectedFile.filePath,
          resolved.selectedFile.isDirectory,
          getProjectRoot(),
        )
      }
      const { text, cursorPosition } = buildMentionReplacement(
        inputValue,
        mentionContext.startIndex,
        mentionContext.query,
        resolved.replacement,
      )
      setInputValue({ text, cursorPosition, lastEditDueToNav: false })
      setAgentSelectedIndex(0)
    },
    [
      mentionContext,
      agentMatches,
      fileMatches,
      inputValue,
      setInputValue,
      setAgentSelectedIndex,
    ],
  )

  const { inputWidth, handleBuildFast } = useChatInput({
    agentMode,
    setAgentMode,
    separatorWidth,
    initialPrompt,
    claimInitialPrompt,
    onSubmitPrompt,
    isCompactHeight,
    isNarrowWidth,
    modeWidthAdjustment: getInputModeConfig(inputMode).widthAdjustment,
  })

  const {
    feedbackMode,
    feedbackText,
    openFeedbackForMessage,
    closeFeedback,
    saveCurrentInput,
    restoreSavedInput,
    setFeedbackText,
  } = useFeedbackStore(
    useShallow((state) => ({
      feedbackMode: state.feedbackMode,
      feedbackText: state.feedbackText,
      openFeedbackForMessage: state.openFeedbackForMessage,
      closeFeedback: state.closeFeedback,
      saveCurrentInput: state.saveCurrentInput,
      restoreSavedInput: state.restoreSavedInput,
      setFeedbackText: state.setFeedbackText,
    })),
  )

  const { publishMode, openPublishMode, closePublish, preSelectAgents } =
    usePublishStore(
      useShallow((state) => ({
        publishMode: state.publishMode,
        openPublishMode: state.openPublishMode,
        closePublish: state.closePublish,
        preSelectAgents: state.preSelectAgents,
      })),
    )

  const { reviewMode, closeReviewScreen } = useReviewStore(
    useShallow((state) => ({
      reviewMode: state.reviewMode,
      closeReviewScreen: state.closeReviewScreen,
    })),
  )

  const publishMutation = usePublishMutation()

  const handleCommandResult = useCallback(
    (result?: CommandResult) => {
      if (!result) return

      if (result.openFeedbackMode) {
        // Save the feedback text that was set by the command handler before opening feedback mode
        const { feedbackText, feedbackCursor } = useFeedbackStore.getState()
        saveCurrentInput('', 0)
        openFeedbackForMessage(null)
        // Restore the prefilled text after openFeedbackForMessage resets it
        if (feedbackText) {
          useFeedbackStore.getState().setFeedbackText(feedbackText)
          useFeedbackStore.getState().setFeedbackCursor(feedbackCursor)
        }
      }

      if (result.openPublishMode) {
        if (result.preSelectAgents && result.preSelectAgents.length > 0) {
          // preSelectAgents already sets publishMode: true, so don't call openPublishMode
          // which would reset the selectedAgentIds
          preSelectAgents(result.preSelectAgents)
        } else {
          openPublishMode()
        }
      }

      if (result.openChatHistory) {
        useChatHistoryStore.getState().openChatHistory()
      }

      if (result.openPromptHistorySearch) {
        setPromptHistoryOpen(true)
      }

      if (result.openModelRoutePicker) {
        setModelRoutePickerOpen(true)
      }

      if (result.openProviderPicker) {
        setProviderPickerOpen(true)
      }

      if (result.openPlanSessionPicker) {
        setPlanSessionPickerCommand(result.openPlanSessionPicker)
      }

      if (result.openReviewScreen) {
        useReviewStore.getState().openReviewScreen()
      }
    },
    [
      saveCurrentInput,
      openFeedbackForMessage,
      openPublishMode,
      preSelectAgents,
      setPromptHistoryOpen,
    ],
  )

  // Helper to apply insertText for slash commands - returns true if handled
  const applySlashInsertText = useCallback(
    (selected: MatchedSlashCommand): boolean => {
      if (selected.insertText != null && slashContext.startIndex >= 0) {
        const before = inputValue.slice(0, slashContext.startIndex)
        const after = inputValue.slice(
          slashContext.startIndex + 1 + slashContext.query.length,
        )
        setInputValue({
          text: before + selected.insertText + after,
          cursorPosition: before.length + selected.insertText.length,
          lastEditDueToNav: false,
        })
        setSlashSelectedIndex(0)
        return true
      }
      return false
    },
    [slashContext, inputValue, setInputValue, setSlashSelectedIndex],
  )

  // Click handler for slash menu items - executes command or inserts text
  const handleSlashItemClick = useCallback(
    async (index: number) => {
      const selected = slashMatches[index]
      if (!selected) return

      // If the command has insertText, insert it instead of executing
      if (applySlashInsertText(selected)) return

      // Execute the selected slash command immediately
      const commandString = `/${selected.id}`
      setSlashSelectedIndex(0)

      const result = await onSubmitPrompt(commandString, agentMode)
      handleCommandResult(result)
    },
    [
      slashMatches,
      applySlashInsertText,
      setSlashSelectedIndex,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
    ],
  )

  const inputValueRef = useRef(inputValue)
  const cursorPositionRef = useRef(cursorPosition)
  // Sync refs synchronously during render — no useEffect needed, avoids
  // scheduling overhead on the hot keystroke path.
  inputValueRef.current = inputValue
  cursorPositionRef.current = cursorPosition

  const handleOpenFeedbackForMessage = useCallback(
    (
      id: string | null,
      options?: {
        category?: FeedbackCategory
        footerMessage?: string
        errors?: Array<{ id: string; message: string }>
      },
    ) => {
      saveCurrentInput(inputValueRef.current, cursorPositionRef.current)
      openFeedbackForMessage(id, options)
    },
    [saveCurrentInput, openFeedbackForMessage],
  )

  const handleMessageFeedback = useCallback(
    (
      id: string,
      options?: {
        category?: FeedbackCategory
        footerMessage?: string
        errors?: Array<{ id: string; message: string }>
      },
    ) => {
      handleOpenFeedbackForMessage(id, options)
    },
    [handleOpenFeedbackForMessage],
  )

  // Edit & resend: capture the edited message id at click time so a re-render
  // between click and submit cannot desync the truncation index lookup.
  const handleEditMessage = useCallback(
    (messageId: string, content: string) => {
      if (hasProcessingImages() || hasProcessingFiles()) {
        showClipboardMessage(
          'Wait for attachments to finish before editing an earlier prompt.',
        )
        return
      }
      if (!editOriginDraft.current) {
        const current = useChatStore.getState()
        editOriginDraft.current = {
          input: {
            text: current.inputValue,
            cursorPosition: current.cursorPosition,
            lastEditDueToNav: current.lastEditDueToNav,
          },
          attachments: [...current.pendingAttachments],
        }
        current.clearPendingAttachments()
      }
      setEditingMessageId(messageId)
      setInputValue({
        text: content,
        cursorPosition: content.length,
        lastEditDueToNav: false,
      })
      setInputFocused(true)
      inputRef.current?.focus()
    },
    [setInputValue, setInputFocused, inputRef],
  )

  // Insert a command (e.g. a plan block command) into the input without
  // submitting. Sets the text, positions the cursor at the end, and focuses
  // the input so the user can hit Enter to submit or edit the text first.
  const handleInsertCommand = useCallback(
    (command: string) => {
      restoreEditDraft()
      setInputValue({
        text: command,
        cursorPosition: command.length,
        lastEditDueToNav: false,
      })
      setInputFocused(true)
      inputRef.current?.focus()
    },
    [setInputValue, setInputFocused, inputRef, restoreEditDraft],
  )

  const handleExitFeedback = useCallback(() => {
    const { value, cursor } = restoreSavedInput()
    setInputValue({
      text: value,
      cursorPosition: cursor,
      lastEditDueToNav: false,
    })
    setInputFocused(true)
    resetHistoryNavigation()
  }, [
    restoreSavedInput,
    setInputValue,
    setInputFocused,
    resetHistoryNavigation,
  ])

  const handleCloseFeedback = useCallback(() => {
    closeFeedback()
    handleExitFeedback()
  }, [closeFeedback, handleExitFeedback])

  const handleExitPublish = useCallback(() => {
    closePublish()
    setInputFocused(true)
  }, [closePublish, setInputFocused])

  const handleReviewOptionSelect = useCallback(
    (reviewText: string) => {
      closeReviewScreen()
      setInputFocused(true)
      // Submit the review request
      onSubmitPrompt(reviewText, agentMode)
        .then((result) => handleCommandResult(result))
        .catch((error) => {
          logger.error({ error }, '[review] Failed to submit review prompt')
          showClipboardMessage('Failed to send review request', {
            durationMs: 3000,
          })
        })
    },
    [
      closeReviewScreen,
      setInputFocused,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
    ],
  )

  const handleCloseReviewScreen = useCallback(() => {
    closeReviewScreen()
    setInputFocused(true)
  }, [closeReviewScreen, setInputFocused])

  const handleReviewCustom = useCallback(() => {
    closeReviewScreen()
    setInputMode('review')
    setInputFocused(true)
  }, [closeReviewScreen, setInputMode, setInputFocused])

  const handlePublish = useCallback(
    async (agentIds: string[]) => {
      await publishMutation.mutateAsync(agentIds)
    },
    [publishMutation],
  )

  // Focus the composer only while its conversation scope is visible.
  useEffect(() => {
    if (readerRequest || queueScreenOpen || attachmentManagerOpen || commandPaletteOpen || promptHistoryOpen ||
      modelRoutePickerOpen || providerPickerOpen || askUserState || reviewMode || planSessionPickerCommand || modeMenuOpen ||
      conversationControls.activeRef.current) return
    inputRef.current?.focus()
  }, [feedbackMode, askUserState, readerRequest, queueScreenOpen, attachmentManagerOpen, commandPaletteOpen,
    promptHistoryOpen, modelRoutePickerOpen, providerPickerOpen, reviewMode, planSessionPickerCommand, modeMenuOpen, inputRef])

  const handleSubmit = useCallback(async (latest?: InputValue) => {
    if (modeMenuOpenRef.current || attachmentManagerOpenRef.current || conversationControls.activeRef.current || useOutputReaderStore.getState().request !== null) return
    // Update terminal title with truncated user input
    if (inputValue.trim()) {
      setTerminalTitle(inputValue)
    }
    const result = await onSubmitPrompt(latest?.text ?? useChatStore.getState().inputValue, agentMode, {
      editMessageId: editingMessageId ?? undefined,
    })
    handleCommandResult(result)
  }, [
    onSubmitPrompt,
    inputValue,
    agentMode,
    handleCommandResult,
    editingMessageId,
  ])

  const totalMentionMatches = agentMatches.length + fileMatches.length
  const historyNavUpEnabled =
    lastEditDueToNav ||
    (cursorPosition === 0 &&
      ((slashContext.active && slashSelectedIndex === 0) ||
        (mentionContext.active && agentSelectedIndex === 0) ||
        (!slashContext.active && !mentionContext.active)))
  const historyNavDownEnabled =
    lastEditDueToNav ||
    (cursorPosition === inputValue.length &&
      ((slashContext.active &&
        slashSelectedIndex === slashMatches.length - 1) ||
        (mentionContext.active &&
          agentSelectedIndex === totalMentionMatches - 1) ||
        (!slashContext.active && !mentionContext.active)))

  // Build keyboard state from store values
  const chatKeyboardState: ChatKeyboardState = useMemo(
    () => ({
      ...createDefaultChatKeyboardState(),
      inputMode,
      inputValue: feedbackMode ? feedbackText : inputValue,
      cursorPosition,
      isStreaming,
      isWaitingForResponse,
      feedbackMode,
      focusedAgentId,
      slashMenuActive: slashContext.active,
      mentionMenuActive: mentionContext.active,
      slashSelectedIndex,
      agentSelectedIndex,
      slashMatchesLength: slashMatches.length,
      totalMentionMatches: agentMatches.length + fileMatches.length,
      disableSlashSuggestions:
        getInputModeConfig(inputMode).disableSlashSuggestions,
      historyNavUpEnabled,
      historyNavDownEnabled,
      nextCtrlCWillExit,
      queuePaused,
      queuedCount,
      editingMessageId,
    }),
    [
      inputMode,
      inputValue,
      feedbackText,
      cursorPosition,
      isStreaming,
      isWaitingForResponse,
      feedbackMode,
      focusedAgentId,
      slashContext.active,
      mentionContext.active,
      slashSelectedIndex,
      agentSelectedIndex,
      slashMatches.length,
      agentMatches.length,
      fileMatches.length,
      historyNavUpEnabled,
      historyNavDownEnabled,
      nextCtrlCWillExit,
      queuePaused,
      queuedCount,
      editingMessageId,
    ],
  )

  const handlePasteLongText = useCallback((pastedText: string) => {
    const id = crypto.randomUUID()
    const preview = pastedText.slice(0, 100).replace(/\n/g, ' ')
    useChatStore.getState().addPendingTextAttachment({
      id,
      content: pastedText,
      preview,
      charCount: pastedText.length,
    })
    showClipboardMessage(
      `📋 Pasted text (${pastedText.length.toLocaleString()} chars)`,
      { durationMs: 5000 },
    )
  }, [])

  // Keyboard handlers
  const chatKeyboardHandlers: ChatKeyboardHandlers = useMemo(
    () => ({
      onExitInputMode: () => setInputMode('default'),
      onExitFeedbackMode: handleCloseFeedback,
      onClearFeedbackInput: () => {
        setFeedbackText('')
        useFeedbackStore.getState().setFeedbackCursor(0)
      },
      onClearInput: () =>
        editingMessageId
          ? restoreEditDraft()
          : setInputValue({
              text: '',
              cursorPosition: 0,
              lastEditDueToNav: false,
            }),
      onCancelEdit: restoreEditDraft,
      onBackspaceExitMode: () => setInputMode('default'),
      onInterruptStream: () => {
        abortControllerRef.current?.abort()
        if (queuedMessages.length > 0) {
          pauseQueue()
        }
      },
      onSlashMenuDown: () => setSlashSelectedIndex((prev) => prev + 1),
      onSlashMenuUp: () => setSlashSelectedIndex((prev) => prev - 1),
      onSlashMenuTab: () => {
        // Do nothing if there's only one match - user needs to press Enter to select
        if (slashMatches.length <= 1) return
        setSlashSelectedIndex((prev) => (prev + 1) % slashMatches.length)
      },
      onSlashMenuShiftTab: () =>
        setSlashSelectedIndex(
          (prev) => (slashMatches.length + prev - 1) % slashMatches.length,
        ),
      onSlashMenuSelect: async () => {
        const selected = slashMatches[slashSelectedIndex] || slashMatches[0]
        if (!selected) return

        // If the command has insertText, insert it instead of executing
        if (applySlashInsertText(selected)) return

        // Execute the selected slash command immediately
        const commandString = `/${selected.id}`
        setSlashSelectedIndex(0)

        const result = await onSubmitPrompt(commandString, agentMode)

        handleCommandResult(result)
      },
      onSlashMenuComplete: () => {
        // Complete the word without executing - same as clicking on the item
        const selected = slashMatches[slashSelectedIndex] || slashMatches[0]
        if (!selected || slashContext.startIndex < 0) return

        // If the command has insertText, insert it instead of the command
        if (applySlashInsertText(selected)) return

        const before = inputValue.slice(0, slashContext.startIndex)
        const after = inputValue.slice(
          slashContext.startIndex + 1 + slashContext.query.length,
        )
        const replacement = `/${selected.id} `
        setInputValue({
          text: before + replacement + after,
          cursorPosition: before.length + replacement.length,
          lastEditDueToNav: false,
        })
        setSlashSelectedIndex(0)
      },
      onMentionMenuDown: () => setAgentSelectedIndex((prev) => prev + 1),
      onMentionMenuUp: () => setAgentSelectedIndex((prev) => prev - 1),
      onMentionMenuTab: () => {
        const totalMatches = agentMatches.length + fileMatches.length
        if (totalMatches === 0) return
        setAgentSelectedIndex((prev) => (prev + 1) % totalMatches)
      },
      onMentionMenuShiftTab: () => {
        const totalMatches = agentMatches.length + fileMatches.length
        if (totalMatches === 0) return
        setAgentSelectedIndex(
          (prev) => (totalMatches + prev - 1) % totalMatches,
        )
      },
      onMentionMenuSelect: () => {
        if (mentionContext.startIndex < 0) return

        const trySelectAtIndex = (index: number): boolean => {
          const resolved = resolveMentionReplacement(
            index,
            agentMatches,
            fileMatches,
            false,
          )
          if (!resolved) return false
          if (resolved.selectedFile) {
            addPendingFileMention(
              resolved.selectedFile.filePath,
              resolved.selectedFile.isDirectory,
              getProjectRoot(),
            )
          }
          const { text, cursorPosition } = buildMentionReplacement(
            inputValue,
            mentionContext.startIndex,
            mentionContext.query,
            resolved.replacement,
          )
          setInputValue({ text, cursorPosition, lastEditDueToNav: false })
          setAgentSelectedIndex(0)
          return true
        }

        // Try current selection, fall back to first item
        trySelectAtIndex(agentSelectedIndex) || trySelectAtIndex(0)
      },
      onMentionMenuComplete: () => {
        // Complete the word without executing - same as select for mentions
        if (mentionContext.startIndex < 0) return

        const resolved = resolveMentionReplacement(
          agentSelectedIndex,
          agentMatches,
          fileMatches,
          true,
        )
        if (!resolved) return
        if (resolved.selectedFile) {
          addPendingFileMention(
            resolved.selectedFile.filePath,
            resolved.selectedFile.isDirectory,
            getProjectRoot(),
          )
        }
        const { text, cursorPosition } = buildMentionReplacement(
          inputValue,
          mentionContext.startIndex,
          mentionContext.query,
          resolved.replacement,
        )
        setInputValue({ text, cursorPosition, lastEditDueToNav: false })
        setAgentSelectedIndex(0)
      },
      onOpenFileMenuWithTab: () => {
        const safeCursor = Math.max(
          0,
          Math.min(cursorPosition, inputValue.length),
        )
        let wordStart = safeCursor
        while (wordStart > 0 && !/\s/.test(inputValue[wordStart - 1]!)) {
          wordStart--
        }
        if (wordStart < safeCursor) {
          openFileMenuWithTab()
          return true
        }
        return false
      },
      onHistoryUp: navigateUp,
      onHistoryDown: navigateDown,
      onToggleAgentMode: toggleAgentMode,
      onUnfocusAgent: () => {
        setFocusedAgentId(null)
        setInputFocused(true)
        inputRef.current?.focus()
      },
      onClearQueue: cancelQueuedMessages,
      onExitAppWarning: () => handleCtrlC(),
      onExitApp: () => handleCtrlC(),
      onBashHistoryUp: navigateUp,
      onBashHistoryDown: navigateDown,
      onPasteImage: () => {
        const placeholderPath = addClipboardPlaceholder()

        // Process the image in the background
        setTimeout(() => {
          const result = readClipboardImage()
          if (!result.success || !result.imagePath) {
            useChatStore.getState().removePendingImage(placeholderPath)
            showClipboardMessage(result.error || 'Failed to paste image', {
              durationMs: 3000,
            })
            return
          }

          const cwd = getProjectRoot() ?? process.cwd()
          addPendingImageFromFile(result.imagePath, cwd, placeholderPath).catch(
            (error) => {
              logger.error({ error }, 'Failed to add pending image from file')
              showClipboardMessage('Failed to add image', { durationMs: 3000 })
            },
          )
        }, 0)
      },
      onPasteImagePath: (imagePath: string) => {
        const cwd = getProjectRoot() ?? process.cwd()
        validateAndAddImage(imagePath, cwd).catch((error) => {
          logger.error({ error, imagePath }, 'Failed to validate and add image')
          showClipboardMessage('Failed to add image', { durationMs: 3000 })
        })
      },
      onPasteFilePath: (filePath: string, isDirectory: boolean) => {
        addPendingFileFromPath(filePath, isDirectory)
      },
      onPasteText: (text: string) => {
        if (text.length > LONG_TEXT_THRESHOLD) {
          handlePasteLongText(text)
          return
        }

        setInputValue((prev) => {
          const before = prev.text.slice(0, prev.cursorPosition)
          const after = prev.text.slice(prev.cursorPosition)
          return {
            text: before + text + after,
            cursorPosition: before.length + text.length,
            lastEditDueToNav: false,
          }
        })
      },
      onScrollUp: scrollUp,
      onScrollDown: scrollDown,
      onToggleAll: handleToggleAll,
      onToggleCommandPalette: () => setCommandPaletteOpen((prev) => !prev),
      onTogglePromptHistory: () => setPromptHistoryOpen((prev) => !prev),
    }),
    [
      handleCloseFeedback,
      setFeedbackText,
      setInputValue,
      abortControllerRef,
      queuedMessages.length,
      pauseQueue,
      setSlashSelectedIndex,
      slashMatches,
      slashSelectedIndex,
      slashContext,
      inputValue,
      applySlashInsertText,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
      setAgentSelectedIndex,
      agentMatches,
      fileMatches,
      agentSelectedIndex,
      mentionContext,
      cursorPosition,
      openFileMenuWithTab,
      navigateUp,
      navigateDown,
      toggleAgentMode,
      setFocusedAgentId,
      setInputFocused,
      inputRef,
      handleCtrlC,
      cancelQueuedMessages,
      scrollUp,
      scrollDown,
      handleToggleAll,
      editingMessageId,
      restoreEditDraft,
      handlePasteLongText,
      setPromptHistoryOpen,
    ],
  )

  // Use the chat keyboard hook
  useChatKeyboard({
    state: chatKeyboardState,
    handlers: chatKeyboardHandlers,
    isDisabled: () => modeMenuOpenRef.current || attachmentManagerOpenRef.current || conversationControls.activeRef.current || inputRef.current?.hasFocus?.() === false || useOutputReaderStore.getState().request !== null,
    disabled:
      modeMenuOpen ||
      attachmentManagerOpen ||
      conversationControls.active ||
      readerRequest !== null ||
      queueScreenOpen ||
      askUserState !== null ||
      reviewMode ||
      commandPaletteOpen ||
      promptHistoryOpen ||
      modelRoutePickerOpen ||
      providerPickerOpen ||
      planSessionPickerCommand !== null,
  })
  useLayoutEffect(() => {
    if ((readerRequest || queueScreenOpen || attachmentManagerOpen || commandPaletteOpen || promptHistoryOpen || modelRoutePickerOpen || providerPickerOpen || askUserState || reviewMode || planSessionPickerCommand) && conversationControls.activeRef.current)
      conversationControls.leave(false)
  }, [readerRequest, queueScreenOpen, attachmentManagerOpen, commandPaletteOpen, promptHistoryOpen, modelRoutePickerOpen, providerPickerOpen, askUserState, reviewMode, planSessionPickerCommand, conversationControls.leave])

  // Sync message block context to zustand store for child components
  const setMessageBlockContext = useMessageBlockStore(
    (state) => state.setContext,
  )
  const setMessageBlockCallbacks = useMessageBlockStore(
    (state) => state.setCallbacks,
  )
  useEffect(() => {
    useMessageBlockStore.getState().pruneViews(messages.map((message) => message.id))
  }, [messages])

  // Update context when values change - useLayoutEffect ensures synchronous updates
  // to prevent message loss during rapid streaming (race condition fix)
  useLayoutEffect(() => {
    setMessageBlockContext({
      theme,
      markdownPalette,
      messageTree,
      isWaitingForResponse,
      timerStartTime,
      availableWidth: messageAvailableWidth,
    })
  }, [
    theme,
    markdownPalette,
    messageTree,
    isWaitingForResponse,
    timerStartTime,
    messageAvailableWidth,
    setMessageBlockContext,
  ])

  // Update callbacks once (they're stable)
  useEffect(() => {
    setMessageBlockCallbacks({
      onToggleCollapsed: handleCollapseToggle,
      onBuildFast: handleBuildFast,
      onFeedback: handleMessageFeedback,
      onCloseFeedback: handleCloseFeedback,
      onEditMessage: handleEditMessage,
      onInsertCommand: handleInsertCommand,
    })
  }, [
    handleCollapseToggle,
    handleBuildFast,
    handleMessageFeedback,
    handleCloseFeedback,
    handleEditMessage,
    handleInsertCommand,
    setMessageBlockCallbacks,
  ])

  const modeConfig = getInputModeConfig(inputMode)
  const hasSlashSuggestions =
    slashContext.active &&
    slashSuggestionItems.length > 0 &&
    !modeConfig.disableSlashSuggestions
  const hasMentionSuggestions =
    !slashContext.active &&
    mentionContext.active &&
    (agentSuggestionItems.length > 0 ||
      fileSuggestionItems.length > 0 ||
      fileSuggestionStatus !== 'idle')
  const hasSuggestionMenu = hasSlashSuggestions || hasMentionSuggestions
  const mentionSuggestionState = getMentionSuggestionStatus({
    active: mentionContext.active,
    fileStatus: fileSuggestionStatus,
    agentMatchCount: agentSuggestionItems.length,
    fileMatchCount: fileSuggestionItems.length,
  })

  const { metrics: inputLayoutMetrics, measurementKey: inputMeasurementKey } =
    useMemo(() => {
      // In bash mode, layout is based on the actual input (no ! prefix needed)
      const text = inputValue ?? ''
      // An empty input still occupies one row, so the row count is measured from a
      // single space. The measurement KEY is derived from the raw `text` (no
      // substitution): the box compares it against the key IT derives from the
      // value prop it was handed, which is also the raw value, so the two
      // identities agree on the idle empty frame — the space never enters the
      // identity, only the row count.
      const layoutContent = text.length > 0 ? text : ' '
      const safeCursor = Math.max(
        0,
        Math.min(cursorPosition, layoutContent.length),
      )
      // Measure at the columns the text actually wraps at. MultilineInput draws
      // inside its own 1-column horizontal wrapper padding, so measuring at the
      // outer inputWidth here would count fewer rows than the box renders — and
      // that disagreement is what let a wrapped value still be treated as
      // single-line (centered) while the box needed several rows.
      //
      // `inputWrapColumns` is the ONE definition of that subtraction: the box
      // derives the columns it checks the forwarded key against from the same
      // helper, so the two cannot drift by a column and the row count computed
      // here is exactly the one the box would compute — that equality is what
      // lets the box reuse this measurement instead of re-wrapping the same
      // value on every keystroke.
      const cols = inputWrapColumns(inputWidth)
      return {
        metrics: computeInputLayoutMetrics({
          layoutContent,
          // The metrics only ever need the offset: slicing the prefix string here
          // allocated an O(cursor) copy on every keystroke and cursor move just to
          // hand over its length.
          cursorOffset: safeCursor,
          cols,
          // UNCAPPLED row measurement. The forwarded `totalLines` is a PRE-CLAMP row
          // fact: chat-input-bar forwards it to two MultilineInput mounts that are
          // given different `maxHeight`s, and each box derives its own height AND
          // its own `isScrollable` by comparing that row count against the cap it
          // actually draws with. Measuring to a cap here would saturate the count at
          // this caller's cap, and a box with a taller cap would then be told the
          // content fits on a frame where it must scroll. This caller's own
          // centering decision is clamped separately below.
          maxHeight: Number.MAX_SAFE_INTEGER,
        }),
        // Supplied to the box as the identity of the measurement: a producer-side
        // key over the same raw value and columns the box derives its own key
        // from. The box trusts the forwarded count only while the two keys
        // match, which is what turns a stale or wrong-width count into one extra
        // local wrap pass instead of a mis-sized box.
        measurementKey: multilineInputMeasurementKey(text, cols),
      }
    }, [inputValue, cursorPosition, inputWidth])
  // The screen still owns a ceiling for its own layout decision ("is the input
  // taller than the box I give it"), applied to the uncapped row fact rather
  // than baked into the measurement the box consumes.
  const inputHeightCap = Math.floor(terminalHeight / 2)
  const inputHeightLines = Math.min(
    inputLayoutMetrics.heightLines,
    Math.max(1, inputHeightCap),
  )
  const isMultilineInput = inputLayoutMetrics.totalLines > 1
  const shouldCenterInputVertically = !hasSuggestionMenu && !isMultilineInput
  const statusIndicatorState = getStatusIndicatorState({
    statusMessage: null,
    streamStatus,
    nextCtrlCWillExit,
    isConnected,
    authStatus,
    showReconnectionMessage,
    isRetrying,
    isAskUserActive: askUserState !== null,
    activeAgentTypes,
  })
  const hasStatusIndicatorContent =
    statusIndicatorState.kind !== 'idle' || Boolean(statusMessage)

  const inputBoxTitle = useMemo(() => {
    const segments: string[] = []

    if (queuePreviewTitle) {
      segments.push(queuePreviewTitle)
    } else if (pausedQueueText) {
      segments.push(`⏸ ${pausedQueueText}`)
    }

    if (segments.length === 0) {
      return undefined
    }

    return ` ${segments.join('   ')} `
  }, [queuePreviewTitle, pausedQueueText])

  const shouldShowStatusLine =
    !feedbackMode &&
    (hasStatusIndicatorContent ||
      shouldShowQueuePreview ||
      shouldForceStatusLineForIndex(indexStatus) ||
      !isAtBottom)
  useEffect(() => {
    const keys = conversationUpdateKeys(messages)
    const observed = observedUpdates.current
    const unseen = observed ? [...keys].filter((key) => !observed.has(key)).length : 0
    observedUpdates.current = keys
    if (isAtBottom && !readerRequest && !queueScreenOpen) setUnreadUpdates(0)
    else if (unseen) setUnreadUpdates((previous) => previous + unseen)
  }, [messages, isAtBottom, readerRequest, queueScreenOpen])

  const handleCloseModelRoutePicker = useCallback(() => {
    setModelRoutePickerOpen(false)
    setInputFocused(true)
  }, [setInputFocused])

  const handleProviderPickerSelect = useCallback(
    async (selection: ProviderPickerSelection) => {
      if (selection.type === 'cancel') {
        setProviderPickerOpen(false)
        setInputFocused(true)
        return
      }

      if (selection.type === 'test-connections') return

      let message: string
        if (selection.type === 'preset') {
          message = setupOpenbuffProviderFromArgs(selection.preset)
        } else if (selection.type === 'connect-codex') {
          const setupMessage = setupOpenbuffProviderFromArgs('codex')
          const connectResult =
            await handleOpenbuffProviderCommand('connect codex')
          message = `${setupMessage}\n\n${connectResult.message}`
          if (connectResult.connectCodex) {
            setInputMode('connect:chatgpt')
          }
        } else {
          message = addCustomOpenbuffProvider(selection.provider)
        }
      setProviderPickerOpen(false)
      setInputFocused(true)
      setMessages((prev) => [...prev, getSystemMessage(message)])
    },
    [setInputFocused, setInputMode, setMessages],
  )

  const handlePlanSessionPickerCancel = useCallback(() => {
    setPlanSessionPickerCommand(null)
    setInputFocused(true)
  }, [setInputFocused])

  const handlePlanSessionPickerSelect = useCallback(
    (sessionDir: string) => {
      const command = planSessionPickerCommand
      if (!command) return

      setPlanSessionPickerCommand(null)
      setInputFocused(true)

      // Picker-driven resume previously submitted with the mode captured when
      // the picker opened. Switch first so both the visible persistent toggle
      // and command routing enter EXECUTE_PLAN immediately.
      const submitMode = command === 'resume-plan' ? 'EXECUTE_PLAN' : agentMode
      if (command === 'resume-plan') {
        setAgentMode('EXECUTE_PLAN')
      }

      onSubmitPrompt(`/${command} ${sessionDir}`, submitMode)
        .then((result) => handleCommandResult(result))
        .catch((error) => {
          logger.error(
            { error, command, sessionDir },
            '[plan-session-picker] Failed to submit selected plan session',
          )
          showClipboardMessage('Failed to open plan session', {
            durationMs: 3000,
          })
        })
    },
    [
      planSessionPickerCommand,
      setInputFocused,
      onSubmitPrompt,
      agentMode,
      setAgentMode,
      handleCommandResult,
    ],
  )

  // Model route picker is a full-screen overlay — skip rendering chat UI
  // to avoid keyboard event conflicts.
  if (modelRoutePickerOpen) {
    return (
      <ModelRoutePicker
        onClose={handleCloseModelRoutePicker}
        onConfigUpdated={() => {
          // Keep picker open after a config write so the user can edit
          // more routes. Status is shown inside the picker.
        }}
      />
    )
  }

  if (commandPaletteOpen) {
    return (
      <CommandPaletteScreen
        slashCommands={filteredSlashCommands}
        fileTree={fileTree}
        fileInventoryState={fileInventoryState}
        actions={[
          {
            id: 'attachments', label: 'Attachments', description: 'Inspect, retry and recover composer attachments',
            onSelect: () => {
              setCommandPaletteOpen(false)
              attachmentManagerOpenRef.current = true
              setAttachmentManagerOpen(true)
            },
          },
          {
            id: 'activity', label: 'Activity', description: 'Inspect active agents, queued work and failures',
            onSelect: () => {
              setCommandPaletteOpen(false)
              const state = useChatStore.getState()
              useOutputReaderStore.getState().open({ document: createJsonDocument('activity', 'Activity · captured now', {
                capturedAt: new Date().toISOString(), run: isStreaming ? 'Running' : 'Idle',
                agents: [...state.streamingAgents].map((id) => state.activeAgentTypes.get(id) ?? 'Agent'),
                queue: queuedMessages.map((message) => ({ prompt: message.content, mode: message.agentMode, attachments: message.attachments.length })),
                queuePaused, lastQueueFailure: queueError,
              }) })
            },
          },
          {
            id: 'changes', label: 'Changes', description: 'Browse captured files, hunks and mutation receipts',
            onSelect: () => { setCommandPaletteOpen(false); useOutputReaderStore.getState().open({ kindFilter: ['diff', 'receipt'] }) },
          },
          {
            id: 'session-details', label: 'Session details', description: 'Inspect configured routing, context and source health',
            onSelect: () => {
              setCommandPaletteOpen(false)
              useOutputReaderStore.getState().open({ document: createJsonDocument('session-details', 'Session details · captured now', {
                capturedAt: new Date().toISOString(), workspace: getProjectRoot(), selectedMode: agentMode,
                configuredModelForSelectedMode: modelName ?? 'Not resolved', run: statusIndicatorState.kind,
                context: contextWindowUsage ?? 'Not reported', compaction: compactionNotice ?? 'Not reported',
                sessionCostCents, index: indexStatus ?? 'No source status reported',
                freshness: 'This is a retained UI snapshot; reopen Session details to refresh it.',
              }) })
            },
          },
          {
            id: 'work-queue',
            label: 'Work queue',
            description: 'Inspect, edit, reorder and recover queued prompts',
            onSelect: () => {
              setCommandPaletteOpen(false)
              pauseQueue()
              setQueueScreenOpen(true)
            },
          },
          {
            id: 'browse-output',
            label: 'Browse output',
            description: 'Inspect captured text, logs and tool results',
            onSelect: () => {
              setCommandPaletteOpen(false)
              useOutputReaderStore.getState().open()
            },
          },
          {
            id: 'find-conversation',
            label: 'Find in conversation',
            description: 'Search retained collapsed and offscreen output',
            onSelect: () => {
              setCommandPaletteOpen(false)
              useOutputReaderStore.getState().open({ findConversation: true })
            },
          },
        ]}
        onClose={() => setCommandPaletteOpen(false)}
        onInsertText={(text) => {
          setInputValue((previous) => ({
            text: previous.text.slice(0, previous.cursorPosition) + text + previous.text.slice(previous.cursorPosition),
            cursorPosition: previous.cursorPosition + text.length,
            lastEditDueToNav: false,
          }))
          setInputFocused(true)
        }}
        onExecuteCommand={async (commandString) => {
          setCommandPaletteOpen(false)
          const result = await onSubmitPrompt(commandString, agentMode)
          handleCommandResult(result)
        }}
        onSelectFile={(filePath, isDirectory) => {
          setCommandPaletteOpen(false)
          addPendingFileMention(filePath, isDirectory, getProjectRoot())
          setInputValue((prev) => ({
            text:
              prev.text.slice(0, prev.cursorPosition) +
              `@${filePath} ` +
              prev.text.slice(prev.cursorPosition),
            cursorPosition: prev.cursorPosition + filePath.length + 2,
            lastEditDueToNav: false,
          }))
          setInputFocused(true)
          inputRef.current?.focus()
        }}
      />
    )
  }

  if (promptHistoryOpen) {
    return (
      <PromptHistorySearchScreen
        onClose={() => {
          setPromptHistoryOpen(false)
          setInputFocused(true)
        }}
        onSelectPrompt={(text) => {
          setInputValue({
            text,
            cursorPosition: text.length,
            lastEditDueToNav: false,
          })
          setInputFocused(true)
          inputRef.current?.focus()
        }}
      />
    )
  }

  if (providerPickerOpen) {
    return <ProviderPickerScreen onSelect={handleProviderPickerSelect} />
  }

  if (planSessionPickerCommand) {
    return (
      <PlanSessionPickerScreen
        command={planSessionPickerCommand}
        onSelectSession={handlePlanSessionPickerSelect}
        onCancel={handlePlanSessionPickerCancel}
      />
    )
  }

  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        flexGrow: 1,
      }}
    >
      {/* D47 Stage 1: OpenTUI 0.5's native stickyScroll/stickyStart is
          deliberately NOT enabled here. With stickyScroll live, OpenTUI's
          native code re-pins scrollTop to the bottom on every content
          growth, so it would be a SECOND independent writer of scrollTop on
          this scrollbox alongside use-scroll-management's auto-scroll
          effect — two writers with no evidence they cooperate (e.g. a user
          scrolling up during streaming: native stickyScroll re-pins on the
          next content growth while the JS effect may also force
          scrollTop = maxScroll, fighting the user's scroll intent or
          resurrecting auto-follow after they deliberately scrolled away).
          use-scroll-management remains the single validated scrollTop
          writer: its auto-scroll effect follows new content only while the
          user is at/near the bottom (autoScrollEnabledRef), and
          scrollUp/scrollDown/scrollToLatest stay available for keyboard
          paging and the jump-to-latest control. */}
      <scrollbox
        ref={scrollRef as React.Ref<ScrollBoxRenderable>}
        scrollX={false}
        scrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          // Visibility depends only on hasOverflow: the scrollbar track is a
          // layout SIBLING of the message content column, so toggling
          // visibility with streaming state would shift the message wrap
          // width on every agent-response start AND end while availableWidth
          // (terminal-derived) stays fixed — silently staling every
          // width-tagged measured height exactly when a response completes.
          // Keeping the track in layout whenever content overflows keeps the
          // content width stable for those measurements.
          visible: hasOverflow,
          trackOptions: { width: 1 },
        }}
        {...appliedScrollboxProps}
        style={{
          flexGrow: 1,
          rootOptions: {
            flexGrow: 1,
            padding: 0,
            gap: 0,
            flexDirection: 'row',
            shouldFill: true,
            backgroundColor: 'transparent',
          },
          wrapperOptions: {
            flexGrow: 1,
            border: false,
            shouldFill: true,
            backgroundColor: 'transparent',
            flexDirection: 'column',
          },
          contentOptions: {
            flexDirection: 'column',
            gap: 0,
            shouldFill: true,
            justifyContent: 'flex-end',
            backgroundColor: 'transparent',
            paddingLeft: 1,
            paddingRight: 2,
          },
        }}
      >
        <box ref={transcriptHeaderRef} style={{ flexDirection: 'column', flexShrink: 0, width: '100%' }}>
          <TopBanner gitRoot={gitRoot} onSwitchToGitRoot={onSwitchToGitRoot} />
          {headerContent}
          {hiddenMessageCount > 0 && (
            <LoadPreviousButton hiddenCount={hiddenMessageCount} onLoadMore={handleLoadPreviousMessages} />
          )}
        </box>
        {/* P1-T10: viewport-windowed message list. Only the messages
            intersecting the current scroll viewport (plus a small overscan)
            mount real MessageWithAgents components; off-screen messages
            collapse into fixed spacer boxes that preserve total scroll height
            and scroll position. Keys stay on the message ids so per-message
            state survives the window moving as the user scrolls. The scroll
            subscription is confined to MessageListWindow so scrolling does not
            re-render the rest of the chat screen. */}
        <MessageListWindow
          messages={visibleTopLevelMessages}
          scrollRef={scrollRef}
          availableWidth={messageAvailableWidth}
          hasLoadPrevious={hiddenMessageCount > 0}
          headerRef={transcriptHeaderRef}
          scrollTarget={transcriptTarget}
          scrollIntentRef={scrollIntentRef}
          adjustScrollTop={adjustScrollTop}
          isAtBottomNow={isAtBottomNow}
          scrollToLatest={scrollToLatest}
        />
        {/* Pending bash messages as ghost messages (only show those not already in history) */}
        {pendingBashMessages
          .filter((msg) => !msg.addedToHistory)
          .map((msg) => (
            <PendingBashMessage key={`pending-bash-${msg.id}`} message={msg} />
          ))}
      </scrollbox>

      <box
        style={{
          flexShrink: 0,
          backgroundColor: 'transparent',
        }}
      >
        {editingMessageId && (
          <box flexDirection="row" gap={1}>
            <text fg={theme.secondary}>
              Editing earlier prompt · forks conversation
            </text>
            <Button onClick={restoreEditDraft}>
              <text fg={theme.foreground}>Cancel (Esc)</text>
            </Button>
          </box>
        )}
        {shouldShowStatusLine && (
          <StatusBar
            timerStartTime={timerStartTime}
            isAtBottom={isAtBottom}
            unreadUpdates={unreadUpdates}
            scrollToLatest={() => { if (conversationControls.activeRef.current) conversationControls.leave(); scrollToLatest() }}
            statusIndicatorState={statusIndicatorState}
            notice={statusMessage}
            runActive={isStreaming || isChainInProgressRef.current}
            contextWindowUsage={contextWindowUsage}
            compactionNotice={compactionNotice}
            sessionCostCents={sessionCostCents}
            modelName={modelName}
            diffStats={diffStats}
            indexStatus={indexStatus}
            onStop={chatKeyboardHandlers.onInterruptStream}
          />
        )}

        {reviewMode ? (
          <ReviewScreen
            onSelectOption={handleReviewOptionSelect}
            onCustom={handleReviewCustom}
            onCancel={handleCloseReviewScreen}
          />
        ) : (
          <ChatInputBar
            inputValue={inputValue}
            cursorPosition={cursorPosition}
            setInputValue={setInputValue}
            inputFocused={inputFocused}
            inputRef={inputRef}
            inputPlaceholder={inputPlaceholder}
            lastEditDueToNav={lastEditDueToNav}
            agentMode={agentMode}
            toggleAgentMode={toggleAgentMode}
            setAgentMode={setAgentMode}
            onAgentModeMenuOpenChange={(open) => {
              modeMenuOpenRef.current = open
              setModeMenuOpen(open)
              setInputFocused(!open)
              if (!open) inputRef.current?.focus()
            }}
            hasSlashSuggestions={hasSlashSuggestions}
            hasMentionSuggestions={hasMentionSuggestions}
            hasSuggestionMenu={hasSuggestionMenu}
            slashSuggestionItems={slashSuggestionItems}
            agentSuggestionItems={agentSuggestionItems}
            fileSuggestionItems={fileSuggestionItems}
            slashSelectedIndex={slashSelectedIndex}
            agentSelectedIndex={agentSelectedIndex}
            onSlashItemClick={handleSlashItemClick}
            onMentionItemClick={handleMentionItemClick}
            mentionSuggestionStatus={mentionSuggestionState.message}
            mentionSuggestionStatusIsError={mentionSuggestionState.isError}
            onRetryMentionSuggestions={
              mentionSuggestionState.canRetry ? retryFileSuggestions : undefined
            }
            theme={theme}
            terminalHeight={terminalHeight}
            separatorWidth={separatorWidth}
            shouldCenterInputVertically={shouldCenterInputVertically}
            inputBoxTitle={inputBoxTitle}
            isCompactHeight={isCompactHeight}
            isNarrowWidth={isNarrowWidth}
            inputWidth={inputWidth}
            inputMinHeight={1}
            inputTotalLines={inputLayoutMetrics.totalLines}
            inputMeasurementKey={inputMeasurementKey}
            inputInputCap={inputHeightLines}
            inputGutterEnabled={inputLayoutMetrics.gutterEnabled}
            feedbackMode={feedbackMode}
            handleExitFeedback={handleExitFeedback}
            publishMode={publishMode}
            handleExitPublish={handleExitPublish}
            handlePublish={handlePublish}
            handleSubmit={handleSubmit}
            onManageAttachments={() => {
              attachmentManagerOpenRef.current = true
              setAttachmentManagerOpen(true)
            }}
            pasteEnabled={!readerRequest && !queueScreenOpen && !modeMenuOpen && !attachmentManagerOpen}
            isInputActive={() => !modeMenuOpenRef.current && !attachmentManagerOpenRef.current && !conversationControls.activeRef.current && useOutputReaderStore.getState().request === null && !queueScreenOpen}
            onPaste={createPasteHandler({
              text: inputValue,
              cursorPosition,
              onChange: setInputValue,
              onPasteImage: chatKeyboardHandlers.onPasteImage,
              onPasteImagePath: chatKeyboardHandlers.onPasteImagePath,
              onPasteFilePath: chatKeyboardHandlers.onPasteFilePath,
              onPasteLongText: handlePasteLongText,
              cwd: getProjectRoot() ?? process.cwd(),
            })}
            onInterruptStream={chatKeyboardHandlers.onInterruptStream}
            fileTree={fileTree}
          />
        )}
      </box>
      {readerRequest && (
        <box
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 100,
            backgroundColor: theme.surface,
          }}
        >
          <OutputReaderScreen
            messages={messages}
            documentId={readerRequest.documentId}
            initialDocument={readerRequest.document}
            findConversation={readerRequest.findConversation}
            kindFilter={readerRequest.kindFilter}
            onReturnToMessage={(messageId) => {
              const rootId = revealMessage(messageId)
              if (!rootId) return
              setTranscriptTarget({ messageId: rootId, token: Date.now() })
              useOutputReaderStore.getState().close()
            }}
            onClose={() => useOutputReaderStore.getState().close()}
          />
        </box>
      )}
      {attachmentManagerOpen && (
        <box style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 100, backgroundColor: theme.surface }}>
          <AttachmentRecoveryScreen onClose={() => {
            attachmentManagerOpenRef.current = false
            setAttachmentManagerOpen(false)
          }} />
        </box>
      )}
      {queueScreenOpen && (
        <box
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 100,
            backgroundColor: theme.surface,
          }}
        >
          <QueueScreen
            queuedMessages={queuedMessages}
            queuePaused={queuePaused}
            queueError={queueError}
            queueAttachmentNotice={queueAttachmentNotice}
            hasQueuedAttachmentReads={hasQueuedAttachmentReads}
            attachmentRemovalCount={attachmentRemovalCount}
            getQueuedAttachmentRevision={getQueuedAttachmentRevision}
            updateQueuedAttachment={updateQueuedAttachment}
            cancelQueuedAttachmentRetry={cancelQueuedAttachmentRetry}
            removeQueuedAttachment={removeQueuedAttachment}
            undoQueuedAttachmentRemoval={undoQueuedAttachmentRemoval}
            retryAttachment={(_id, attachment, signal) => retryPendingAttachment(attachment, ('sourceRoot' in attachment ? attachment.sourceRoot : undefined) ?? getProjectRoot(), signal)}
            queueRemovalCount={queueRemovalCount}
            cancelQueuedMessages={cancelQueuedMessages}
            updateQueuedMessage={updateQueuedMessage}
            removeQueuedMessage={removeQueuedMessage}
            moveQueuedMessage={moveQueuedMessage}
            undoQueueRemoval={undoQueueRemoval}
            pauseQueue={pauseQueue}
            resumeQueue={resumeQueue}
            onClose={() => setQueueScreenOpen(false)}
            onRestore={(message) => {
              const store = useChatStore.getState()
              if (store.inputValue.trim() || store.pendingAttachments.length)
                return false
              store.setInputValue({
                text: message.content,
                cursorPosition: message.content.length,
                lastEditDueToNav: false,
              })
              store.setAgentMode(message.agentMode)
              useChatStore.setState({
                pendingAttachments: [...message.attachments],
              })
              return true
            }}
          />
        </box>
      )}
    </box>
  )
}
