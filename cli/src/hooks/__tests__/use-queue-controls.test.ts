import { describe, test, expect, mock } from 'bun:test'

import { createQueueCtrlCHandler } from '../use-queue-controls'
import {
  beginQueuedMessageProcessing,
  completeQueuedMessageProcessing,
  createQueueProcessingOwnership,
  runQueuedMessage,
} from '../use-message-queue'

import type { QueuedMessage } from '../use-message-queue'

describe('createQueueProcessingOwnership', () => {
  test('stale owner cannot release newer queue processing owner', () => {
    const activeQueueProcessingOwnerRef = { current: null as symbol | null }

    const ownerA = createQueueProcessingOwnership(activeQueueProcessingOwnerRef)
    expect(ownerA.isCurrentQueueProcessingOwner()).toBe(true)

    const ownerB = createQueueProcessingOwnership(activeQueueProcessingOwnerRef)
    expect(ownerA.isCurrentQueueProcessingOwner()).toBe(false)
    expect(ownerB.isCurrentQueueProcessingOwner()).toBe(true)

    ownerA.releaseQueueProcessingOwner()
    expect(ownerB.isCurrentQueueProcessingOwner()).toBe(true)
    expect(activeQueueProcessingOwnerRef.current).not.toBe(null)

    ownerB.releaseQueueProcessingOwner()
    expect(activeQueueProcessingOwnerRef.current).toBe(null)
  })

  test('stale finally-style cleanup leaves newer processing lock and owner intact', () => {
    const activeQueueProcessingOwnerRef = { current: null as symbol | null }
    const isProcessingQueueRef = { current: false }

    const ownerA = createQueueProcessingOwnership(activeQueueProcessingOwnerRef)

    // A newer queued send starts after owner A was aborted but before owner A's
    // promise settles, replacing the active owner and owning the shared refs.
    const ownerB = createQueueProcessingOwnership(activeQueueProcessingOwnerRef)
    isProcessingQueueRef.current = true

    if (ownerA.isCurrentQueueProcessingOwner()) {
      isProcessingQueueRef.current = false
      ownerA.releaseQueueProcessingOwner()
    }

    expect(isProcessingQueueRef.current).toBe(true)
    expect(ownerB.isCurrentQueueProcessingOwner()).toBe(true)
  })
})

describe('runQueuedMessage', () => {
  const createDeferred = () => {
    let resolvePromise!: () => void
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve
    })

    return { promise, resolve: resolvePromise }
  }

  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

  test('processing lock is acquired before queue mutation and send starts', () => {
    const activeQueueProcessingOwnerRef = { current: null as symbol | null }
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }
    const queue: QueuedMessage[] = [{ content: 'queued', attachments: [] }]
    const messageToProcess = queue[0]
    expect(messageToProcess).toBeDefined()

    const queueProcessingRun = beginQueuedMessageProcessing({
      isProcessingQueueRef,
      isQueuePausedRef,
      queueProcessingOwnerRef: activeQueueProcessingOwnerRef,
      setCanProcessQueue: () => {},
    })

    // Mirrors `processNextMessage`: the lock must be visible before queue state
    // mutation so duplicate updater/re-entry paths see that processing is active.
    expect(isProcessingQueueRef.current).toBe(true)
    const remainingMessages = queue.slice(1)
    expect(isProcessingQueueRef.current).toBe(true)
    expect(remainingMessages).toHaveLength(0)

    completeQueuedMessageProcessing({
      messageToProcess: messageToProcess!,
      sendMessage: () => Promise.resolve(),
      isProcessingQueueRef,
      queueProcessingRun,
    })
  })

  test('rejected queued sends are returned to the caller for restoration', async () => {
    const activeQueueProcessingOwnerRef = { current: null as symbol | null }
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }
    const message = { content: 'do not lose me', attachments: [] }
    const restored: QueuedMessage[] = []

    runQueuedMessage({
      messageToProcess: message,
      sendMessage: () => Promise.reject(new Error('not ready')),
      onRejected: (rejectedMessage) => restored.push(rejectedMessage),
      isProcessingQueueRef,
      isQueuePausedRef,
      queueProcessingOwnerRef: activeQueueProcessingOwnerRef,
      setCanProcessQueue: () => {},
    })

    await flushPromises()

    expect(restored).toEqual([message])
    expect(isProcessingQueueRef.current).toBe(false)
  })

  test('a synchronously throwing sendMessage still releases the processing lock', async () => {
    // Reviewer advisory: a sendMessage implementation that throws instead of
    // rejecting returns nothing to attach .catch/.finally to, so the lock
    // would leak and the queue would stay stuck. The message must also be
    // restorable to the caller.
    const activeQueueProcessingOwnerRef = { current: null as symbol | null }
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }
    const message = { content: 'sync throw', attachments: [] }
    const restored: QueuedMessage[] = []

    runQueuedMessage({
      messageToProcess: message,
      sendMessage: () => {
        throw new Error('boom')
      },
      onRejected: (rejectedMessage) => restored.push(rejectedMessage),
      isProcessingQueueRef,
      isQueuePausedRef,
      queueProcessingOwnerRef: activeQueueProcessingOwnerRef,
      setCanProcessQueue: () => {},
    })

    await flushPromises()

    expect(restored).toEqual([message])
    expect(isProcessingQueueRef.current).toBe(false)
    expect(activeQueueProcessingOwnerRef.current).toBeNull()
  })

  test('stale completion cannot clear newer queued-send processing lock', async () => {
    const activeQueueProcessingOwnerRef = { current: null as symbol | null }
    const isProcessingQueueRef = { current: false }
    const isQueuePausedRef = { current: false }
    let canProcessQueue = false
    const runA = createDeferred()
    const runB = createDeferred()

    runQueuedMessage({
      messageToProcess: { content: 'run A', attachments: [] },
      sendMessage: () => runA.promise,
      isProcessingQueueRef,
      isQueuePausedRef,
      queueProcessingOwnerRef: activeQueueProcessingOwnerRef,
      setCanProcessQueue: (can) => {
        canProcessQueue = can
      },
    })

    // Abort cleanup from run A releases the processing lock, allowing run B to
    // start before run A's promise settles.
    isProcessingQueueRef.current = false

    runQueuedMessage({
      messageToProcess: { content: 'run B', attachments: [] },
      sendMessage: () => runB.promise,
      isProcessingQueueRef,
      isQueuePausedRef,
      queueProcessingOwnerRef: activeQueueProcessingOwnerRef,
      setCanProcessQueue: (can) => {
        canProcessQueue = can
      },
    })

    expect(isProcessingQueueRef.current).toBe(true)

    runA.resolve()
    await flushPromises()

    expect(isProcessingQueueRef.current).toBe(true)
    expect(activeQueueProcessingOwnerRef.current).not.toBe(null)
    expect(canProcessQueue).toBe(false)

    runB.resolve()
    await flushPromises()

    expect(isProcessingQueueRef.current).toBe(false)
    expect(activeQueueProcessingOwnerRef.current).toBe(null)
  })
})

describe('createQueueCtrlCHandler', () => {
  const setupHandler = (
    overrides: Partial<Parameters<typeof createQueueCtrlCHandler>[0]> = {},
  ) => {
    const clearQueue = mock(() => [] as QueuedMessage[])
    const resumeQueue = mock(() => {})
    const baseHandleCtrlC = mock(() => true as const)

    const handler = createQueueCtrlCHandler({
      queuePaused: false,
      queuedCount: 0,
      inputHasText: false,
      clearQueue,
      resumeQueue,
      baseHandleCtrlC,
      ...overrides,
    })

    return { handler, clearQueue, resumeQueue, baseHandleCtrlC }
  }

  test('delegates to base handler when input has text even if queue is paused', () => {
    const { handler, clearQueue, resumeQueue, baseHandleCtrlC } = setupHandler({
      queuePaused: true,
      queuedCount: 2,
      inputHasText: true,
    })

    handler()

    expect(clearQueue.mock.calls.length).toBe(0)
    expect(resumeQueue.mock.calls.length).toBe(0)
    expect(baseHandleCtrlC.mock.calls.length).toBe(1)
  })

  test('clears queued items when paused with pending work and input is empty', () => {
    const { handler, clearQueue, resumeQueue, baseHandleCtrlC } = setupHandler({
      queuePaused: true,
      queuedCount: 3,
      inputHasText: false,
    })

    handler()

    expect(clearQueue.mock.calls.length).toBe(1)
    expect(resumeQueue.mock.calls.length).toBe(1)
    expect(baseHandleCtrlC.mock.calls.length).toBe(0)
  })

  test('delegates when there are no queued items to cancel', () => {
    const { handler, clearQueue, resumeQueue, baseHandleCtrlC } = setupHandler({
      queuePaused: true,
      queuedCount: 0,
    })

    handler()

    expect(clearQueue.mock.calls.length).toBe(0)
    expect(resumeQueue.mock.calls.length).toBe(0)
    expect(baseHandleCtrlC.mock.calls.length).toBe(1)
  })
})
