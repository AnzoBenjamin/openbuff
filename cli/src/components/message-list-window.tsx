import { memo, useCallback, useEffect, useMemo, useRef } from 'react'

import { MessageWithAgents } from './message-with-agents'
import { useViewportWindow } from '../hooks/use-viewport-window'

import type { ChatMessage } from '../types/chat'
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'

interface MessageListWindowProps {
  /** Paginated/collapsed top-level messages, in render order. */
  messages: ChatMessage[]
  /** Ref to the chat scrollbox the window is computed against. */
  scrollRef: React.RefObject<ScrollBoxRenderable | null>
  /** Width available to message content (drives wrap estimation). */
  availableWidth: number
  /** Whether the LoadPreviousButton row is rendered above the list. */
  hasLoadPrevious: boolean
  /** Compensating scroll writer for above-viewport height changes. */
  adjustScrollTop: (delta: number, opts?: { follow?: boolean }) => void
  /** Imperative at-bottom probe (drives width-change re-pinning). */
  isAtBottomNow: () => boolean
  /** Re-pin to the bottom after a width change when at bottom. */
  scrollToLatest: () => void
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
    adjustScrollTop,
    isAtBottomNow,
    scrollToLatest,
  }: MessageListWindowProps) => {
    const {
      startIndex,
      endIndex,
      topSpacerHeight,
      bottomSpacerHeight,
      registerMeasurement,
    } = useViewportWindow({
      scrollRef,
      messages,
      availableWidth,
      headerHeight: 1,
      hasLoadPrevious,
      adjustScrollTop,
      isAtBottomNow,
      scrollToLatest,
    })

    // Stable per-message ref callbacks for the measurement wrappers. An
    // inline arrow inside the map gets a new identity on every render, so
    // React detaches (null) and re-attaches (node) every wrapper's ref on
    // each parent render — under streaming that churn re-runs the
    // measurement attach path on a re-render cadence and (in the hook's
    // registerMeasurement) resets the bounded zero-height retry budget, so
    // the 'bounded' retry chain never exhausts. Cache one callback per
    // message id; the cached closure reads only the latest
    // registerMeasurement through a ref so its identity never goes stale
    // (the capture itself reads the live width at capture time — see
    // createMeasurementCapture — so re-measures after a terminal width
    // change are tagged with the new width even though the ref callback is
    // never re-created), and entries are pruned for messages that leave the
    // list.
    const registerMeasurementRef = useRef(registerMeasurement)
    registerMeasurementRef.current = registerMeasurement
    const measurementRefsRef = useRef(
      new Map<string, (node: BoxRenderable | null) => void>(),
    )
    const getMeasurementRef = useCallback(
      (id: string): ((node: BoxRenderable | null) => void) => {
        let refCallback = measurementRefsRef.current.get(id)
        if (!refCallback) {
          refCallback = (node: BoxRenderable | null) => {
            registerMeasurementRef.current(id, node)
          }
          measurementRefsRef.current.set(id, refCallback)
        }
        return refCallback
      },
      [],
    )
    useEffect(() => {
      const liveIds = new Set(messages.map((message) => message.id))
      for (const id of measurementRefsRef.current.keys()) {
        if (!liveIds.has(id)) measurementRefsRef.current.delete(id)
      }
    }, [messages])

    const windowedMessages = useMemo(
      () => messages.slice(startIndex, endIndex + 1),
      [messages, startIndex, endIndex],
    )

    return (
      <>
        {/* Spacer preserving the scroll height of the windowed-out messages
            above the viewport (relative to the content area; the fixed header
            is already excluded by the hook). */}
        {topSpacerHeight > 0 && (
          <box style={{ height: topSpacerHeight, flexShrink: 0 }} />
        )}
        {windowedMessages.map((message, windowedIdx) => {
          const absoluteIdx = startIndex + windowedIdx
          const isLast = absoluteIdx === messages.length - 1
          return (
            // Measurable host wrapper: captures the message's real rendered
            // height (and re-measures on resize) so off-screen spacers use
            // real heights instead of estimates. flexShrink: 0 keeps the
            // wrapper at its natural height inside the column scrollbox.
            <box
              key={message.id}
              style={{ flexShrink: 0 }}
              ref={getMeasurementRef(message.id)}
            >
              <MessageWithAgents
                message={message}
                depth={0}
                isLastMessage={isLast}
                availableWidth={availableWidth}
              />
            </box>
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
