import { useCallback, useEffect, useRef, useState } from 'react'

import { logger } from '../utils/logger'

import type { PendingAttachment } from '../types/store'
import type { MutableRefObject } from 'react'

export type StreamStatus = 'idle' | 'waiting' | 'streaming' | 'cancelling'

export type QueuedMessage = {
  content: string
  attachments: PendingAttachment[]
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

  // Keep a ref so clearQueue can return the current queue synchronously.
  const queuedMessagesRef = useRef<QueuedMessage[]>([])
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
    setQueuedMessages((prev) => {
      if (prev.length === 0) {
        return prev
      }
      const remainingMessages = prev.slice(1)
      queuedMessagesRef.current = remainingMessages
      return remainingMessages
    })

    completeQueuedMessageProcessing({
      messageToProcess,
      sendMessage,
      onRejected: (rejectedMessage) => {
        // A queued prompt is user data. Put it back at the front and pause the
        // queue so a transient or deterministic send failure cannot silently
        // discard it or trigger an unbounded retry loop.
        setQueuedMessages((current) => {
          const restored = [rejectedMessage, ...current]
          queuedMessagesRef.current = restored
          return restored
        })
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
    (message: string, attachments: PendingAttachment[] = []) => {
      const queuedMessage = { content: message, attachments }
      // Use functional setState to ensure atomic updates during rapid calls.
      setQueuedMessages((prev) => {
        const newQueue = [...prev, queuedMessage]
        queuedMessagesRef.current = newQueue
        return newQueue
      })
    },
    [],
  )

  const pauseQueue = useCallback(() => {
    isQueuePausedRef.current = true
    setQueuePausedState(true)
    setCanProcessQueue(false)
  }, [])

  const resumeQueue = useCallback(() => {
    isQueuePausedRef.current = false
    setQueuePausedState(false)
    setCanProcessQueue(true)
  }, [])

  // Partial-failure-aware drain (reliability finding
  // exit-drain-partial-failure-drops-queue): the exit path drains one entry
  // at a time so a persist failure leaves the remaining prompts queued
  // instead of having been removed from the queue up front.
  const clearQueue = useCallback((count?: number) => {
    const current = queuedMessagesRef.current
    const drained =
      count === undefined ? current : current.slice(0, Math.max(0, count))
    const remaining =
      count === undefined ? [] : current.slice(Math.max(0, count))
    queuedMessagesRef.current = remaining
    setQueuedMessages(remaining)
    return drained
  }, [])

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
