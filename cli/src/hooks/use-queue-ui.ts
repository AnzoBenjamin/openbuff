import { pluralize } from '@codebuff/common/util/string'
import { useMemo } from 'react'

import { formatQueuedPreview } from '../utils/helpers'

import type { QueuedMessage } from './use-message-queue'

interface UseQueueUiParams {
  queuePaused: boolean
  queuedMessages: QueuedMessage[]
  queueRemovalCount: number
  separatorWidth: number
  terminalWidth: number
}

export const useQueueUi = ({
  queuePaused,
  queuedMessages,
  queueRemovalCount,
  separatorWidth,
  terminalWidth,
}: UseQueueUiParams) => {
  const queuedCount = queuedMessages.length
  const shouldShowQueuePreview = queuedCount > 0 && !queuePaused

  const queuePreviewTitle = useMemo(() => {
    if (!shouldShowQueuePreview) return undefined
    const previewWidth = Math.max(30, separatorWidth - 20)
    return formatQueuedPreview(queuedMessages, previewWidth)
  }, [shouldShowQueuePreview, queuedMessages, separatorWidth])

  const pausedQueueText = useMemo(() => {
    if (queuedCount === 0 && queueRemovalCount > 0) {
      return `${pluralize(queueRemovalCount, 'prompt')} removed · Ctrl+P → Work queue → U to undo`
    }
    if (!queuePaused || queuedCount === 0) return undefined
    return `${queuedCount} queued · Paused · next input sends first`
  }, [queuePaused, queuedCount, queueRemovalCount])

  const inputPlaceholder = useMemo(() => {
    const base =
      terminalWidth < 65
        ? 'Enter a coding task'
        : 'Enter a coding task or / for commands'

    if (queuePaused && queuedCount > 0) {
      return 'Ctrl-C clears queue · Ctrl+P → Work queue to undo'
    }

    return base
  }, [queuePaused, queuedCount, terminalWidth])

  return {
    queuedCount,
    shouldShowQueuePreview,
    queuePreviewTitle,
    pausedQueueText,
    inputPlaceholder,
  }
}
