import { memo, useMemo } from 'react'

import { MessageWithAgents } from './message-with-agents'
import { useViewportWindow } from '../hooks/use-viewport-window'

import type { ChatMessage } from '../types/chat'
import type { ScrollBoxRenderable } from '@opentui/core'

interface MessageListWindowProps {
  /** Paginated/collapsed top-level messages, in render order. */
  messages: ChatMessage[]
  /** Ref to the chat scrollbox the window is computed against. */
  scrollRef: React.RefObject<ScrollBoxRenderable | null>
  /** Width available to message content (drives wrap estimation). */
  availableWidth: number
  /** Whether the LoadPreviousButton row is rendered above the list. */
  hasLoadPrevious: boolean
}

/**
 * Viewport-windowed chat message list (P1-T10).
 *
 * Only the messages intersecting the current scroll viewport (plus a small
 * overscan) mount real MessageWithAgents components; off-screen messages are
 * replaced by fixed-height spacer boxes that preserve total scroll height and
 * scroll position. Windowed items keep their message-id keys so per-message
 * state survives the window moving as the user scrolls.
 *
 * This component owns the scroll-state subscription, so scroll-triggered
 * re-renders are confined to this subtree (whose children are memoized and
 * bail out when their message object is unchanged) instead of re-rendering the
 * whole chat screen on every scroll frame. Before the scrollbox reports real
 * geometry (or in environments without one) it renders the full list, exactly
 * like the non-virtualized baseline.
 */
export const MessageListWindow = memo(
  ({
    messages,
    scrollRef,
    availableWidth,
    hasLoadPrevious,
  }: MessageListWindowProps) => {
    const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } =
      useViewportWindow({
        scrollRef,
        messages,
        availableWidth,
        headerHeight: 1,
        hasLoadPrevious,
      })

    const windowedMessages = useMemo(
      () => messages.slice(startIndex, endIndex + 1),
      [messages, startIndex, endIndex],
    )

    return (
      <>
        {/* Spacer preserving the scroll height of the windowed-out messages
            above the viewport. */}
        {topSpacerHeight > 0 && (
          <box style={{ height: topSpacerHeight, flexShrink: 0 }} />
        )}
        {windowedMessages.map((message, windowedIdx) => {
          const absoluteIdx = startIndex + windowedIdx
          const isLast = absoluteIdx === messages.length - 1
          return (
            <MessageWithAgents
              key={message.id}
              message={message}
              depth={0}
              isLastMessage={isLast}
              availableWidth={availableWidth}
            />
          )
        })}
        {/* Spacer preserving the scroll height of the windowed-out messages
            below the viewport. */}
        {bottomSpacerHeight > 0 && (
          <box style={{ height: bottomSpacerHeight, flexShrink: 0 }} />
        )}
      </>
    )
  },
)
