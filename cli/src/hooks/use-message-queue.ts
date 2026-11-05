import { useCallback, useEffect, useRef, useState } from 'react'

import { logger } from '../utils/logger'
import { getPendingAttachmentId } from '../utils/pending-attachments'

import type { PendingAttachment } from '../types/store'
import type { AgentMode } from '../utils/constants'
import type { MutableRefObject } from 'react'

export type StreamStatus = 'idle' | 'waiting' | 'streaming' | 'cancelling'

export type QueuedMessage = {
  id?: string
  content: string
  attachments: PendingAttachment[]
  agentMode: AgentMode
}

export const createQueueProcessingOwnership = (
  activeQueueProcessingOwnerRef: MutableRefObject<symbol | null>,
): {
  isCurrentQueueProcessingOwner: () => boolean
  releaseQueueProcessingOwner: () => void
} => {
  const queueProcessingOwner = Symbol('queue-processing-owner')
  activeQueueProcessingOwnerRef.current = queueProcessingOwner

  const isCurrentQueueProcessingOwner = () =>
    activeQueueProcessingOwnerRef.current === queueProcessingOwner

  const releaseQueueProcessingOwner = () => {
    if (isCurrentQueueProcessingOwner()) {
      activeQueueProcessingOwnerRef.current = null
    }
  }

  return { isCurrentQueueProcessingOwner, releaseQueueProcessingOwner }
}

export type QueueProcessingRun = {
  isCurrentQueueProcessingOwner: () => boolean
  releaseQueueProcessingOwner: () => void
}

export type BeginQueuedMessageProcessingParams = {
  isProcessingQueueRef: MutableRefObject<boolean>
  isQueuePausedRef: MutableRefObject<boolean>
  queueProcessingOwnerRef: MutableRefObject<symbol | null>
  setCanProcessQueue: (can: boolean) => void
}

export const beginQueuedMessageProcessing = (
  params: BeginQueuedMessageProcessingParams,
): QueueProcessingRun => {
  const {
    isProcessingQueueRef,
    isQueuePausedRef,
    queueProcessingOwnerRef,
    setCanProcessQueue,
  } = params

  isProcessingQueueRef.current = true
  const { isCurrentQueueProcessingOwner, releaseQueueProcessingOwner } =
    createQueueProcessingOwnership(queueProcessingOwnerRef)

  return {
    isCurrentQueueProcessingOwner,
    releaseQueueProcessingOwner,
  }
}

export type CompleteQueuedMessageProcessingParams = {
  messageToProcess: QueuedMessage
  sendMessage: (message: QueuedMessage) => Promise<void>
  onRejected?: (message: QueuedMessage, error: unknown) => void
  isProcessingQueueRef: MutableRefObject<boolean>
  queueProcessingRun: QueueProcessingRun
}

export const completeQueuedMessageProcessing = (
  params: CompleteQueuedMessageProcessingParams,
): void => {
  const {
    messageToProcess,
    sendMessage,
    onRejected,
    isProcessingQueueRef,
    queueProcessingRun,
  } = params

  // A sendMessage implementation that throws synchronously returns nothing
  // to chain .catch on (reviewer advisory): without this guard the throw
  // would escape before the `.finally` cleanup, leaking the processing lock
  // and orphaning the queue. Route it through the same rejection path.
  let sendPromise: Promise<void>
  try {
    sendPromise = sendMessage(messageToProcess)
  } catch (err: unknown) {
    logger.warn(
      { error: err },
      '[message-queue] sendMessage threw synchronously',
    )
    onRejected?.(messageToProcess, err)
    if (queueProcessingRun.isCurrentQueueProcessingOwner()) {
      isProcessingQueueRef.current = false
      queueProcessingRun.releaseQueueProcessingOwner()
      logger.debug('[message-queue] Processing lock released')
    }
    return
  }
  sendPromise
    .catch((err: unknown) => {
      logger.warn(
        { error: err },
        '[message-queue] sendMessage promise rejected',
      )
      onRejected?.(messageToProcess, err)
    })
    .finally(() => {
      if (!queueProcessingRun.isCurrentQueueProcessingOwner()) {
        logger.debug('[message-queue] Ignoring stale processing cleanup')
        return
      }
      isProcessingQueueRef.current = false
      queueProcessingRun.releaseQueueProcessingOwner()
      logger.debug('[message-queue] Processing lock released')
    })
}

export type RunQueuedMessageParams = BeginQueuedMessageProcessingParams & {
  messageToProcess: QueuedMessage
  sendMessage: (message: QueuedMessage) => Promise<void>
  onRejected?: (message: QueuedMessage, error: unknown) => void
}

export const runQueuedMessage = (params: RunQueuedMessageParams): void => {
  const queueProcessingRun = beginQueuedMessageProcessing(params)

  completeQueuedMessageProcessing({
    messageToProcess: params.messageToProcess,
    sendMessage: params.sendMessage,
    onRejected: params.onRejected,
    isProcessingQueueRef: params.isProcessingQueueRef,
    queueProcessingRun,
  })
}

export const useMessageQueue = (
  sendMessage: (message: QueuedMessage) => Promise<void>,
  isChainInProgressRef: MutableRefObject<boolean>,
  activeAgentStreamsRef: MutableRefObject<number>,
) => {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle')
  const [canProcessQueue, setCanProcessQueue] = useState<boolean>(true)
  // Separate state for user-initiated pause to ensure re-renders when pause status changes
  const [queuePausedState, setQueuePausedState] = useState<boolean>(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [queueRemovalCount, setQueueRemovalCount] = useState(0)
  const [attachmentRemovalCount, setAttachmentRemovalCount] = useState(0)
  const [queueAttachmentNotice, setQueueAttachmentNotice] = useState<
    string | null
  >(null)
  const attachmentRevisions = useRef(new Map<string, number>())
  const activeAttachmentReads = useRef(new Map<string, PendingAttachment>())
  const removedAttachment = useRef<{
    messageId: string
    index: number
    attachment: PendingAttachment
  } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeAttachmentReads.current.clear()
    }
  }, [])
  const removedMessagesRef = useRef<
    Array<{ message: QueuedMessage; index: number }>
  >([])

  // Keep a ref so clearQueue can return the current queue synchronously.
  const queuedMessagesRef = useRef<QueuedMessage[]>([])
  const attachmentKey = (messageId: string, attachmentId: string) =>
    `${messageId}\0${attachmentId}`
  const hasQueuedAttachmentReads = useCallback(
    () => activeAttachmentReads.current.size > 0,
    [],
  )
  const getQueuedAttachmentRevision = useCallback(
    (messageId: string, attachmentId: string) =>
      attachmentRevisions.current.get(attachmentKey(messageId, attachmentId)) ??
      0,
    [],
  )
  // Restore captured snapshots before archiving a removal. An Undo never revives an old read owner.
  const invalidateQueuedAttachmentReads = useCallback(
    (messages: QueuedMessage[]) =>
      messages.map((message) => {
        if (!message.id) return message
        let changed = false
        const attachments = message.attachments.map((attachment) => {
          const key = attachmentKey(
            message.id!,
            getPendingAttachmentId(attachment),
          )
          attachmentRevisions.current.set(
            key,
            (attachmentRevisions.current.get(key) ?? 0) + 1,
          )
          const original = activeAttachmentReads.current.get(key)
          activeAttachmentReads.current.delete(key)
          if (!activeAttachmentReads.current.size)
            setQueueAttachmentNotice(null)
          if (original) {
            changed = true
            return original
          }
          return attachment
        })
        return changed ? { ...message, attachments } : message
      }),
    [],
  )
  const updateQueuedAttachment = useCallback(
    (
      messageId: string,
      attachmentId: string,
      replacement: PendingAttachment,
      expected?: PendingAttachment,
      expectedRevision?: number,
    ) => {
      if (
        !mounted.current ||
        getPendingAttachmentId(replacement) !== attachmentId
      )
        return false
      const message = queuedMessagesRef.current.find(
        (item) => item.id === messageId,
      )
      const attachment = message?.attachments.find(
        (item) => getPendingAttachmentId(item) === attachmentId,
      )
      const key = attachmentKey(messageId, attachmentId)
      if (
        !attachment ||
        (expected && attachment !== expected) ||
        (expectedRevision !== undefined &&
          getQueuedAttachmentRevision(messageId, attachmentId) !==
            expectedRevision)
      )
        return false
      if (replacement.kind !== 'text' && replacement.status === 'processing') {
        if (!activeAttachmentReads.current.has(key))
          activeAttachmentReads.current.set(key, attachment)
      } else activeAttachmentReads.current.delete(key)
      setQueueAttachmentNotice(
        activeAttachmentReads.current.size
          ? 'Queued attachment is reading · queue paused'
          : null,
      )
      attachmentRevisions.current.set(
        key,
        getQueuedAttachmentRevision(messageId, attachmentId) + 1,
      )
      const next = queuedMessagesRef.current.map((item) =>
        item.id === messageId
          ? {
              ...item,
              attachments: item.attachments.map((value) =>
                getPendingAttachmentId(value) === attachmentId
                  ? replacement
                  : value,
              ),
            }
          : item,
      )
      queuedMessagesRef.current = next
      setQueuedMessages(next)
      return true
    },
    [getQueuedAttachmentRevision],
  )
  const cancelQueuedAttachmentRetry = useCallback(
    (messageId: string, attachmentId: string, expectedRevision: number) => {
      const key = attachmentKey(messageId, attachmentId)
      const original = activeAttachmentReads.current.get(key)
      if (
        !mounted.current ||
        !original ||
        getQueuedAttachmentRevision(messageId, attachmentId) !==
          expectedRevision
      )
        return false
      activeAttachmentReads.current.delete(key)
      attachmentRevisions.current.set(key, expectedRevision + 1)
      if (!activeAttachmentReads.current.size) setQueueAttachmentNotice(null)
      const next = queuedMessagesRef.current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              attachments: message.attachments.map((item) =>
                getPendingAttachmentId(item) === attachmentId ? original : item,
              ),
            }
          : message,
      )
      queuedMessagesRef.current = next
      setQueuedMessages(next)
      return true
    },
    [getQueuedAttachmentRevision],
  )
  const removeQueuedAttachment = useCallback(
    (messageId: string, attachmentId: string) => {
      const current = queuedMessagesRef.current
      const index = current.findIndex((item) => item.id === messageId)
      if (index < 0) return false
      if (
        !current[index].attachments.some(
          (attachment) => getPendingAttachmentId(attachment) === attachmentId,
        )
      )
        return false
      const message = invalidateQueuedAttachmentReads([current[index]])[0]
      const attachmentIndex = message.attachments.findIndex(
        (item) => getPendingAttachmentId(item) === attachmentId,
      )
      if (attachmentIndex < 0) return false
      removedAttachment.current = {
        messageId,
        index: attachmentIndex,
        attachment: message.attachments[attachmentIndex],
      }
      const next = current.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...message,
              attachments: message.attachments.filter(
                (_, position) => position !== attachmentIndex,
              ),
            }
          : item,
      )
      queuedMessagesRef.current = next
      setQueuedMessages(next)
      setAttachmentRemovalCount(1)
      return true
    },
    [invalidateQueuedAttachmentReads],
  )
  const undoQueuedAttachmentRemoval = useCallback(() => {
    const removed = removedAttachment.current
    if (!removed) return 0
    const index = queuedMessagesRef.current.findIndex(
      (item) => item.id === removed.messageId,
    )
    if (index < 0) return 0
    const message = queuedMessagesRef.current[index]
    const id = getPendingAttachmentId(removed.attachment)
    removedAttachment.current = null
    setAttachmentRemovalCount(0)
    if (message.attachments.some((item) => getPendingAttachmentId(item) === id))
      return 0
    const key = attachmentKey(removed.messageId, id)
    attachmentRevisions.current.set(
      key,
      getQueuedAttachmentRevision(removed.messageId, id) + 1,
    )
    const attachments = [...message.attachments]
    attachments.splice(
      Math.min(removed.index, attachments.length),
      0,
      removed.attachment,
    )
    const next = queuedMessagesRef.current.map((item, itemIndex) =>
      itemIndex === index ? { ...message, attachments } : item,
    )
    queuedMessagesRef.current = next
    setQueuedMessages(next)
    isQueuePausedRef.current = true
    setQueuePausedState(true)
    setCanProcessQueue(false)
    return 1
  }, [getQueuedAttachmentRevision])
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamMessageIdRef = useRef<string | null>(null)
  const isProcessingQueueRef = useRef<boolean>(false)
  // User-initiated pause state (separate from system-busy state)
  const isQueuePausedRef = useRef<boolean>(false)
  const queueProcessingOwnerRef = useRef<symbol | null>(null)

  // queuePaused reflects whether the user has explicitly paused the queue
  // (not whether the system is temporarily busy processing)
  // Use state instead of ref to ensure components re-render when pause status changes
  const queuePaused = queuePausedState

  const clearStreaming = useCallback(() => {
    if (streamTimeoutRef.current) {
      clearTimeout(streamTimeoutRef.current)
      streamTimeoutRef.current = null
    }
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current)
      streamIntervalRef.current = null
    }
    streamMessageIdRef.current = null
    activeAgentStreamsRef.current = 0
    setStreamStatus('idle')
  }, [activeAgentStreamsRef])

  useEffect(() => {
    return () => {
      clearStreaming()
    }
  }, [clearStreaming])

  const processNextMessage = useCallback(() => {
    const queuedList = queuedMessagesRef.current
    const queueLength = queuedList.length

    if (queueLength === 0) {
      return
    }
    if (
      !queuedList[0].content.trim() &&
      queuedList[0].attachments.length === 0
    ) {
      isQueuePausedRef.current = true
      setQueuePausedState(true)
      setCanProcessQueue(false)
      setQueueAttachmentNotice(
        'The next queued item has no prompt or attachment. Edit, restore or remove it before resuming.',
      )
      return
    }

    // Check if user has explicitly paused the queue
    if (isQueuePausedRef.current) {
      logger.debug(
        { queueLength },
        '[message-queue] Queue blocked: user paused',
      )
      return
    }

    if (!canProcessQueue) {
      return
    }
    if (streamStatus !== 'idle') {
      logger.debug(
        { queueLength, streamStatus },
        '[message-queue] Queue blocked: stream not idle',
      )
      return
    }
    if (streamMessageIdRef.current) {
      logger.debug(
        { queueLength, streamMessageId: streamMessageIdRef.current },
        '[message-queue] Queue blocked: streamMessageId set',
      )
      return
    }
    if (isChainInProgressRef.current) {
      logger.debug(
        { queueLength, isChainInProgress: isChainInProgressRef.current },
        '[message-queue] Queue blocked: chain in progress',
      )
      return
    }
    if (activeAgentStreamsRef.current > 0) {
      logger.debug(
        { queueLength, activeAgentStreams: activeAgentStreamsRef.current },
        '[message-queue] Queue blocked: active agent streams',
      )
      return
    }

    if (isProcessingQueueRef.current) {
      logger.debug(
        { queueLength },
        '[message-queue] Queue blocked: already processing',
      )
      return
    }

    logger.info(
      { queueLength },
      '[message-queue] Processing next message from queue',
    )

    // Read the message to process from the ref BEFORE calling setState.
    // We must NOT assign to outer variables inside functional setState callbacks
    // because React can call those callbacks multiple times in concurrent mode,
    // which would cause messages to be skipped.
    const messageToProcess = queuedMessagesRef.current[0]

    if (!messageToProcess) {
      return
    }

    const queueProcessingRun = beginQueuedMessageProcessing({
      isProcessingQueueRef,
      isQueuePausedRef,
      queueProcessingOwnerRef,
      setCanProcessQueue,
    })

    // Now remove the message from the queue
    const remainingMessages = queuedMessagesRef.current.slice(1)
    queuedMessagesRef.current = remainingMessages
    setQueuedMessages(remainingMessages)

    completeQueuedMessageProcessing({
      messageToProcess,
      sendMessage,
      onRejected: (rejectedMessage, error) => {
        // A queued prompt is user data. Put it back at the front and pause the
        // queue so a transient or deterministic send failure cannot silently
        // discard it or trigger an unbounded retry loop.
        const restored = [rejectedMessage, ...queuedMessagesRef.current]
        queuedMessagesRef.current = restored
        setQueuedMessages(restored)
        setQueueError(
          error instanceof Error
            ? error.message
            : 'The queued prompt could not be sent',
        )
        isQueuePausedRef.current = true
        setQueuePausedState(true)
        setCanProcessQueue(false)
      },
      isProcessingQueueRef,
      queueProcessingRun,
    })
  }, [
    canProcessQueue,
    streamStatus,
    sendMessage,
    isChainInProgressRef,
    activeAgentStreamsRef,
  ])

  useEffect(() => {
    processNextMessage()
  }, [
    canProcessQueue,
    streamStatus,
    queuedMessages.length,
    processNextMessage,
    isChainInProgressRef,
  ])

  const addToQueue = useCallback(
    (
      message: string,
      attachments: PendingAttachment[],
      agentMode: AgentMode,
    ) => {
      const queuedMessage: QueuedMessage = {
        id: crypto.randomUUID(),
        content: message,
        attachments: [...attachments],
        agentMode,
      }
      const newQueue = [...queuedMessagesRef.current, queuedMessage]
      queuedMessagesRef.current = newQueue
      setQueuedMessages(newQueue)
    },
    [],
  )

  const pauseQueue = useCallback(() => {
    isQueuePausedRef.current = true
    setQueuePausedState(true)
    setCanProcessQueue(false)
  }, [])

  const resumeQueue = useCallback(() => {
    const next = queuedMessagesRef.current[0]
    if (next && !next.content.trim() && next.attachments.length === 0) {
      setQueueAttachmentNotice(
        'The next queued item has no prompt or attachment. Edit, restore or remove it before resuming.',
      )
      return
    }
    if (activeAttachmentReads.current.size) {
      setQueueAttachmentNotice(
        'A queued attachment is still being read. Wait or cancel its retry before resuming.',
      )
      return
    }
    setQueueError(null)
    isQueuePausedRef.current = false
    setQueuePausedState(false)
    setCanProcessQueue(true)
  }, [])

  const updateQueuedMessage = useCallback(
    (
      id: string,
      update: Partial<Pick<QueuedMessage, 'content' | 'agentMode'>>,
    ) => {
      if (!queuedMessagesRef.current.some((message) => message.id === id)) {
        return false
      }
      const next = queuedMessagesRef.current.map((message) =>
        message.id === id ? { ...message, ...update } : message,
      )
      queuedMessagesRef.current = next
      setQueuedMessages(next)
      return true
    },
    [],
  )
  const removeQueuedMessage = useCallback(
    (id: string): QueuedMessage | undefined => {
      const current = queuedMessagesRef.current
      const index = current.findIndex((message) => message.id === id)
      if (index < 0) return
      const message = invalidateQueuedAttachmentReads([current[index]])[0]
      const next = current.filter((item) => item.id !== id)
      queuedMessagesRef.current = next
      setQueuedMessages(next)
      removedMessagesRef.current = [{ message, index }]
      setQueueRemovalCount(1)
      return message
    },
    [invalidateQueuedAttachmentReads],
  )
  const undoQueueRemoval = useCallback(() => {
    const removed = removedMessagesRef.current
    if (!removed.length) return 0
    // Restoration is a reading/recovery action. Wait for an explicit Resume
    // instead of dispatching the recovered work as soon as it reappears.
    isQueuePausedRef.current = true
    setQueuePausedState(true)
    setCanProcessQueue(false)
    const next = [...queuedMessagesRef.current]
    let restoredCount = 0
    for (const { message: captured, index } of removed) {
      const message = invalidateQueuedAttachmentReads([captured])[0]
      if (message.id && next.some((item) => item.id === message.id)) continue
      next.splice(Math.min(index, next.length), 0, message)
      restoredCount++
    }
    queuedMessagesRef.current = next
    setQueuedMessages(next)
    // Consume synchronously: repeated Undo in one input batch cannot duplicate
    // prompts while React is still committing the state update.
    removedMessagesRef.current = []
    setQueueRemovalCount(0)
    return restoredCount
  }, [invalidateQueuedAttachmentReads])

  const cancelQueuedMessages = useCallback(
    (ids?: readonly string[]) => {
      const scope = ids ? new Set(ids) : null
      const current = queuedMessagesRef.current
      const removed = current.flatMap((message, index) =>
        !scope || (message.id && scope.has(message.id))
          ? [{ message, index }]
          : [],
      )
      if (!removed.length) return []
      const removedSet = new Set(removed.map(({ message }) => message))
      const remaining = current.filter((message) => !removedSet.has(message))
      queuedMessagesRef.current = remaining
      setQueuedMessages(remaining)
      removedMessagesRef.current = removed.map(({ message, index }) => ({
        message: invalidateQueuedAttachmentReads([message])[0],
        index,
      }))
      setQueueRemovalCount(removed.length)
      return removedMessagesRef.current.map(({ message }) => message)
    },
    [invalidateQueuedAttachmentReads],
  )
  const moveQueuedMessage = useCallback((id: string, direction: -1 | 1) => {
    const current = queuedMessagesRef.current
    const index = current.findIndex((message) => message.id === id)
    const destination = index + direction
    if (index < 0 || destination < 0 || destination >= current.length) return
    const next = [...current]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    queuedMessagesRef.current = next
    setQueuedMessages(next)
  }, [])

  // Partial-failure-aware drain (reliability finding
  // exit-drain-partial-failure-drops-queue): the exit path drains one entry
  // at a time so a persist failure leaves the remaining prompts queued
  // instead of having been removed from the queue up front.
  const clearQueue = useCallback(
    (count?: number) => {
      const current = queuedMessagesRef.current
      const drained =
        count === undefined ? current : current.slice(0, Math.max(0, count))
      const remaining =
        count === undefined ? [] : current.slice(Math.max(0, count))
      queuedMessagesRef.current = remaining
      setQueuedMessages(remaining)
      return invalidateQueuedAttachmentReads(drained)
    },
    [invalidateQueuedAttachmentReads],
  )

  const startStreaming = useCallback(() => {
    setStreamStatus('streaming')
    setCanProcessQueue(false)
  }, [])

  const stopStreaming = useCallback(() => {
    setStreamStatus('idle')
    setCanProcessQueue(!isQueuePausedRef.current)
  }, [])

  return {
    queuedMessages,
    queueError,
    queueRemovalCount,
    queueAttachmentNotice,
    hasQueuedAttachmentReads,
    attachmentRemovalCount,
    getQueuedAttachmentRevision,
    updateQueuedAttachment,
    cancelQueuedAttachmentRetry,
    removeQueuedAttachment,
    undoQueuedAttachmentRemoval,
    cancelQueuedMessages,
    updateQueuedMessage,
    removeQueuedMessage,
    moveQueuedMessage,
    undoQueueRemoval,
    streamStatus,
    canProcessQueue,
    queuePaused,
    streamMessageIdRef,
    addToQueue,
    startStreaming,
    stopStreaming,
    setStreamStatus,
    clearStreaming,
    setCanProcessQueue,
    pauseQueue,
    resumeQueue,
    clearQueue,
    isQueuePausedRef,
    isProcessingQueueRef,
  }
}
