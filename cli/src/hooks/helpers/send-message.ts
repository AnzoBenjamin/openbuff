import { getErrorObject } from '@codebuff/common/util/error'
import { runFailureMessage } from '@codebuff/common/types/run-outcome'
import { projectRunOutcomes } from '@openbuff/sdk'

import { getProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { processBashContext } from '../../utils/bash-context-processor'
import {
  markRunningAgentsAsCancelled,
  markRunningToolsAsCancelled,
} from '../../utils/block-operations'
import { formatElapsedTime } from '../../utils/format-elapsed-time'
import { processImagesForMessage } from '../../utils/image-processor'
import { logger } from '../../utils/logger'
import { getFileAttachmentContextMetadata } from '../../utils/pending-attachments'
import {
  appendInterruptionNotice,
  dropTransientCompactionBlocks,
  markPendingCompactionInterrupted,
} from '../../utils/message-block-helpers'
import { getUserMessage } from '../../utils/message-history'
import {
  createBatchedMessageUpdater,
  type BatchedMessageUpdater,
} from '../../utils/message-updater'
import { createModeDividerMessage } from '../../utils/send-message-helpers'
import { notifyTerminal } from '../../utils/terminal-notify'
import { writeToTty } from '../../utils/terminal-title'
import { yieldToEventLoop } from '../../utils/yield-to-event-loop'

import type {
  PendingAttachment,
  PendingFileAttachment,
  PendingImageAttachment,
  PendingTextAttachment,
} from '../../types/store'
import type { ChatMessage } from '../../types/chat'
import type { AgentMode } from '../../utils/constants'
import type { SendMessageTimerController } from '../../utils/send-message-timer'
import type { StreamController } from '../stream-state'
import type { QueuedMessage, StreamStatus } from '../use-message-queue'
import type { MessageContent, RunState } from '@openbuff/sdk'
import type { MutableRefObject, SetStateAction } from 'react'
import {
  createTurnSnapshot,
  logTurnSnapshotFailure,
} from '../../utils/turn-snapshots'

/** Resets queue state on early return (before streaming starts). */
export type ResetEarlyReturnStateParams = {
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
}

export const resetEarlyReturnState = (
  params: ResetEarlyReturnStateParams,
): void => {
  const {
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
  } = params

  updateChainInProgress(false)
  setCanProcessQueue(!isQueuePausedRef?.current)
  if (isProcessingQueueRef) {
    isProcessingQueueRef.current = false
  }
}

export const createRunOwnership = (
  activeRunOwnerRef: MutableRefObject<symbol | null>,
): {
  isCurrentRunOwner: () => boolean
  isCurrentRunActive: (signal: AbortSignal) => boolean
  releaseRunOwner: () => void
} => {
  const runOwner = Symbol('sendMessageRun')
  activeRunOwnerRef.current = runOwner
  const isCurrentRunOwner = () => activeRunOwnerRef.current === runOwner
  const isCurrentRunActive = (signal: AbortSignal) =>
    isCurrentRunOwner() && !signal.aborted
  const releaseRunOwner = () => {
    if (isCurrentRunOwner()) {
      activeRunOwnerRef.current = null
    }
  }

  return { isCurrentRunOwner, isCurrentRunActive, releaseRunOwner }
}

export const cleanupProviderReadinessFailure = (params: {
  message: string
  updater: BatchedMessageUpdater
  timerController: SendMessageTimerController
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  releaseRunOwner: () => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
}): void => {
  const {
    message,
    updater,
    timerController,
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    releaseRunOwner,
    isProcessingQueueRef,
    isQueuePausedRef,
  } = params

  updater.setError(message)
  timerController.stop('error')
  setStreamStatus('idle')
  setCanProcessQueue(!isQueuePausedRef?.current)
  if (isProcessingQueueRef) {
    isProcessingQueueRef.current = false
  }
  updateChainInProgress(false)
  releaseRunOwner()
}

/** Resets queue state after streaming completes, aborts, or errors. */
export type FinalizeQueueStateParams = {
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
  resumeQueue?: () => void
}

export const finalizeQueueState = (params: FinalizeQueueStateParams): void => {
  const {
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
    resumeQueue,
  } = params

  setStreamStatus('idle')
  // Release lock here as part of normal completion flow.
  // Also released in finally block and .catch() as safety nets (idempotent).
  if (isProcessingQueueRef) {
    isProcessingQueueRef.current = false
  }
  if (resumeQueue) {
    resumeQueue()
  } else {
    setCanProcessQueue(!isQueuePausedRef?.current)
  }
  updateChainInProgress(false)
}

const DEFAULT_RUN_OUTPUT_ERROR_MESSAGE = 'No output from agent run'

export type PrepareUserMessageDeps = {
  setMessages: (update: SetStateAction<ChatMessage[]>) => void
  lastMessageMode: AgentMode | null
  setLastMessageMode: (mode: AgentMode | null) => void
  scrollToLatest: () => void
  setHasReceivedPlanResponse: (value: boolean) => void
}

export const formatFileAttachmentForPrompt = (
  att: PendingFileAttachment,
): string => {
  const context = getFileAttachmentContextMetadata(att)
  const bounds = att.isDirectory
    ? context.totalEntries === undefined
      ? ''
      : `; entries=${context.entriesIncluded}/${context.totalEntries}`
    : context.totalBytes === undefined
      ? ''
      : `; bytes=${context.bytesRead}/${context.totalBytes}`
  const warning =
    context.completeness === 'full'
      ? ''
      : '\n[Warning: This attachment is incomplete. Use read_files/read_subtree to verify the live source before relying on omitted content.]'
  const kind = att.isDirectory ? 'Directory' : 'File'
  return `[${kind}: ${att.path}; source=${context.provenance}; completeness=${context.completeness}${bounds}]\n${att.content}${warning}`
}

/**
 * Fold a queued prompt's attachments into the text persisted to the session
 * history, mirroring the folding prepareUserMessage applies at send time so a
 * drained queue entry survives the restart with its context intact
 * (reliability finding exit-drain-drops-queued-attachments). Text attachments
 * keep the `[Pasted Text]` shape and file attachments reuse
 * formatFileAttachmentForPrompt; image attachments cannot round-trip their
 * binary payload through the text journal, so a locating note is persisted
 * instead of silently discarding them.
 */
export const formatQueuedMessageForHistory = (
  queued: QueuedMessage,
): string => {
  if (queued.attachments.length === 0) return queued.content
  const parts = queued.content ? [queued.content] : []
  for (const att of queued.attachments) {
    switch (att.kind) {
      case 'text':
        parts.push(`[Pasted Text]\n${att.content}`)
        break
      case 'file':
        parts.push(formatFileAttachmentForPrompt(att))
        break
      case 'image':
        parts.push(
          att.status === 'error'
            ? `[Image attachment: ${att.path}; failed: ${att.note ?? 'error'}]`
            : `[Image attachment: ${att.path}]`,
        )
        break
    }
  }
  return parts.join('\n\n')
}

export const prepareUserMessage = async (params: {
  content: string
  agentMode: AgentMode
  postUserMessage?: (prev: ChatMessage[]) => ChatMessage[]
  attachments?: PendingAttachment[]
  isCurrent?: () => boolean
  deps: PrepareUserMessageDeps
}): Promise<{
  userMessageId: string
  messageContent: MessageContent[] | undefined
  bashContextForPrompt: string
  finalContent: string
}> => {
  const { content, agentMode, postUserMessage, attachments, deps } = params
  const assertCurrent = () => {
    if (params.isCurrent?.() === false)
      throw new DOMException('Conversation changed', 'AbortError')
  }
  assertCurrent()
  const { setMessages, lastMessageMode, setLastMessageMode, scrollToLatest } =
    deps

  // Atomic drain: the read and the clear are one store transaction, so a
  // concurrent send or exit-time queue drain can neither re-append a drained
  // item (interruption between read and clear) nor drop one (two readers, one
  // clearing first) (reliability finding
  // pending-attachments-and-bash-messages-non-atomic-drain).
  const pendingBashMessages = useChatStore.getState().drainPendingBashMessages()
  const { bashMessages, bashContextForPrompt } =
    processBashContext(pendingBashMessages)

  if (bashMessages.length > 0) {
    setMessages((prev) => [...prev, ...bashMessages])
  }

  // Atomic drain as above; explicit `attachments` (a queued prompt's already
  // detached attachments) bypass the store queue entirely.
  const allAttachments =
    attachments ?? useChatStore.getState().drainPendingAttachments()

  const pendingImages = allAttachments.filter(
    (a): a is PendingImageAttachment => a.kind === 'image',
  )
  const pendingTextAttachments = allAttachments.filter(
    (a): a is PendingTextAttachment => a.kind === 'text',
  )

  const pendingFileAttachments = allAttachments.filter(
    (a): a is PendingFileAttachment => a.kind === 'file',
  )

  // Append text attachments to the content
  let finalContent = content
  if (pendingTextAttachments.length > 0) {
    const textAttachmentContent = pendingTextAttachments
      .map((att) => `[Pasted Text]\n${att.content}`)
      .join('\n\n')
    finalContent = content
      ? `${content}\n\n${textAttachmentContent}`
      : textAttachmentContent
  }

  // Append file/folder attachments to the content
  if (pendingFileAttachments.length > 0) {
    const fileAttachmentContent = pendingFileAttachments
      .filter((att) => att.status === 'ready')
      .map(formatFileAttachmentForPrompt)
      .join('\n\n')
    if (fileAttachmentContent) {
      finalContent = finalContent
        ? `${finalContent}\n\n${fileAttachmentContent}`
        : fileAttachmentContent
    }
  }

  const { attachments: imageAttachments, messageContent } =
    await processImagesForMessage({
      content: finalContent,
      pendingImages,
      projectRoot: getProjectRoot(),
    })
  assertCurrent()

  const shouldInsertDivider =
    lastMessageMode === null || lastMessageMode !== agentMode

  // Convert pending text attachments to stored text attachments for display
  const textAttachmentsForMessage = pendingTextAttachments.map((att) => ({
    id: att.id,
    content: att.content,
    preview: att.preview,
    charCount: att.charCount,
  }))

  // Convert pending file attachments to stored file attachments for display
  const fileAttachmentsForMessage = pendingFileAttachments
    .filter((att) => att.status === 'ready')
    .map((att) => ({
      path: att.path,
      filename: att.filename,
      isDirectory: att.isDirectory,
      note: att.note,
    }))

  // Pass original content (not finalContent) for display, but finalContent goes to agent
  const userMessage = getUserMessage(
    content,
    imageAttachments,
    textAttachmentsForMessage,
    fileAttachmentsForMessage,
  )
  const userMessageId = userMessage.id
  if (imageAttachments.length > 0) {
    userMessage.attachments = imageAttachments
  }

  setMessages((prev) => {
    let next = [...prev]
    if (shouldInsertDivider) {
      next.push(createModeDividerMessage(agentMode))
    }
    next.push(userMessage)
    if (postUserMessage) {
      next = postUserMessage(next)
    }
    if (next.length > 100) {
      next = next.slice(-100)
    }
    return next
  })

  setLastMessageMode(agentMode)
  await yieldToEventLoop()
  setTimeout(() => {
    if (params.isCurrent?.() !== false) scrollToLatest()
  }, 0)

  return {
    userMessageId,
    messageContent,
    bashContextForPrompt,
    finalContent,
  }
}

export const setupStreamingContext = (params: {
  aiMessageId: string
  timerController: SendMessageTimerController
  setMessages: (updater: (messages: ChatMessage[]) => ChatMessage[]) => void
  streamRefs: StreamController
  abortControllerRef: MutableRefObject<AbortController | null>
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  isQueuePausedRef?: MutableRefObject<boolean>
  isProcessingQueueRef?: MutableRefObject<boolean>
  updateChainInProgress: (value: boolean) => void
  setIsRetrying: (value: boolean) => void
  setStreamingAgents: (updater: (prev: Set<string>) => Set<string>) => void
}) => {
  const {
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
  } = params
  const { aiMessageId } = params

  streamRefs.reset()
  timerController.start(aiMessageId)
  const updater = createBatchedMessageUpdater(aiMessageId, setMessages)
  // Clear any previous UI-only error on this message when starting a new run
  updater.clearUserError()
  const hasReceivedContentRef = { current: false }
  const abortController = new AbortController()
  abortControllerRef.current = abortController

  abortController.signal.addEventListener('abort', () => {
    // Cancellation is a state, not completion. Keep the chain/queue lock until
    // client.run() settles so its authoritative preserved RunState becomes the
    // continuation base before another prompt is admitted.
    streamRefs.setters.setWasAbortedByUser(true)
    setIsRetrying(false)
    timerController.stop('aborted')

    // Update stream status so the UI reflects cancellation visually
    setStreamStatus('cancelling')

    // Clear streaming agents so cancelled status displays correctly in UI
    setStreamingAgents(() => new Set())

    updateChainInProgress(true)
    setCanProcessQueue(false)

    updater.updateAiMessageBlocks((blocks) => {
      const cancelledBlocks = markRunningToolsAsCancelled(
        markRunningAgentsAsCancelled(blocks),
      )
      // A compaction pass that was still running is terminated here, in the
      // same composed update: the SDK drops every post-abort event, so neither
      // `settled` nor `finish` arrives to end the pending state, and this is
      // the last write before the turn's blocks are persisted. A transient
      // (self-dismissing) card is dropped in the same pass, so an abort mid-hold
      // cannot persist one either.
      return appendInterruptionNotice(
        dropTransientCompactionBlocks(
          markPendingCompactionInterrupted(cancelledBlocks),
        ),
      )
    })
    updater.markComplete()
  })

  return { updater, hasReceivedContentRef, abortController }
}

export const handleRunCompletion = (params: {
  runState: RunState
  actualCredits: number | undefined
  agentMode: AgentMode
  timerController: SendMessageTimerController
  updater: BatchedMessageUpdater
  aiMessageId: string
  wasAbortedByUser: boolean
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  setHasReceivedPlanResponse: (value: boolean) => void
  resumeQueue?: () => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
}) => {
  const {
    runState,
    actualCredits,
    agentMode,
    timerController,
    updater,
    wasAbortedByUser,
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    setHasReceivedPlanResponse,
    resumeQueue,
    isProcessingQueueRef,
    isQueuePausedRef,
  } = params

  const projected = projectRunOutcomes(
    runState,
    wasAbortedByUser
      ? {
          runOutcome:
            runState.runOutcome?.termination === 'cancelled'
              ? runState.runOutcome
              : {
                  termination: 'cancelled',
                  cause: {
                    code: 'run_cancelled',
                    message: 'Run cancelled by user.',
                  },
                },
        }
      : undefined,
  )
  updater.updateAiMessage((message) => ({
    ...message,
    runOutcome: projected.runOutcome,
    taskAcceptance: projected.taskAcceptance,
    actionOutcomes: projected.actionOutcomes,
  }))
  if (wasAbortedByUser) {
    updater.flush()
    finalizeQueueState({
      setStreamStatus,
      setCanProcessQueue,
      updateChainInProgress,
      isProcessingQueueRef,
      isQueuePausedRef,
      resumeQueue,
    })
    return
  }

  const output = projected.output
  const finalizeAfterError = () => {
    // The caller has already applied the terminal error write (setError) right
    // before this helper runs; the timer stop must also settle BEFORE the
    // queue gate reopens (reliability finding
    // queue-gate-reopens-before-batched-updater-settles):
    // finalizeQueueState releases setStreamStatus('idle') / the chain lock,
    // and a queued follow-up that starts afterwards would mutate the same
    // chat-store messages batch while the previous turn's writes are still
    // in flight.
    timerController.stop('error')
    finalizeQueueState({
      setStreamStatus,
      setCanProcessQueue,
      updateChainInProgress,
      isProcessingQueueRef,
      isQueuePausedRef,
    })
  }

  if (!output) {
    if (!wasAbortedByUser) {
      updater.setError(DEFAULT_RUN_OUTPUT_ERROR_MESSAGE)
      finalizeAfterError()
    }
    return
  }

  const failureMessage = runFailureMessage(projected)
  if (failureMessage) {
    updater.setError(failureMessage)

    finalizeAfterError()
    return
  }

  // P1-T7: Successful turn — fire-and-forget terminal notification so the
  // user knows the run finished. Aborts and errors return above, so this
  // fires exactly once per successful turn.
  notifyTerminal(
    { body: 'Turn complete' },
    {
      write: (sequence) => {
        writeToTty(sequence)
      },
    },
  )

  // P2-T4: Successful turn — fire-and-forget git-plumbing snapshot of the
  // tracked tree on refs/openbuff/turns. Aborts and errors return above, so
  // this fires exactly once per successful turn. createTurnSnapshot never
  // rejects; the catch is belt-and-suspenders so a snapshot failure can
  // never break the turn path. Turn END is not a race (finding a), so this
  // stays fire-and-forget — but the structured outcome is no longer dropped
  // silently (finding b): an 'error' outcome logs one latched warning so a
  // broken snapshot pipeline is visible instead of /undo-turn later saying
  // 'nothing-to-undo' with no explanation.
  void createTurnSnapshot({ label: 'turn' })
    .then((outcome) => logTurnSnapshotFailure(outcome, 'turn'))
    .catch(() => undefined)

  // The previous turn's terminal message write must settle BEFORE the queue
  // gate reopens (reliability finding
  // queue-gate-reopens-before-batched-updater-settles):
  // finalizeQueueState releases setStreamStatus('idle') / resumeQueue() / the
  // chain lock, and a queued follow-up that starts afterwards would mutate
  // the same chat-store messages batch while this turn's batched AI-message
  // write-out is still in flight. Settle the timer and markComplete first;
  // reopen the queue gate LAST.
  const timerResult = timerController.stop('success')

  if (agentMode === 'PLAN') {
    setHasReceivedPlanResponse(true)
  }

  const elapsedMs = timerResult?.elapsedMs ?? 0
  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  let completionTime: string | undefined
  if (elapsedSeconds > 0) {
    completionTime = formatElapsedTime(elapsedSeconds)
  }

  const cacheStats = runState.sessionState?.mainAgentState
  const cacheHitRate =
    cacheStats && cacheStats.cacheTotalInputTokens > 0
      ? cacheStats.cacheInputTokens / cacheStats.cacheTotalInputTokens
      : undefined

  updater.markComplete({
    ...(completionTime && { completionTime }),
    ...(actualCredits !== undefined && { credits: actualCredits }),
    ...(cacheHitRate !== undefined && { cacheHitRate }),
  })

  // Queue gate reopens only after the timer stop and markComplete above
  // have settled (see the comment at the start of this block).
  finalizeQueueState({
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
    resumeQueue,
  })
}

export const handleRunError = (params: {
  error: unknown
  timerController: SendMessageTimerController
  updater: BatchedMessageUpdater
  setIsRetrying: (value: boolean) => void
  setStreamStatus: (status: StreamStatus) => void
  setCanProcessQueue: (can: boolean) => void
  updateChainInProgress: (value: boolean) => void
  isProcessingQueueRef?: MutableRefObject<boolean>
  isQueuePausedRef?: MutableRefObject<boolean>
}) => {
  const {
    error,
    timerController,
    updater,
    setIsRetrying,
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
  } = params

  const errorInfo = getErrorObject(error, { includeRawError: true })

  logger.error({ error: errorInfo }, 'SDK client.run() failed')
  setIsRetrying(false)

  // The previous turn's terminal message write and the timer stop must
  // settle BEFORE the queue gate reopens (reliability finding
  // queue-gate-reopens-before-batched-updater-settles):
  // finalizeQueueState releases setStreamStatus('idle') / the chain lock,
  // and a queued follow-up that starts afterwards would mutate the same
  // chat-store messages batch while this turn's writes are still in flight.
  timerController.stop('error')

  // Use setError for all errors so they display in UserErrorBanner consistently
  const errorMessage = errorInfo.message || 'An unexpected error occurred'
  updater.setError(errorMessage)

  // Queue gate reopens only after the timer stop and terminal setError
  // above have settled.
  finalizeQueueState({
    setStreamStatus,
    setCanProcessQueue,
    updateChainInProgress,
    isProcessingQueueRef,
    isQueuePausedRef,
  })
}
