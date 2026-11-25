import { useCallback } from 'react'

import type { QueuedMessage } from './use-message-queue'

interface UseQueueControlsParams {
  queuePaused: boolean
  /** Live pause state for same-input-batch interrupt/submit ordering. */
  isQueuePausedRef?: { current: boolean }
  queuedCount: number
  clearQueue: () => QueuedMessage[]
  resumeQueue: () => void
  inputHasText: boolean
  baseHandleCtrlC: () => true
}

type QueueCtrlCHandlerOptions = UseQueueControlsParams

export const createQueueCtrlCHandler =
  ({
    queuePaused,
    queuedCount,
    clearQueue,
    resumeQueue,
    inputHasText,
    baseHandleCtrlC,
  }: QueueCtrlCHandlerOptions) =>
  () => {
    if (queuePaused && queuedCount > 0 && !inputHasText) {
      clearQueue()
      resumeQueue()
      return true
    }
    return baseHandleCtrlC()
  }

export const useQueueControls = ({
  queuePaused,
  isQueuePausedRef,
  queuedCount,
  clearQueue,
  resumeQueue,
  inputHasText,
  baseHandleCtrlC,
}: UseQueueControlsParams) => {
  const handleCtrlC = useCallback(
    createQueueCtrlCHandler({
      queuePaused,
      queuedCount,
      clearQueue,
      resumeQueue,
      inputHasText,
      baseHandleCtrlC,
    }),
    [
      baseHandleCtrlC,
      clearQueue,
      inputHasText,
      queuePaused,
      queuedCount,
      resumeQueue,
    ],
  )

  const ensureQueueActiveBeforeSubmit = useCallback(() => {
    if (isQueuePausedRef?.current ?? queuePaused) {
      resumeQueue()
      return true
    }
    return false
  }, [isQueuePausedRef, queuePaused, resumeQueue])

  return { handleCtrlC, ensureQueueActiveBeforeSubmit }
}
