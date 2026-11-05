import { TextAttributes } from '@opentui/core'
import React, { useCallback, useMemo } from 'react'

import { CopyButton } from './copy-button'
import { ElapsedTimer } from './elapsed-timer'
import { FeedbackIconButton } from './feedback-icon-button'
import { useTheme } from '../hooks/use-theme'
import {
  useFeedbackStore,
  selectIsFeedbackOpenForMessage,
  selectHasSubmittedFeedback,
  selectMessageFeedbackCategory,
} from '../state/feedback-store'

import type { ContentBlock } from '../types/chat'

interface MessageFooterProps {
  messageId: string
  blocks?: ContentBlock[]
  content: string
  isLoading: boolean
  isComplete?: boolean
  completionTime?: string
  credits?: number
  cacheHitRate?: number
  timerStartTime: number | null
  onFeedback?: (messageId: string) => void
  onCloseFeedback?: () => void
  feedbackAvailable?: boolean
  copy?: React.ComponentProps<typeof CopyButton>['copy']
  copyScope?: 'answer' | 'text'
}

export const MessageFooter: React.FC<MessageFooterProps> = ({
  messageId,
  blocks,
  content,
  isLoading,
  isComplete,
  completionTime,
  credits,
  cacheHitRate,
  timerStartTime,
  onFeedback,
  onCloseFeedback,
  feedbackAvailable = false,
  copy,
  copyScope = 'answer',
}) => {
  const theme = useTheme()

  // Memoize selectors to prevent new function references on every render
  const selectIsFeedbackOpenMemo = useMemo(
    () => selectIsFeedbackOpenForMessage(messageId),
    [messageId],
  )
  const selectHasSubmittedFeedbackMemo = useMemo(
    () => selectHasSubmittedFeedback(messageId),
    [messageId],
  )
  const selectMessageFeedbackCategoryMemo = useMemo(
    () => selectMessageFeedbackCategory(messageId),
    [messageId],
  )

  const isFeedbackOpen = useFeedbackStore(selectIsFeedbackOpenMemo)
  const hasSubmittedFeedback = useFeedbackStore(selectHasSubmittedFeedbackMemo)
  const selectedFeedbackCategory = useFeedbackStore(
    selectMessageFeedbackCategoryMemo,
  )

  const shouldShowLoadingTimer = isLoading && !isComplete
  const shouldShowCompletionFooter = isComplete
  const canRequestFeedback =
    feedbackAvailable && shouldShowCompletionFooter && !hasSubmittedFeedback
  const isGoodOrBadSelection =
    selectedFeedbackCategory === 'good_result' ||
    selectedFeedbackCategory === 'bad_result'
  const shouldShowSubmittedFeedbackState =
    shouldShowCompletionFooter && hasSubmittedFeedback && isGoodOrBadSelection
  const shouldRenderFeedbackButton =
    feedbackAvailable &&
    Boolean(onFeedback) &&
    (canRequestFeedback || shouldShowSubmittedFeedbackState)

  const handleFeedbackOpen = useCallback(() => {
    if (!canRequestFeedback || !onFeedback) return
    onFeedback(messageId)
  }, [canRequestFeedback, onFeedback, messageId])

  const handleFeedbackClose = useCallback(() => {
    if (!canRequestFeedback) return
    onCloseFeedback?.()
  }, [canRequestFeedback, onCloseFeedback])

  // Only metadata is inspected while rendering. Payload bytes are assembled lazily and cached per source revision.
  const textToCopy = useMemo(() => {
    let cached: string | undefined
    return () => {
      if (cached === undefined) cached = getAnswerCopyText(content, blocks)
      return cached
    }
  }, [content, blocks])
  const hasTextBlocks =
    blocks?.some(
      (block) => block.type === 'text' && block.textType !== 'reasoning',
    ) ?? false
  const hasReasoning =
    blocks?.some(
      (block) => block.type === 'text' && block.textType === 'reasoning',
    ) ?? false
  const hasCopySource = hasTextBlocks || (!hasReasoning && content.length > 0)

  const footerItems: { key: string; node: React.ReactNode }[] = []

  // Add copy button first if there's content to copy
  if (hasCopySource) {
    footerItems.push({
      key: 'copy',
      node: (
        <CopyButton
          textToCopy={textToCopy}
          copy={copy}
          label={
            copyScope === 'text'
              ? 'Copy text'
              : shouldShowLoadingTimer || !isComplete
                ? 'Copy partial answer'
                : 'Copy answer'
          }
          leadingSpace={false}
          style={{ wrapMode: 'none' }}
        />
      ),
    })
  }

  if (shouldShowLoadingTimer) {
    footerItems.push({
      key: 'loading-time',
      node: (
        <text attributes={TextAttributes.DIM} wrapMode="none">
          <ElapsedTimer
            startTime={timerStartTime}
            attributes={TextAttributes.DIM}
          />
        </text>
      ),
    })
  }

  if (isComplete && completionTime) {
    footerItems.push({
      key: 'time',
      node: (
        <text
          attributes={TextAttributes.DIM}
          style={{
            wrapMode: 'none',
            fg: theme.secondary,
            marginTop: 0,
            marginBottom: 0,
          }}
        >
          {completionTime}
        </text>
      ),
    })
  }
  if (isComplete && typeof credits === 'number' && credits > 0) {
    footerItems.push({
      key: 'cost',
      node: <CostIndicator cost={credits} />,
    })
  }
  if (isComplete && typeof cacheHitRate === 'number' && cacheHitRate > 0) {
    footerItems.push({
      key: 'cache',
      node: <CacheHitRateIndicator rate={cacheHitRate} />,
    })
  }
  if (shouldRenderFeedbackButton) {
    footerItems.push({
      key: 'feedback',
      node: (
        <FeedbackIconButton
          onClick={handleFeedbackOpen}
          onClose={handleFeedbackClose}
          isOpen={canRequestFeedback ? isFeedbackOpen : false}
          messageId={messageId}
          selectedCategory={selectedFeedbackCategory}
          hasSubmittedFeedback={hasSubmittedFeedback}
        />
      ),
    })
  }

  if (footerItems.length === 0) {
    return null
  }

  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-end',
        gap: 1,
        flexWrap: 'wrap',
      }}
    >
      {footerItems.map((item, idx) => (
        <React.Fragment key={item.key}>
          {idx > 0 && (
            <text
              attributes={TextAttributes.DIM}
              style={{
                wrapMode: 'none',
                fg: theme.muted,
                marginTop: 0,
                marginBottom: 0,
              }}
            >
              •
            </text>
          )}
          {item.node}
        </React.Fragment>
      ))}
    </box>
  )
}

export function getAnswerCopyText(
  content: string,
  blocks?: ContentBlock[],
): string {
  const text = (blocks ?? [])
    .filter((block) => block.type === 'text' && block.textType !== 'reasoning')
    .map((block) => (block.type === 'text' ? block.content : ''))
  if (text.length) return text.join('\n\n')
  if (
    blocks?.some(
      (block) => block.type === 'text' && block.textType === 'reasoning',
    )
  )
    return ''
  return content
}

const CostIndicator: React.FC<{ cost: number }> = ({ cost }) => {
  const theme = useTheme()
  const dollars = cost / 100
  const formatted = dollars < 0.01 ? dollars.toFixed(4) : dollars.toFixed(2)

  return (
    <text
      attributes={TextAttributes.DIM}
      style={{
        wrapMode: 'none',
        fg: theme.secondary,
        marginTop: 0,
        marginBottom: 0,
      }}
    >
      {`cost $${formatted}`}
    </text>
  )
}

const CacheHitRateIndicator: React.FC<{ rate: number }> = ({ rate }) => {
  const theme = useTheme()
  const pct = Math.round(rate * 100)

  return (
    <text
      attributes={TextAttributes.DIM}
      style={{
        wrapMode: 'none',
        fg: theme.secondary,
        marginTop: 0,
        marginBottom: 0,
      }}
    >
      {`cache ${pct}%`}
    </text>
  )
}
