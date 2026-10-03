/**
 * Viewport windowing for the chat message list.
 *
 * Renders only the message blocks intersecting the current scroll viewport
 * (plus a small overscan) so a very long session does not mount thousands of
 * block components. Off-screen messages are replaced by fixed-height spacer
 * boxes that preserve total scroll height and scroll position.
 *
 * Heights are estimated (text-wrap based, cached per message) and calibrated
 * against the scrollbox's real rendered height once it mounts, which snaps the
 * per-message estimates toward reality and keeps the window from jumping.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import stringWidth from 'string-width'

import type { ChatMessage } from '../types/chat'
import type { ScrollBoxRenderable } from '@opentui/core'

/** Extra messages rendered above and below the viewport window. */
export const VIEWPORT_OVERSCAN = 4

/** Poll interval while waiting for the scrollbox to mount / re-mount. */
const MOUNT_POLL_INTERVAL_MS = 50
const REMOUNT_POLL_INTERVAL_MS = 500

/** Fallback viewport height when the scrollbox has not reported one yet. */
const DEFAULT_VIEWPORT_HEIGHT = 24

/** Per-variant base heights (chrome around the content, in terminal rows). */
const USER_BASE_HEIGHT = 2 // timestamp row + bottom padding
const AI_BASE_HEIGHT = 2 // footer row + bottom padding
const AGENT_BASE_HEIGHT = 2 // title row + bottom padding
const COLLAPSED_AGENT_HEIGHT = 2 // title row + preview line
const MODE_DIVIDER_HEIGHT = 1
const MIN_MESSAGE_HEIGHT = 1
const MAX_MESSAGE_HEIGHT = 400

/** Rough per-block fixed heights for non-text blocks. */
const TOOL_BLOCK_HEIGHT = 3
const AGENT_BLOCK_HEIGHT = 4
const IMAGE_BLOCK_HEIGHT = 6
const OTHER_BLOCK_HEIGHT = 2

/** A length signature bucket (256-char granularity) for cache invalidation. */
const contentLengthBucket = (content: string): number =>
  Math.floor(content.length / 256)

/** Cache key: identity + variant + a coarse content-length signature. */
const heightCacheKey = (message: ChatMessage): string => {
  const contentLen = message.content?.length ?? 0
  const blocksLen = message.blocks
    ? message.blocks.reduce(
        (acc, b) => acc + ((b as { content?: string }).content?.length ?? 0),
        0,
      )
    : 0
  return `${message.id}:${message.variant}:${contentLengthBucket(
    message.content ?? '',
  )}:${contentLen + blocksLen}`
}

/** Estimate wrapped visual lines for a single text segment. */
const estimateTextLines = (text: string, cols: number): number => {
  if (!text) return 1
  const safeCols = Math.max(8, cols)
  let lines = 0
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines += 1
      continue
    }
    const width = stringWidth(rawLine)
    lines += Math.max(1, Math.ceil(width / safeCols))
  }
  return Math.max(1, lines)
}

/**
 * Estimate the rendered height (in terminal rows) of a single message.
 *
 * This is intentionally approximate — it only needs to be stable and
 * reasonably close so the window and spacers track reality. The calibration
 * effect snaps the cache toward the real measured height once mounted.
 */
export const estimateMessageHeight = (
  message: ChatMessage,
  availableWidth: number,
): number => {
  const contentWidth = Math.max(8, availableWidth - 4)

  if (message.variant === 'agent') {
    const isCollapsed = message.metadata?.isCollapsed ?? false
    if (isCollapsed) return COLLAPSED_AGENT_HEIGHT
    const contentLines = estimateTextLines(message.content ?? '', contentWidth)
    return Math.min(
      MAX_MESSAGE_HEIGHT,
      Math.max(MIN_MESSAGE_HEIGHT, AGENT_BASE_HEIGHT + contentLines),
    )
  }

  if (
    message.blocks &&
    message.blocks.length === 1 &&
    message.blocks[0].type === 'mode-divider'
  ) {
    return MODE_DIVIDER_HEIGHT
  }

  if (message.variant === 'user') {
    const contentLines = estimateTextLines(message.content ?? '', contentWidth)
    const attachmentRows =
      (message.attachments?.length ?? 0) > 0 ||
      (message.textAttachments?.length ?? 0) > 0 ||
      (message.fileAttachments?.length ?? 0) > 0
        ? 2
        : 0
    return Math.min(
      MAX_MESSAGE_HEIGHT,
      Math.max(
        MIN_MESSAGE_HEIGHT,
        USER_BASE_HEIGHT + contentLines + attachmentRows,
      ),
    )
  }

  // AI / error and other variants: sum block estimates, fall back to content.
  let bodyHeight: number
  if (message.blocks && message.blocks.length > 0) {
    let sum = 0
    for (const block of message.blocks) {
      switch (block.type) {
        case 'text':
          sum += estimateTextLines(
            (block as { content?: string }).content ?? '',
            contentWidth,
          )
          break
        case 'tool':
          sum += TOOL_BLOCK_HEIGHT
          break
        case 'agent':
        case 'agent-list':
          sum += AGENT_BLOCK_HEIGHT
          break
        case 'image':
          sum += IMAGE_BLOCK_HEIGHT
          break
        default: {
          const blockContent = (block as { content?: string }).content
          sum += blockContent
            ? estimateTextLines(blockContent, contentWidth)
            : OTHER_BLOCK_HEIGHT
          break
        }
      }
    }
    bodyHeight = sum
  } else {
    bodyHeight = estimateTextLines(message.content ?? '', contentWidth)
  }

  return Math.min(
    MAX_MESSAGE_HEIGHT,
    Math.max(MIN_MESSAGE_HEIGHT, AI_BASE_HEIGHT + bodyHeight),
  )
}

export interface ViewportWindowOptions {
  /** Ref to the scrollbox whose viewport we window against. */
  scrollRef: React.RefObject<ScrollBoxRenderable | null>
  /** The paginated/collapsed visible top-level messages (in render order). */
  messages: ChatMessage[]
  /** Width available to message content (drives wrap estimation). */
  availableWidth: number
  /** Height in rows of the fixed header above the message list. */
  headerHeight: number
  /** Whether the "load previous messages" button row is rendered. */
  hasLoadPrevious: boolean
  /** Rows of trailing ghost (pending bash) content after the last message. */
  trailingHeight?: number
  /** Overscan in messages above/below the window. */
  overscan?: number
  /** Explicit viewport height override (used by tests). */
  viewportHeightOverride?: number
  /** Explicit scroll offset override (used by tests). */
  scrollTopOverride?: number
}

export interface ViewportWindow {
  startIndex: number
  endIndex: number
  topSpacerHeight: number
  bottomSpacerHeight: number
  viewportHeight: number
  scrollTop: number
}

/**
 * Compute the [startIndex, endIndex] window of messages intersecting
 * [scrollTop - overscanPx, scrollTop + viewportHeight + overscanPx] given
 * prefix offsets, plus the spacer heights that replace off-screen rows.
 *
 * Exported for direct unit testing.
 */
export const computeWindow = (params: {
  offsets: number[]
  heights: number[]
  totalHeight: number
  scrollTop: number
  viewportHeight: number
  overscanPx: number
}): {
  startIndex: number
  endIndex: number
  topSpacerHeight: number
  bottomSpacerHeight: number
} => {
  const { offsets, heights, totalHeight, scrollTop, viewportHeight, overscanPx } =
    params
  const count = heights.length
  if (count === 0) {
    return {
      startIndex: 0,
      endIndex: -1,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    }
  }

  const windowStart = Math.max(0, scrollTop - overscanPx)
  const windowEnd = scrollTop + viewportHeight + overscanPx

  let startIndex = 0
  while (
    startIndex < count - 1 &&
    offsets[startIndex] + heights[startIndex] <= windowStart
  ) {
    startIndex++
  }

  let endIndex = startIndex
  while (endIndex < count - 1 && offsets[endIndex] < windowEnd) {
    endIndex++
  }
  // Include the message that starts before windowEnd even if it extends past.
  if (offsets[endIndex] >= windowEnd && endIndex > startIndex) {
    endIndex--
  }

  const topSpacerHeight = offsets[startIndex]
  const lastVisibleBottom = offsets[endIndex] + heights[endIndex]
  const bottomSpacerHeight = Math.max(0, totalHeight - lastVisibleBottom)

  return { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight }
}

/**
 * Viewport-windowed virtualization over the chat message list.
 *
 * Tracks the scrollbox scroll offset + viewport height, estimates per-message
 * heights (cached and calibrated against the real rendered scroll height), and
 * returns the visible window plus spacer heights.
 */
export const useViewportWindow = ({
  scrollRef,
  messages,
  availableWidth,
  headerHeight,
  hasLoadPrevious,
  trailingHeight = 0,
  overscan = VIEWPORT_OVERSCAN,
  viewportHeightOverride,
  scrollTopOverride,
}: ViewportWindowOptions): ViewportWindow => {
  const [scrollState, setScrollState] = useState<{
    scrollTop: number
    viewportHeight: number
    measured: boolean
  }>({ scrollTop: 0, viewportHeight: DEFAULT_VIEWPORT_HEIGHT, measured: false })

  // Subscribe to scroll + viewport changes, mirroring use-scroll-management's
  // mount-poll pattern so we track whichever scrollbox instance is live.
  useEffect(() => {
    if (
      viewportHeightOverride !== undefined ||
      scrollTopOverride !== undefined
    ) {
      return
    }

    let handleChange: (() => void) | null = null
    let subscribedBox: ScrollBoxRenderable | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const readState = (scrollbox: ScrollBoxRenderable) => {
      const maxScroll = Math.max(
        0,
        scrollbox.scrollHeight - scrollbox.viewport.height,
      )
      const scrollTop = Math.min(
        Math.max(0, scrollbox.verticalScrollBar.scrollPosition),
        maxScroll,
      )
      const viewportHeight = Math.max(
        1,
        Math.floor(scrollbox.viewport.height),
      )
      setScrollState((prev) =>
        prev.scrollTop === scrollTop &&
        prev.viewportHeight === viewportHeight &&
        prev.measured
          ? prev
          : { scrollTop, viewportHeight, measured: true },
      )
    }

    const unsubscribe = () => {
      if (subscribedBox && handleChange) {
        subscribedBox.verticalScrollBar.off('change', handleChange)
      }
      subscribedBox = null
      handleChange = null
    }

    const subscribe = (scrollbox: ScrollBoxRenderable) => {
      if (scrollbox === subscribedBox) {
        readState(scrollbox)
        return
      }
      unsubscribe()
      handleChange = () => readState(scrollbox)
      subscribedBox = scrollbox
      scrollbox.verticalScrollBar.on('change', handleChange)
      readState(scrollbox)
    }

    const poll = (): void => {
      if (cancelled) return
      const current = scrollRef.current
      if (current) {
        subscribe(current)
      } else {
        unsubscribe()
      }
      pollTimer = setTimeout(
        poll,
        subscribedBox ? REMOUNT_POLL_INTERVAL_MS : MOUNT_POLL_INTERVAL_MS,
      )
    }
    poll()

    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      unsubscribe()
    }
  }, [scrollRef, viewportHeightOverride, scrollTopOverride])

  const viewportHeight =
    viewportHeightOverride ?? scrollState.viewportHeight
  const scrollTop = scrollTopOverride ?? scrollState.scrollTop
  // Windowing only engages once the scrollbox has reported a real measurement.
  // Before that (and in environments with no live scrollbox, e.g. unit tests),
  // the full list renders exactly as it did pre-virtualization.
  const measured =
    viewportHeightOverride !== undefined ||
    scrollTopOverride !== undefined ||
    scrollState.measured

  // Estimate heights, cached by id+signature so streaming updates recompute.
  const heightCacheRef = useRef<Map<string, number>>(new Map())
  const heights = useMemo(() => {
    const cache = heightCacheRef.current
    return messages.map((message) => {
      const key = heightCacheKey(message)
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const estimate = estimateMessageHeight(message, availableWidth)
      cache.set(key, estimate)
      return estimate
    })
  }, [messages, availableWidth])

  const messageListHeight = useMemo(
    () => heights.reduce((acc, h) => acc + h, 0),
    [heights],
  )
  const fixedTopHeight = headerHeight + (hasLoadPrevious ? 1 : 0)
  const totalHeight = fixedTopHeight + messageListHeight + trailingHeight

  // Calibrate estimates against the scrollbox's real rendered scroll height.
  // The scrollbox measures actual layout, so when our estimate-driven total
  // diverges from reality we scale the cache toward it. This collapses the
  // per-message error and prevents scroll drift/jump as the user scrolls.
  useEffect(() => {
    if (
      viewportHeightOverride !== undefined ||
      scrollTopOverride !== undefined
    ) {
      return
    }
    const scrollbox = scrollRef.current
    if (!scrollbox) return
    const realScrollHeight = scrollbox.scrollHeight
    if (!Number.isFinite(realScrollHeight) || realScrollHeight <= 0) return
    const estimatedTotal = fixedTopHeight + messageListHeight + trailingHeight
    if (estimatedTotal <= 0) return

    const error = realScrollHeight - estimatedTotal
    // Only calibrate once the divergence is meaningful (>2 rows).
    if (Math.abs(error) <= 2) return
    if (messageListHeight <= 0) return

    const realMessageHeight = realScrollHeight - fixedTopHeight - trailingHeight
    if (realMessageHeight <= 0) return
    const scale = realMessageHeight / messageListHeight
    if (!Number.isFinite(scale) || scale <= 0) return

    const cache = heightCacheRef.current
    for (let i = 0; i < messages.length; i++) {
      const key = heightCacheKey(messages[i])
      const current = cache.get(key)
      if (current === undefined) continue
      cache.set(
        key,
        Math.min(
          MAX_MESSAGE_HEIGHT,
          Math.max(MIN_MESSAGE_HEIGHT, Math.round(current * scale)),
        ),
      )
    }
  }, [
    scrollRef,
    messages,
    messageListHeight,
    fixedTopHeight,
    trailingHeight,
    viewportHeightOverride,
    scrollTopOverride,
  ])

  // Prefix offsets into the full scroll content (fixed header included).
  const offsets = useMemo(() => {
    const result = new Array<number>(messages.length)
    let acc = fixedTopHeight
    for (let i = 0; i < messages.length; i++) {
      result[i] = acc
      acc += heights[i]
    }
    return result
  }, [messages.length, heights, fixedTopHeight])

  const overscanPx = useMemo(() => {
    if (messages.length === 0) return 0
    const avg = messageListHeight / messages.length
    return Math.max(1, Math.ceil(avg * overscan))
  }, [messages.length, messageListHeight, overscan])

  const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } =
    useMemo(
      () =>
        computeWindow({
          offsets,
          heights,
          totalHeight,
          scrollTop,
          viewportHeight,
          overscanPx,
        }),
      [offsets, heights, totalHeight, scrollTop, viewportHeight, overscanPx],
    )

  // The fixed header occupies [0, fixedTopHeight); spacers must account for it
  // so the windowed messages land at the right absolute scroll offset.
  const topSpacer = Math.max(0, topSpacerHeight - fixedTopHeight)

  if (!measured) {
    // Not yet measured: render the entire list (no spacers) so behavior matches
    // the non-virtualized baseline until the scrollbox reports real geometry.
    return {
      startIndex: 0,
      endIndex: messages.length - 1,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      viewportHeight,
      scrollTop,
    }
  }

  return {
    startIndex,
    endIndex,
    topSpacerHeight: topSpacer,
    bottomSpacerHeight,
    viewportHeight,
    scrollTop,
  }
}
