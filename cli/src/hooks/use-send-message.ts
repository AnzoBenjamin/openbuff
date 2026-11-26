import { useCallback, useEffect, useRef } from 'react'

import { setCurrentChatId } from '../project-files'
import { createStreamController } from './stream-state'
import { useChatStore } from '../state/chat-store'
import { stampRunPromptBoundary } from '../utils/conversation-fork'
import { getCodebuffClient } from '../utils/codebuff-client'
import { AGENT_MODE_TO_COST_MODE, AGENT_MODE_TO_ID } from '../utils/constants'
import { createEventHandlerState } from '../utils/create-event-handler-state'
import { createRunConfig } from '../utils/create-run-config'
import { loadAgentDefinitions } from '../utils/local-agent-registry'
import { logger } from '../utils/logger'
import {
  getPromptAttachmentBlockReason,
  restorePendingAttachments,
} from '../utils/pending-attachments'
import { getOpenbuffProviderReadiness } from '../utils/openbuff-provider'
import {
  clearCheckpoint,
  loadCheckpoint,
  loadMostRecentChatStateAsync,
  saveChatState,
  saveCheckpoint,
  type TurnCheckpoint,
} from '../utils/run-state-storage'
import {
  autoCollapsePreviousMessages,
  createAiMessageShell,
  createErrorMessage as createErrorChatMessage,
  generateAiMessageId,
} from '../utils/send-message-helpers'
import { createSendMessageTimerController } from '../utils/send-message-timer'
import {
  createRunOwnership,
  finalizeQueueState,
  handleRunCompletion,
  handleRunError,
  prepareUserMessage as prepareUserMessageHelper,
  resetEarlyReturnState,
  setupStreamingContext,
} from './helpers/send-message'
import { whenRegistriesReady } from '../services/deferred-registries'
import { hydrateContextArchiveSnapshots } from '../services/memory-v2/context-archive-sync'
import { yieldToEventLoop } from '../utils/yield-to-event-loop'

import type { ElapsedTimeTracker } from './use-elapsed-time'
import type { StreamStatus } from './use-message-queue'
import type { PendingAttachment } from '../types/store'
import type { ChatMessage } from '../types/chat'
import type {
  PromptAdmissionResult,
  SendMessageFn,
} from '../types/contracts/send-message'
import type { AgentMode } from '../utils/constants'
import type { SendMessageTimerEvent } from '../utils/send-message-timer'
import type {
  SetCompactionNoticeFn,
  SetContextWindowUsageFn,
} from '../utils/sdk-event-handlers'
import type { AgentDefinition, MessageContent, RunState } from '@openbuff/sdk'
import {
  openRunJournalForRun,
  resolveRunJournalPath,
} from '../utils/run-journal-path'
import { describeRunConfigForLog } from '../utils/run-config-digest'

interface UseSendMessageOptions {
  inputRef: React.MutableRefObject<any>
  activeSubagentsRef: React.MutableRefObject<Set<string>>
  isChainInProgressRef: React.MutableRefObject<boolean>
  setStreamStatus: (status: StreamStatus) => void
  setContextWindowUsage: SetContextWindowUsageFn
  setCompactionNotice: SetCompactionNoticeFn
  setCanProcessQueue: (can: boolean) => void
  abortControllerRef: React.MutableRefObject<AbortController | null>
  agentId?: string
  onBeforeMessageSend: () => Promise<{
    success: boolean
    errors: Array<{ id: string; message: string }>
  }>
  /** Optional callback fired with the per-turn cost in cents (USD * 100). */
  onTotalCost?: (costCents: number) => void
  mainAgentTimer: ElapsedTimeTracker
  scrollToLatest: (options?: { immediate?: boolean }) => void
  onTimerEvent?: (event: SendMessageTimerEvent) => void
  isQueuePausedRef?: React.MutableRefObject<boolean>
  isProcessingQueueRef?: React.MutableRefObject<boolean>
  resumeQueue?: () => void
  pauseQueue?: () => void
  continueChat: boolean
  continueChatId?: string
}

// Choose the agent definition by explicit selection or mode-based fallback.
const resolveAgent = (
  agentMode: AgentMode,
  agentId: string | undefined,
  agentDefinitions: AgentDefinition[],
): AgentDefinition | string => {
  const selectedAgentDefinition =
    agentId && agentDefinitions.length > 0
      ? agentDefinitions.find((definition) => definition.id === agentId)
      : undefined

  return selectedAgentDefinition ?? agentId ?? AGENT_MODE_TO_ID[agentMode]
}

// Respect bash context, but avoid sending empty prompts when only images are attached.
const buildPromptWithContext = (
  promptWithBashContext: string,
  messageContent: MessageContent[] | undefined,
) => {
  const trimmedPrompt = promptWithBashContext.trim()
  if (trimmedPrompt.length > 0) {
    return promptWithBashContext
  }

  if (messageContent && messageContent.length > 0) {
    return 'See attached image(s)'
  }

  return ''
}

const USER_MESSAGE_OPEN = '<user_message>'
const USER_MESSAGE_CLOSE = '</user_message>'
const isWrappedUserText = (text: string) =>
  text.startsWith(USER_MESSAGE_OPEN) && text.endsWith(USER_MESSAGE_CLOSE)
const unwrapUserText = (text: string) =>
  isWrappedUserText(text)
    ? text.slice(USER_MESSAGE_OPEN.length, -USER_MESSAGE_CLOSE.length)
    : text

function isSeparateCheckpointPrompt(
  checkpoint: TurnCheckpoint,
  effectivePrompt: string,
  content: MessageContent[] | undefined,
): boolean {
  const history = checkpoint.mainAgentState.messageHistory
  if (!Array.isArray(history)) return false
  const tagged = history.findLast(
    (message) => message.role === 'user' && message.tags?.includes('USER_PROMPT'),
  )
  const lastUser = tagged ?? history.findLast((message) => message.role === 'user')
  let savedText: string | undefined
  if (typeof lastUser?.content === 'string') {
    savedText = unwrapUserText(lastUser.content)
  } else if (tagged && Array.isArray(tagged.content)) {
    const text = tagged.content.find((part) => part.type === 'text')
    if (text?.type === 'text' && isWrappedUserText(text.text)) {
      savedText = unwrapUserText(text.text)
    }
  }
  const textPart = content?.find((part) => part.type === 'text')
  const suppliedText = textPart?.type === 'text' && textPart.text.trim()
    ? unwrapUserText(textPart.text)
    : effectivePrompt
  // An undecodable checkpoint or the same text with different attachments
  // is not evidence of an explicit separate turn.
  return savedText !== undefined && savedText !== suppliedText &&
    !(typeof lastUser?.content === 'string' && lastUser.content === suppliedText)
}

export const useSendMessage = ({
  inputRef,
  activeSubagentsRef,
  isChainInProgressRef,
  setStreamStatus,
  setContextWindowUsage,
  setCompactionNotice,
  setCanProcessQueue,
  abortControllerRef,
  agentId,
  onBeforeMessageSend,
  mainAgentTimer,
  scrollToLatest,
  onTimerEvent = () => {},
  onTotalCost,
  isQueuePausedRef,
  isProcessingQueueRef,
  resumeQueue,
  pauseQueue,
  continueChat,
  continueChatId,
}: UseSendMessageOptions): {
  sendMessage: SendMessageFn
  clearMessages: (runState?: RunState | null) => void
  retryRestore: () => void
  cancelRestore: () => void
} => {
  // Read store setters fresh on each callback invocation via useChatStore.getState()
  // rather than capturing them once at component scope. If the zustand store is ever
  // recreated (test isolation, HMR, store swap), a captured setter would be stale,
  // bound to a dead store. Calling getState() inside each callback guarantees the
  // setter always references the live store. These setters have stable identity within
  // a given store instance and don't need to trigger re-renders, so they are excluded
  // from useCallback/useEffect dependency arrays.
  const previousRunStateRef = useRef<RunState | null>(
    useChatStore.getState().runState,
  )
  // An interrupted checkpoint remains available for inspection if exact
  // replay is refused. Only a clearly different prompt takes the new-turn path.
  const resumableCheckpointRef = useRef<TurnCheckpoint | null>(null)
  // Memoize stream controller to maintain referential stability across renders
  const streamRefsRef = useRef<ReturnType<
    typeof createStreamController
  > | null>(null)
  if (!streamRefsRef.current) {
    streamRefsRef.current = createStreamController()
  }
  const streamRefs = streamRefsRef.current
  const activeRunOwnerRef = useRef<symbol | null>(null)
  const sdkExecutionRef = useRef<symbol | null>(null)
  const snapshotCompletionRef = useRef<Promise<void> | null>(null)
  const restorePromiseRef = useRef<Promise<void> | null>(null)
  const restoreAbortRef = useRef<AbortController | null>(null)
  const restoreBlockedRef = useRef(continueChat && !previousRunStateRef.current)
  const restoreRetryRef = useRef<(() => void) | null>(null)
  const restoreOwnerRef = useRef(Symbol('selected-session-restore'))

  // Keep the latest scrollToLatest reachable without putting it in the restore
  // effect's dependency array: scrollToLatest's useCallback (useChatScrollbox)
  // depends on `messages` plus scroll helpers, so its identity changes on every
  // store message mutation. Listing it in the restore effect's deps would tear
  // down and re-run an in-flight one-shot restore (aborting the controller,
  // nulling restorePromiseRef, and scheduling a second load of the same chat),
  // opening a window where handleSendMessage's `await restorePromiseRef.current`
  // observes null and proceeds from pre-restore state.
  const scrollToLatestRef = useRef(scrollToLatest)
  useEffect(() => {
    scrollToLatestRef.current = scrollToLatest
  })

  useEffect(() => {
    if (!continueChat || previousRunStateRef.current) return
    let cancelled = false
    let scrollTimer: ReturnType<typeof setTimeout> | undefined
    let activeRestoreController: AbortController | null = null
    const restore = async () => {
      activeRestoreController?.abort()
      const controller = new AbortController()
      activeRestoreController = controller
      restoreAbortRef.current = controller
      restoreBlockedRef.current = true
      useChatStore.getState().setSessionRestore({
        status: 'loading',
        chatId: continueChatId,
        owner: restoreOwnerRef.current,
      })
      const loadedState = await loadMostRecentChatStateAsync(
        continueChatId ?? undefined,
        controller.signal,
      )
      if (
        cancelled ||
        controller.signal.aborted ||
        useChatStore.getState().sessionRestore?.owner !==
          restoreOwnerRef.current
      )
        return
      if (!loadedState) {
        useChatStore.getState().setSessionRestore({
          status: 'error',
          chatId: continueChatId,
          owner: restoreOwnerRef.current,
          message:
            'The selected saved session is missing, corrupt, or unreadable. Retry restoration or cancel to start a new session; your draft is preserved.',
        })
        return
      }
      // The effect's own one-shot cancellation token: effect cleanup sets
      // `cancelled` (a replaced run) and clearMessages aborts `controller`.
      // Every late store write below is gated on it so a completed send or a
      // replaced effect run can never have its messages overwritten by this
      // load.
      const restoreIsLive = () => !cancelled && !controller.signal.aborted
      const { setRunState, setMessages } = useChatStore.getState()
      if (!restoreIsLive()) return
      previousRunStateRef.current = loadedState.runState
      setRunState(loadedState.runState)
      setMessages(loadedState.messages)
      restoreBlockedRef.current = false
      useChatStore.getState().setSessionRestore(null)
      // Wait for React to commit the restored messages before targeting the
      // bottom. scrollToLatestRef reads the latest scrollToLatest without
      // making it a dependency of this effect. scrollToLatest also verifies
      // against the settled layout.
      scrollTimer = setTimeout(() => {
        if (!cancelled && !controller.signal.aborted) {
          scrollToLatestRef.current({ immediate: true })
        }
      }, 0)
      // Cross-session context-archive hydration (SEAM: this restore effect —
      // the place where loadMostRecentChatState's result is applied to the
      // live session via setRunState, so it is where durable memory-v2
      // archive snapshots are merged back into the restored agentState so
      // recall_context covers prior sessions). The restore path itself is
      // synchronous, so hydration runs as a fire-and-forget merge applied
      // through the same setRunState path used for live state updates. The
      // identity guards keep the merge from clobbering a run started in
      // between (any run replaces the store's runState object), and
      // previousRunStateRef is kept in lockstep so the next send forks from
      // the hydrated archive. The helper is no-throw; the .catch is a
      // double-guard so an unexpected rejection can only ever log.
      const restoredRunState = loadedState.runState
      const restoredSessionState = restoredRunState.sessionState
      // restore-hydration-unchecked-mainagentstate: loadChatStateFromDirectory
      // validates runState presence and the messages array but never that
      // sessionState.mainAgentState exists, so a persisted envelope shaped
      // that way would throw an uncaught TypeError on the render thread —
      // both HERE (unconditional deref) and in the .then merge below (which
      // re-reads mainAgentState). Guard with a falsy check, warn, and skip
      // the merge when the field is absent.
      const restoredMainAgentState = restoredSessionState?.mainAgentState
      if (!restoredMainAgentState) {
        if (restoredSessionState) {
          logger.warn(
            { chatId: loadedState.chatId },
            '[send-message] Restored session state has no mainAgentState; skipping context archive hydration merge',
          )
        }
      } else {
        void hydrateContextArchiveSnapshots(
          restoredMainAgentState.compactionArchive,
          {
            includeProjectArchive:
              restoredMainAgentState.contextArchiveHydration !==
              'in-memory-only',
          },
        )
          .then((mergedArchive) => {
            const { runState: latestRunState, setRunState: setLatestRunState } =
              useChatStore.getState()
            const latestSessionState = latestRunState?.sessionState
            // Re-verify before deref: the store could have been replaced
            // between scheduling and settle (identity guards below), and a
            // runState legitimately without mainAgentState must not throw
            // here either.
            const latestMainAgentState = latestSessionState?.mainAgentState
            if (
              !latestRunState ||
              !latestSessionState ||
              !latestMainAgentState ||
              latestRunState !== restoredRunState ||
              latestSessionState !== restoredSessionState ||
              latestMainAgentState !== restoredMainAgentState
            ) {
              return
            }
            const hydratedRunState: RunState = {
              ...latestRunState,
              sessionState: {
                ...latestSessionState,
                mainAgentState: {
                  ...latestSessionState.mainAgentState,
                  compactionArchive: mergedArchive,
                },
              },
            }
            previousRunStateRef.current = hydratedRunState
            setLatestRunState(hydratedRunState)
          })
          .catch((error) => {
            logger.warn(
              { error },
              '[send-message] Context archive hydration merge failed (non-fatal)',
            )
          })
      }
      if (loadedState.chatId) {
        setCurrentChatId(loadedState.chatId)
      }
      // P2-3: Check for a mid-turn checkpoint from an interrupted (crashed)
      // turn. Validate that checkpointTurnId matches a message id in the
      // restored messages — if not, the checkpoint is stale and discarded.
      const checkpoint = loadCheckpoint()
      if (checkpoint) {
        const matchesMessage = loadedState.messages.some(
          (msg) => msg.id === checkpoint.checkpointTurnId,
        )
        if (matchesMessage) {
          resumableCheckpointRef.current = checkpoint
          logger.info(
            { checkpointTurnId: checkpoint.checkpointTurnId },
            '[send-message] Loaded mid-turn checkpoint for interrupted turn',
          )
        } else {
          logger.debug(
            { checkpointTurnId: checkpoint.checkpointTurnId },
            '[send-message] Mid-turn checkpoint is stale (no matching message), discarding',
          )
          // Fire-and-forget clear (cancel + drain + unlink is serialized
          // inside clearCheckpoint itself; nothing here needs to wait on it).
          void clearCheckpoint()
        }
      }
    }
    let latestRestorePromise: Promise<void> | null = null
    const launchRestore = () => {
      if (cancelled) return
      const pending = restore().catch(() => {
        if (
          cancelled ||
          restorePromiseRef.current !== pending ||
          useChatStore.getState().sessionRestore?.owner !==
            restoreOwnerRef.current
        )
          return
        restoreBlockedRef.current = true
        useChatStore.getState().setSessionRestore({
          status: 'error',
          chatId: continueChatId,
          owner: restoreOwnerRef.current,
          message:
            'Saved-session restoration failed. Retry or cancel to start a new session; your draft is preserved.',
        })
      })
      latestRestorePromise = pending
      restorePromiseRef.current = pending
    }
    restoreRetryRef.current = launchRestore
    launchRestore()
    return () => {
      cancelled = true
      activeRestoreController?.abort()
      if (restoreRetryRef.current === launchRestore)
        restoreRetryRef.current = null
      if (restoreAbortRef.current === activeRestoreController)
        restoreAbortRef.current = null
      if (restorePromiseRef.current === latestRestorePromise)
        restorePromiseRef.current = null
      if (
        useChatStore.getState().sessionRestore?.owner ===
        restoreOwnerRef.current
      )
        useChatStore.getState().setSessionRestore(null)
      if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    }
    // Deps intentionally exclude scrollToLatest (reached through
    // scrollToLatestRef above): this is a one-shot restore per
    // continueChat/continueChatId and must never be aborted or restarted by
    // scroll or UI-state identity changes.
  }, [continueChat, continueChatId])

  const updateChainInProgress = useCallback(
    (value: boolean) => {
      isChainInProgressRef.current = value
      useChatStore.getState().setIsChainInProgress(value)
    },
    [isChainInProgressRef],
  )

  const updateActiveSubagents = useCallback(
    (mutate: (next: Set<string>) => void) => {
      useChatStore.getState().setActiveSubagents((prev) => {
        const next = new Set(prev)
        mutate(next)
        activeSubagentsRef.current = next
        return next
      })
    },
    [activeSubagentsRef],
  )

  const addActiveSubagent = useCallback(
    (subagentId: string, agentType?: string) => {
      updateActiveSubagents((next) => next.add(subagentId))
      if (agentType) {
        useChatStore.getState().setActiveAgentTypes((prev) => {
          const next = new Map(prev)
          next.set(subagentId, agentType)
          return next
        })
      }
    },
    [updateActiveSubagents],
  )

  const removeActiveSubagent = useCallback(
    (subagentId: string) => {
      updateActiveSubagents((next) => next.delete(subagentId))
      useChatStore.getState().setActiveAgentTypes((prev) => {
        const next = new Map(prev)
        next.delete(subagentId)
        return next
      })
    },
    [updateActiveSubagents],
  )

  function clearMessages(runState: RunState | null = null) {
    activeRunOwnerRef.current = null
    abortControllerRef.current?.abort()
    const stillCancelling = sdkExecutionRef.current !== null
    updateChainInProgress(stillCancelling)
    setStreamStatus('idle')
    setCanProcessQueue(!stillCancelling && !isQueuePausedRef?.current)
    restoreAbortRef.current?.abort()
    restoreBlockedRef.current = false
    if (
      useChatStore.getState().sessionRestore?.owner === restoreOwnerRef.current
    )
      useChatStore.getState().setSessionRestore(null)
    previousRunStateRef.current = runState
    resumableCheckpointRef.current = null
    useChatStore.getState().setRunState(runState)
  }

  const retryRestore = useCallback(() => {
    if (restoreBlockedRef.current && sdkExecutionRef.current === null)
      restoreRetryRef.current?.()
  }, [])
  const cancelRestore = useCallback(() => {
    restoreRetryRef.current = null
    clearMessages()
    setCurrentChatId(crypto.randomUUID())
    useChatStore.getState().setMessages([])
    pauseQueue?.()
    if (isQueuePausedRef) isQueuePausedRef.current = true
    setCanProcessQueue(false)
  }, [clearMessages, pauseQueue, isQueuePausedRef, setCanProcessQueue])

  const prepareUserMessage = useCallback(
    (params: {
      content: string
      agentMode: AgentMode
      postUserMessage?: (prev: ChatMessage[]) => ChatMessage[]
      attachments?: PendingAttachment[]
      isCurrent?: () => boolean
    }) => {
      // Access store fresh each call so setters bind to the live store instance.
      const {
        lastMessageMode,
        setMessages,
        setLastMessageMode,
        setHasReceivedPlanResponse,
      } = useChatStore.getState()
      return prepareUserMessageHelper({
        ...params,
        deps: {
          setMessages,
          lastMessageMode,
          setLastMessageMode,
          scrollToLatest,
          setHasReceivedPlanResponse,
        },
      })
    },
    [scrollToLatest],
  )

  const sendMessage = useCallback<SendMessageFn>(
    async ({
      content,
      agentMode,
      postUserMessage,
      attachments,
      onAccepted,
    }) => {
      // Read setters fresh from the live store on each invocation so they always
      // bind to the current store instance (see note above about store recreation).
      const {
        setMessages,
        setFocusedAgentId,
        setInputFocused,
        setStreamingAgents,
        setHasReceivedPlanResponse,
        setRunState,
        setIsRetrying,
      } = useChatStore.getState()
      // CRITICAL: Set chain in progress immediately (synchronously) before any async work.
      // This ensures the router can detect that we're busy and queue subsequent messages.
      // Set the ref directly first to guarantee immediate visibility to other code paths,
      // then call updateChainInProgress to also update React state for re-renders.
      isChainInProgressRef.current = true
      updateChainInProgress(true)
      setCanProcessQueue(false)
      const { isCurrentRunOwner, isCurrentRunActive, releaseRunOwner } =
        createRunOwnership(activeRunOwnerRef)

      if (agentMode !== 'PLAN') {
        setHasReceivedPlanResponse(false)
      }

      // Initialize timer for elapsed time tracking
      const timerController = createSendMessageTimerController({
        mainAgentTimer,
        onTimerEvent,
        agentId,
      })
      setIsRetrying(false)
      // A new turn starts with no compaction notice: the status-bar chip only
      // reports compactions that happened during the turn in progress.
      setCompactionNotice(() => null)

      // No transcript/context is committed until validation, client creation,
      // provider readiness and attachment preflight have all succeeded.
      let userMessageId: string
      let messageContent: MessageContent[] | undefined
      let bashContextForPrompt: string | undefined
      let finalContent: string

      const rejectAdmission = (
        reason: string,
        visibleMessage: string,
      ): PromptAdmissionResult => {
        if (isCurrentRunOwner()) {
          setMessages((prev) => [
            ...prev,
            createErrorChatMessage(visibleMessage),
          ])
          resetEarlyReturnState({
            setCanProcessQueue,
            updateChainInProgress,
            isProcessingQueueRef,
            isQueuePausedRef,
          })
          releaseRunOwner()
        }
        return { status: 'rejected', reason, retryable: true }
      }

      try {
        await restorePromiseRef.current
      } catch (error) {
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        logger.error(
          { error },
          '[send-message] Session restore failed before admission',
        )
        return rejectAdmission(
          error instanceof Error ? error.message : String(error),
          '⚠️ Unable to restore the conversation before sending. Please retry.',
        )
      }
      if (!isCurrentRunOwner())
        return { status: 'not-started', reason: 'superseded-owner' }
      if (restoreBlockedRef.current) {
        resetEarlyReturnState({
          setCanProcessQueue: () => setCanProcessQueue(false),
          updateChainInProgress,
          isProcessingQueueRef,
          isQueuePausedRef,
        })
        releaseRunOwner()
        return { status: 'not-started', reason: 'restore-blocked' }
      }
      await snapshotCompletionRef.current
      if (!isCurrentRunOwner())
        return { status: 'not-started', reason: 'superseded-owner' }

      const attachmentCandidates =
        attachments ?? useChatStore.getState().pendingAttachments
      const attachmentBlock =
        getPromptAttachmentBlockReason(attachmentCandidates)
      if (attachmentBlock) {
        resetEarlyReturnState({
          setCanProcessQueue,
          updateChainInProgress,
          isProcessingQueueRef,
          isQueuePausedRef,
        })
        releaseRunOwner()
        return { status: 'not-started', reason: attachmentBlock }
      }

      try {
        await whenRegistriesReady()
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        const validationResult = await onBeforeMessageSend()
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        if (!validationResult.success) {
          const reason =
            validationResult.errors.map((error) => error.message).join('; ') ||
            'Agent validation could not be completed.'
          logger.warn(
            { errors: validationResult.errors },
            '[send-message] Validation failed',
          )
          return rejectAdmission(
            reason,
            `⚠️ ${reason} Fix the agent configuration or retry validation.`,
          )
        }
      } catch (error) {
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        logger.error(
          { error },
          '[send-message] Validation before message send failed with exception',
        )
        // Yield before settlement so a conversation replacement/new owner can
        // supersede this failed attempt; the stale attempt must not clear the
        // newer owner's occupancy.
        await yieldToEventLoop()
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        return rejectAdmission(
          error instanceof Error ? error.message : String(error),
          '⚠️ Agent validation failed unexpectedly. Please try again.',
        )
      }

      let client: Awaited<ReturnType<typeof getCodebuffClient>>
      try {
        client = await getCodebuffClient()
      } catch (error) {
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        logger.error({ error }, '[send-message] SDK client factory failed')
        return rejectAdmission(
          error instanceof Error ? error.message : String(error),
          '⚠️ Unable to initialize the provider client. Check provider configuration and retry.',
        )
      }
      if (!isCurrentRunOwner())
        return { status: 'not-started', reason: 'superseded-owner' }
      if (!client) {
        return rejectAdmission(
          'No provider client is available.',
          '⚠️ Unable to initialize the provider client. Check provider configuration and retry.',
        )
      }

      let agentDefinitions: ReturnType<typeof loadAgentDefinitions>
      let resolvedAgent: ReturnType<typeof resolveAgent>
      try {
        agentDefinitions = loadAgentDefinitions()
        resolvedAgent = resolveAgent(agentMode, agentId, agentDefinitions)
        const providerReadiness = getOpenbuffProviderReadiness({
          agent: resolvedAgent,
          agentMode,
        })
        if (!providerReadiness.ok) {
          return rejectAdmission(
            providerReadiness.message,
            providerReadiness.message,
          )
        }
      } catch (error) {
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        logger.error({ error }, '[send-message] Provider readiness failed')
        return rejectAdmission(
          error instanceof Error ? error.message : String(error),
          '⚠️ Unable to resolve provider readiness. Check provider configuration and retry.',
        )
      }

      const admittedAttachments =
        attachments ?? useChatStore.getState().drainPendingAttachments()
      try {
        const prepared = await prepareUserMessage({
          content,
          agentMode,
          postUserMessage,
          attachments: admittedAttachments,
          isCurrent: isCurrentRunOwner,
        })
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        userMessageId = prepared.userMessageId
        messageContent = prepared.messageContent
        bashContextForPrompt = prepared.bashContextForPrompt
        finalContent = prepared.finalContent
      } catch (error) {
        if (!isCurrentRunOwner())
          return { status: 'not-started', reason: 'superseded-owner' }
        logger.error(
          { error },
          '[send-message] prepareUserMessage failed with exception',
        )
        if (attachments === undefined)
          restorePendingAttachments(admittedAttachments)
        return rejectAdmission(
          error instanceof Error ? error.message : String(error),
          '⚠️ Failed to prepare message. Please try again.',
        )
      }

      setFocusedAgentId(null)
      setInputFocused(true)
      inputRef.current?.focus()

      // Create AI message shell and setup streaming context
      const aiMessageId = generateAiMessageId()
      const aiMessage = createAiMessageShell(aiMessageId)

      const { updater, hasReceivedContentRef, abortController } =
        setupStreamingContext({
          aiMessageId,
          timerController,
          setMessages,
          streamRefs,
          abortControllerRef,
          setStreamStatus,
          setCanProcessQueue,
          isQueuePausedRef,
          isProcessingQueueRef,
          updateChainInProgress,
          setIsRetrying,
          setStreamingAgents,
        })
      setStreamStatus('waiting')
      // Combine auto-collapse and AI message addition into single atomic update
      // to prevent flicker from intermediate render states
      setMessages((prev) => [
        ...autoCollapsePreviousMessages(prev, aiMessageId),
        aiMessage,
      ])
      // Note: updateChainInProgress(true) and setCanProcessQueue(false) are already
      // called at the start of sendMessage to ensure they happen synchronously
      // before any async work, so the router can correctly detect busy state.
      let actualCredits: number | undefined

      // P2-T7: opened LAZILY below — only after the provider-readiness gate
      // inside the run try-block, so a send that never starts a run (a
      // validation failure, a providerReadiness failure early-return) never
      // creates the journal db. The SAME object serves writer and reader (one
      // connection, one file), and it is closed in the finally below (the
      // run's promise-chain end).
      // Fail-open: an unopenable journal warns once and the turn proceeds
      // WITHOUT journaling — a journaling outage can never break a user turn.
      let runJournal: ReturnType<typeof openRunJournalForRun> = undefined
      let executionToken: symbol | undefined

      // Admission is now settled. Execution continues on its own lifecycle
      // promise so router/queue callers can distinguish acceptance from run
      // completion without weakening run ownership or cleanup.
      const completion = (async (): Promise<void> => {
        try {
          // P2-T7: open the run journal ONLY now that the run is actually
          // starting (never at TUI startup, never on a validation failure, and
          // never on a providerReadiness failure early-return above).
          runJournal = openRunJournalForRun({
            path: resolveRunJournalPath(),
            warn: (message) => {
              logger.warn({ message }, '[send-message] Run journal unavailable')
            },
          })

          const promptWithBashContext = bashContextForPrompt
            ? bashContextForPrompt + finalContent
            : finalContent
          const effectivePrompt = buildPromptWithContext(
            promptWithBashContext,
            messageContent,
          )

          const checkpoint = resumableCheckpointRef.current
          let resumeInterruptedTurn = false
          let previousRunState = useChatStore.getState().runState
          if (checkpoint) {
            if (isSeparateCheckpointPrompt(checkpoint, effectivePrompt, messageContent)) {
              resumableCheckpointRef.current = null
              await clearCheckpoint()
              if (!isCurrentRunOwner()) return
            } else {
              // Ask for exact replay even when the old session is incomplete:
              // the SDK must refuse an unverified prefix, never start it afresh.
              if (previousRunState?.sessionState) {
                previousRunState = {
                  ...previousRunState,
                  sessionState: {
                    ...previousRunState.sessionState,
                    mainAgentState: checkpoint.mainAgentState,
                  },
                }
              }
              resumeInterruptedTurn = true
              logger.info('[send-message] Checking interrupted-turn replay eligibility')
            }
          }

          const eventHandlerState = createEventHandlerState({
            streamRefs,
            setStreamingAgents,
            setStreamStatus,
            setContextWindowUsage,
            setCompactionNotice,
            aiMessageId,
            updater,
            hasReceivedContentRef,
            addActiveSubagent,
            removeActiveSubagent,
            agentMode,
            setHasReceivedPlanResponse,
            logger,
            setIsRetrying,
            onTotalCost: (cost: number) => {
              actualCredits = cost
              onTotalCost?.(cost)
            },
          })

          const runConfig = createRunConfig({
            logger,
            agent: resolvedAgent,
            prompt: effectivePrompt,
            content: messageContent,
            previousRunState,
            agentDefinitions,
            eventHandlerState,
            signal: abortController.signal,
            costMode: AGENT_MODE_TO_COST_MODE[agentMode],
            onCheckpoint: (agentState) => {
              if (isCurrentRunActive(abortController.signal)) {
                saveCheckpoint(userMessageId, agentState)
              }
            },
            resumeInterruptedTurn,
          })

          // Size digest only: most fields of the run config carry per-run
          // transcript state, so the config is never stringified into the log
          // — top-level fields are measured, not logged, and the
          // [send-message] prefix is kept for grep-ability.
          logger.info(
            describeRunConfigForLog(runConfig),
            '[send-message] Sending message with sdk run config',
          )
          executionToken = Symbol('sdk-execution')
          sdkExecutionRef.current = executionToken
          let runState = await client.run({
            ...runConfig,
            // P2-T7: thread the live run journal into the SDK run so tool
            // calls/results, spawns, and step boundaries are journaled for
            // crash-safe resume + `openbuff dash`/replay. Conditional spread:
            // an unjournalable run carries no journal fields at all (the
            // additive-optional contract).
            ...(runJournal
              ? { journalWriter: runJournal, journalReader: runJournal }
              : {}),
          })

          // Accept an aborted run's preserved state while it still owns the send.
          // This serializes cancel-A/send-B and prevents continuation from forking
          // from what the user sees in the TUI.
          if (!isCurrentRunOwner()) {
            logger.debug(
              {
                aborted: abortController.signal.aborted,
                isCurrentRunOwner: isCurrentRunOwner(),
              },
              '[send-message] Ignoring run completion from superseded send',
            )
            return
          }

          setIsRetrying(false)
          const replayRefused = resumeInterruptedTurn && runState.runOutcome?.cause?.code === 'replay_unavailable'
          if (!replayRefused) {
            runState = stampRunPromptBoundary(runState, userMessageId)
            previousRunStateRef.current = runState
            setRunState(runState)
            setMessages((currentMessages) => {
              saveChatState(runState, currentMessages)
              return currentMessages
            })
            // Serialize the clear with any in-flight checkpoint write.
            await clearCheckpoint()
            if (!isCurrentRunOwner()) return
            resumableCheckpointRef.current = null
          }
          // A replay refusal is visible to the user, but it isn't a new
          // completed turn and must not overwrite the saved checkpoint.
          await handleRunCompletion({
            runState,
            actualCredits,
            agentMode,
            timerController,
            updater,
            aiMessageId,
            wasAbortedByUser: abortController.signal.aborted,
            setStreamStatus,
            setCanProcessQueue,
            updateChainInProgress,
            setHasReceivedPlanResponse,
            resumeQueue,
            isProcessingQueueRef,
            isQueuePausedRef,
            isCurrentRunOwner,
            onSnapshotStarted: (completion) => {
              snapshotCompletionRef.current = completion
              void completion.then(() => {
                if (snapshotCompletionRef.current === completion)
                  snapshotCompletionRef.current = null
              })
            },
          })
        } catch (error) {
          if (isCurrentRunOwner() && !abortController.signal.aborted) {
            handleRunError({
              error,
              timerController,
              updater,
              setIsRetrying,
              setStreamStatus,
              setCanProcessQueue,
              updateChainInProgress,
              isProcessingQueueRef,
              isQueuePausedRef,
            })
          } else {
            logger.debug({ error }, '[send-message] Run rejected after abort')
            if (isCurrentRunOwner()) {
              finalizeQueueState({
                setStreamStatus,
                setCanProcessQueue,
                updateChainInProgress,
                isProcessingQueueRef,
                isQueuePausedRef,
                resumeQueue,
              })
            }
          }
        } finally {
          const abandoned = !isCurrentRunOwner()
          if (isCurrentRunOwner()) {
            if (isChainInProgressRef.current) {
              logger.warn(
                {},
                '[send-message] Chain still in progress after try/catch, forcing reset',
              )
              updateChainInProgress(false)
              setStreamStatus('idle')
              setCanProcessQueue(!isQueuePausedRef?.current)
            }
            // Safety net: ensure lock is always released even if handleRunCompletion/handleRunError
            // didn't run (e.g., due to unexpected early return). Redundant releases are safe (idempotent).
            if (isProcessingQueueRef) {
              isProcessingQueueRef.current = false
            }
          }
          releaseRunOwner()
          updater.dispose()
          if (executionToken && sdkExecutionRef.current === executionToken) {
            sdkExecutionRef.current = null
            if (abandoned && activeRunOwnerRef.current === null) {
              updateChainInProgress(false)
              setStreamStatus('idle')
              setCanProcessQueue(!isQueuePausedRef?.current)
              if (isProcessingQueueRef) isProcessingQueueRef.current = false
            }
          }
          if (runJournal) {
            // P2-T7: the run's promise-chain end is the journal's cleanup seam.
            // Best-effort (the turn's outcome is already decided): a close
            // failure logs and must never break the TUI.
            void runJournal.close().catch((closeError) => {
              logger.warn(
                { error: closeError },
                '[send-message] Run journal close failed',
              )
            })
          }
        }
      })()
      try {
        onAccepted?.()
      } catch (error) {
        // Compatibility notification only: callback failures cannot revoke an
        // accepted run, leak its occupancy, or hide its completion handle.
        logger.warn({ error }, '[send-message] onAccepted callback failed')
      }
      return { status: 'accepted', disposition: 'started', completion }
    },
    [
      addActiveSubagent,
      agentId,
      inputRef,
      isChainInProgressRef,
      isProcessingQueueRef,
      isQueuePausedRef,
      mainAgentTimer,
      onBeforeMessageSend,
      onTimerEvent,
      prepareUserMessage,
      removeActiveSubagent,
      resumeQueue,
      scrollToLatest,
      setCanProcessQueue,
      setCompactionNotice,
      setContextWindowUsage,
      setStreamStatus,
      streamRefs,
      updateChainInProgress,
    ],
  )

  return {
    sendMessage,
    clearMessages,
    retryRestore,
    cancelRestore,
  }
}
