import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { MessageWithAgents } from './message-with-agents'
import { useViewportWindow } from '../hooks/use-viewport-window'
import { captureNativeReadingAnchor, nativeReadingAnchorDelta, type NativeReadingAnchor } from '../utils/native-reading-anchor'

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
  /** Measured chrome including the previous-message control. */
  headerRef?: React.RefObject<BoxRenderable | null>
  scrollTarget?: { messageId: string; token: number } | null
  scrollIntentRef?: React.RefObject<number>
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
 * geometry it starts with an estimated window at the newest messages.
 */
export const MessageListWindow = memo(
  ({
    messages,
    scrollRef,
    availableWidth,
    hasLoadPrevious,
    headerRef,
    scrollTarget,
    scrollIntentRef,
    adjustScrollTop,
    isAtBottomNow,
    scrollToLatest,
  }: MessageListWindowProps) => {
    const previousWidth = useRef(availableWidth)
    const lastAnchor = useRef<NativeReadingAnchor | null>(null)
    const resizeAnchor = useRef<{ anchor: NativeReadingAnchor; intent: number } | null>(null)
    const [, refreshAnchor] = useState(0)
    if (previousWidth.current !== availableWidth) {
      previousWidth.current = availableWidth
      if (!isAtBottomNow()) {
        const box = scrollRef.current
        const anchor = lastAnchor.current ?? (box ? captureNativeReadingAnchor(box.content, box.viewport.y, box.viewport.height) : null)
        if (anchor) resizeAnchor.current = { anchor, intent: scrollIntentRef?.current ?? 0 }
      }
    }
    const [headerHeight, setHeaderHeight] = useState(0)
    useLayoutEffect(() => {
      const node = headerRef?.current
      if (!node) return
      const capture = () => setHeaderHeight(node.height)
      capture()
      node.onSizeChange = capture
      return () => {
        if (node.onSizeChange === capture) node.onSizeChange = undefined
      }
    }, [headerRef])
    const {
      startIndex,
      endIndex,
      topSpacerHeight,
      bottomSpacerHeight,
      registerMeasurement,
      messageOffsets,
    } = useViewportWindow({
      scrollRef,
      messages,
      availableWidth,
      headerHeight: headerRef ? headerHeight : 1,
      hasLoadPrevious: headerRef ? false : hasLoadPrevious,
      adjustScrollTop,
      isAtBottomNow,
      scrollToLatest,
      retainedAnchor: resizeAnchor.current?.anchor,
    })
    useLayoutEffect(() => {
      const box = scrollRef.current
      if (!box) return
      const capture = () => {
        if (resizeAnchor.current) return
        lastAnchor.current = captureNativeReadingAnchor(box.content, box.viewport.y, box.viewport.height)
      }
      const timer = setTimeout(capture, 0)
      box.verticalScrollBar.on('change', capture)
      return () => { clearTimeout(timer); box.verticalScrollBar.off('change', capture) }
    })
    useLayoutEffect(() => {
      const saved = resizeAnchor.current
      const box = scrollRef.current
      if (!saved || !box) return
      let timer: ReturnType<typeof setTimeout> | undefined
      let passes = 0
      const restore = () => {
        if (scrollRef.current !== box || resizeAnchor.current !== saved) return
        if ((scrollIntentRef?.current ?? 0) !== saved.intent) {
          resizeAnchor.current = null
          refreshAnchor((value) => value + 1)
          return
        }
        const delta = nativeReadingAnchorDelta(saved.anchor, box.viewport.y)
        if (delta !== null && Math.abs(delta) > 0.5) adjustScrollTop(delta, { follow: false })
        if (++passes < 3) timer = setTimeout(restore, 32)
        else {
          resizeAnchor.current = null
          refreshAnchor((value) => value + 1)
        }
      }
      timer = setTimeout(restore, 16)
      return () => { if (timer) clearTimeout(timer) }
    }, [availableWidth, scrollRef, adjustScrollTop, scrollIntentRef])

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
    const mountedMessagesRef = useRef(new Map<string, BoxRenderable>())
    const getMeasurementRef = useCallback(
      (id: string): ((node: BoxRenderable | null) => void) => {
        let refCallback = measurementRefsRef.current.get(id)
        if (!refCallback) {
          refCallback = (node: BoxRenderable | null) => {
            if (node) mountedMessagesRef.current.set(id, node)
            else mountedMessagesRef.current.delete(id)
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
    const messageOffsetsRef = useRef(messageOffsets)
    messageOffsetsRef.current = messageOffsets
    useLayoutEffect(() => {
      if (!scrollTarget) return
      resizeAnchor.current = null
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      let expectedPosition = scrollbox.verticalScrollBar.scrollPosition
      let pass = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const jump = () => {
        if (scrollRef.current !== scrollbox) return
        const current = scrollbox.verticalScrollBar.scrollPosition
        // A new scroll intent supersedes a deferred navigation correction.
        if (pass > 0 && Math.abs(current - expectedPosition) > 1) return
        const node = mountedMessagesRef.current.get(scrollTarget.messageId)
        const destination = node
          ? node.y - scrollbox.content.y
          : messageOffsetsRef.current.get(scrollTarget.messageId)
        if (destination === undefined) return
        adjustScrollTop(destination - current, { follow: false })
        expectedPosition = scrollbox.verticalScrollBar.scrollPosition
        if (++pass < 3) timer = setTimeout(jump, 32)
      }
      jump()
      return () => { if (timer) clearTimeout(timer) }
    }, [scrollTarget, scrollRef, adjustScrollTop])

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
          id={`transcript-message-${message.id}`}
              style={{ flexShrink: 0, width: '100%' }}
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
