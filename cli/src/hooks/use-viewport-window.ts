/**
 * Viewport windowing for the chat message list.
 *
 * Renders only the message blocks intersecting the current scroll viewport
 * (plus a small overscan) so a very long session does not mount thousands of
 * block components. Off-screen messages are replaced by fixed-height spacer
 * boxes that preserve total scroll height and scroll position.
 *
 * Heights come from real per-message measurements of the mounted wrapper
 * boxes, tagged with the width at measure time; a wrapper still 0-height at
 * ref-attach is re-captured on a bounded retry chain, and messages with no
 * usable measurement fall back to a width-aware estimate. There is NO
 * multiplicative calibration/rescale: it previously rewrote every spacer
 * height under a live scroll position, which OpenTUI clamped against the new
 * maxScroll and snapped the viewport back.
 *
 * When an above-viewport message's height changes, a compensating scroll is
 * applied through `adjustScrollTop`; the write does NOT rely on OpenTUI
 * committing the child layout in the same pass — use-scroll-management
 * re-verifies the write against settled geometry and re-applies any residual
 * the initial clamp swallowed (see ANCHOR_VERIFY_* there). The same protection
 * covers the animation path (folds are applied unclamped and re-verified at
 * completion) and the width-change re-pin, whose SETTLED-bottom destination
 * (VERIFY_SETTLED_BOTTOM there) re-pins to the new bottom after the re-wrapped
 * layout commits instead of letting a short final tick silently disable
 * auto-follow.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import stringWidth from 'string-width'

import type { ChatMessage } from '../types/chat'
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'

/** Extra messages rendered above and below the viewport window. */
export const VIEWPORT_OVERSCAN = 4

/** Poll interval while waiting for the scrollbox to mount / re-mount. */
const MOUNT_POLL_INTERVAL_MS = 50
const REMOUNT_POLL_INTERVAL_MS = 500

/** Delay between bounded re-captures of a still-unmeasured (height 0) wrapper. */
export const ZERO_HEIGHT_RETRY_DELAY_MS = 32
/** Maximum zero-height re-capture attempts before falling back to the estimate. */
export const ZERO_HEIGHT_MAX_ATTEMPTS = 10

/**
 * Next attempt index for the bounded zero-height re-capture chain (see
 * registerMeasurement), or null once the budget is exhausted and the message
 * falls back to its estimate-based height as before. Exported for direct
 * unit testing.
 */
export const nextZeroHeightAttempt = (attempts: number): number | null => {
  return attempts < ZERO_HEIGHT_MAX_ATTEMPTS ? attempts + 1 : null
}

/**
 * Whether a measurement-ref attach is a genuinely NEW node instance (start a
 * fresh zero-height retry budget) or a re-attach of a node already tracked
 * for the id (keep the accumulated budget): resetting the counter on every
 * re-attach would let frequent re-renders (streaming) re-arm the bounded
 * retry chain indefinitely instead of exhausting it. Exported for direct
 * unit testing.
 */
export const isFreshMeasurementNode = <T>(
  lastSeenNode: T | undefined,
  node: T,
): boolean => lastSeenNode !== node

/** Pending deferred-measurement state owned by useViewportWindow's liveness
 * guard: the zero-height retry timers, their attempt budgets, the detached
 * wrapper nodes awaiting deferred teardown, and the measurements enqueued but
 * not yet flushed into a render. */
export interface ViewportLivenessPendingState {
  retryTimers: Map<string, ReturnType<typeof setTimeout>>
  retryAttempts: Map<string, number>
  detachNodes: Map<string, BoxRenderable>
  pendingMeasurements: Set<string>
}

/**
 * One lifecycle step of useViewportWindow's liveness-guard teardown effect
 * for the deferred measurement work (see registerMeasurement). On the EFFECT
 * RUN the guard is RE-ARMED — a dev StrictMode-style remount replays the
 * cleanup first, and the guard must come back armed or every capture would
 * permanently no-op while the component stays mounted. On the CLEANUP the
 * guard is disarmed and all pending deferred-measurement state is cleared,
 * so no retry timer can fire after unmount and the flush/detach microtasks
 * no-op through the disarmed guard. Exported for direct unit testing.
 */
export const stepViewportLivenessGuard = (
  alive: { current: boolean },
  pending: ViewportLivenessPendingState,
  step: 'effect-run' | 'effect-cleanup',
): void => {
  if (step === 'effect-run') {
    alive.current = true
    return
  }
  alive.current = false
  for (const timer of pending.retryTimers.values()) {
    clearTimeout(timer)
  }
  pending.retryTimers.clear()
  pending.retryAttempts.clear()
  pending.detachNodes.clear()
  pending.pendingMeasurements.clear()
}

/** Live hooks a measurement capture closure consults (see
 * createMeasurementCapture). */
export interface MeasurementCaptureDeps {
  /** Hook liveness guard: a capture running after unmount must no-op. */
  isAlive: () => boolean
  /** The CURRENT available width, read at capture time. */
  getWidth: () => number
  /** Re-arm the bounded zero-height retry chain (see registerMeasurement). */
  scheduleZeroHeightRetry: () => void
  /** Cancel the bounded zero-height retry chain. */
  clearZeroHeightRetry: () => void
  /** The measurement currently stored for the message, if any. */
  getStored: () => MeasuredHeight | undefined
  /** Persist a measurement and enqueue the render flush. */
  store: (width: number, height: number) => void
}

/**
 * Build the height-capture closure for one mounted wrapper node: installed
 * both as the ref-attach capture and as the node's onSizeChange handler.
 *
 * The width is read through `deps.getWidth` at CAPTURE time and never bound
 * at creation: a width bound at attach time would store re-measured heights
 * tagged with the stale width after a terminal width change (zoom) — entries
 * resolveMessageHeight then permanently ignores until the wrapper node is
 * replaced. Exported for direct unit testing.
 */
export const createMeasurementCapture = (
  node: { height: number },
  deps: MeasurementCaptureDeps,
): (() => void) => {
  return () => {
    if (!deps.isAlive()) return
    const height = node.height
    if (height <= 0) {
      // The wrapper's height is not yet assigned (OpenTUI may set the
      // initial height in a layout pass that does not emit onSizeChange):
      // retry on the bounded chain instead of never measuring until an
      // unrelated resize degrades the message to estimate-based heights.
      deps.scheduleZeroHeightRetry()
      return
    }
    deps.clearZeroHeightRetry()
    const width = deps.getWidth()
    const prev = deps.getStored()
    if (prev && prev.width === width && prev.height === height) return
    deps.store(width, height)
  }
}

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
 * reasonably close so the window and spacers track reality until the message
 * mounts and reports its real measured height (see resolveMessageHeight).
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

/** A real measured height, tagged with the width it was measured at. */
export interface MeasuredHeight {
  width: number
  height: number
}

/**
 * Remove measured heights for message ids no longer present in the visible
 * list (pagination collapse, session reset, message pruning): entries are
 * only ever consulted for messages currently in the list, so this only keeps
 * the map bounded over a long-lived session. Per-unmount retention for a
 * STILL-LISTED message is deliberately unchanged (deleting on unmount caused
 * a measure->unmount->revert oscillation). Returns the number of pruned
 * entries. Exported for direct unit testing.
 */
export const pruneMeasuredHeights = (
  heights: Map<string, MeasuredHeight>,
  visibleIds: ReadonlySet<string>,
  pending?: Set<string>,
): number => {
  let pruned = 0
  for (const id of heights.keys()) {
    if (!visibleIds.has(id)) {
      heights.delete(id)
      pruned++
    }
  }
  if (pending) {
    for (const id of pending) {
      if (!visibleIds.has(id)) pending.delete(id)
    }
  }
  return pruned
}

/**
 * Resolve the height to use for a message in the window/spacer math.
 *
 * A measured height wins only when it was captured at the current
 * `availableWidth`; a width-mismatched entry is stale (zoom changed the wrap)
 * and is treated as absent — never rescaled, migrated, or clamped. With no
 * usable measurement the estimate fallback runs (estimates ARE clamped to
 * MAX_MESSAGE_HEIGHT inside estimateMessageHeight; measured heights are not).
 * Exported for direct unit testing.
 */
export const resolveMessageHeight = (
  message: ChatMessage,
  measured: MeasuredHeight | undefined,
  availableWidth: number,
): number => {
  if (measured !== undefined && measured.width === availableWidth) {
    return measured.height
  }
  return estimateMessageHeight(message, availableWidth)
}

/**
 * Compute the top spacer height (relative to the message content area, so the
 * fixed header is already excluded) for a scroll position.
 *
 * `offsets` are prefix offsets including the fixed header; the returned spacer
 * is the offset of the first windowed message minus the fixed top rows,
 * floored at 0. Exported for direct unit testing.
 */
export const computeTopSpacer = (
  offsets: number[],
  heights: number[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  fixedTopHeight: number,
): number => {
  const windowStart = Math.max(0, scrollTop - overscanPx)
  let startIndex = 0
  while (
    startIndex < heights.length - 1 &&
    offsets[startIndex] + heights[startIndex] <= windowStart
  ) {
    startIndex++
  }
  return Math.max(0, (offsets[startIndex] ?? 0) - fixedTopHeight)
}

/**
 * First index whose message intersects the viewport top (`scrollTop`). This
 * is the anchor message: when heights change, keeping its content under the
 * viewport keeps the viewport stable.
 */
export const computeAnchorIndex = (
  offsets: number[],
  heights: number[],
  scrollTop: number,
): number => {
  let index = 0
  while (
    index < heights.length - 1 &&
    offsets[index] + heights[index] <= scrollTop
  ) {
    index++
  }
  return index
}

/**
 * Scroll delta that keeps the anchor message's content at the same viewport
 * position after a layout change: the shift of the anchor message's top
 * offset between the two prefix-offset layouts — the summed height/add/remove
 * change of everything above it.
 *
 * The anchor (the first message intersecting the viewport top in the PREVIOUS
 * layout) is identified by MESSAGE ID (via `prevIds`/`nextIds`), not by
 * positional index: when the visible list mutates above the viewport between
 * commits (LoadPrevious prepends hidden messages; pruning/session edits
 * remove messages) a positional index refers to a DIFFERENT message in the
 * next layout — under-compensating after a prepend, or reading past the end
 * of `nextOffsets` (a large negative delta whose clamped write snaps scrollTop
 * to 0). When the anchor message itself is no longer in the next list, no
 * compensation is attempted (0), so the viewport is never snapped by a bogus
 * delta; a change strictly below the anchor also yields 0 (no snap-back).
 *
 * Exported for direct unit testing.
 */
export const computeAnchorDelta = (
  prevIds: readonly string[],
  prevOffsets: number[],
  prevHeights: number[],
  nextIds: readonly string[],
  nextOffsets: number[],
  nextHeights: number[],
  scrollTop: number,
): number => {
  const anchorIndex = computeAnchorIndex(prevOffsets, prevHeights, scrollTop)
  const anchorId = prevIds[anchorIndex]
  if (anchorId === undefined) return 0
  const nextAnchorIndex = nextIds.indexOf(anchorId)
  if (nextAnchorIndex === -1) return 0
  const prevAnchorTop = prevOffsets[anchorIndex] ?? 0
  const nextAnchorTop = nextOffsets[nextAnchorIndex] ?? 0
  return nextAnchorTop - prevAnchorTop
}

/**
 * The scroll position the scroll-anchoring layout effect must compute its
 * compensation delta against: the LIVE canonical scroll position read from
 * the CURRENT scrollbox at layout-effect commit time (the same
 * verticalScrollBar.scrollPosition source every other reader in this data
 * flow uses), falling back to the render-captured scrollTop React state only
 * when no live scrollbox is available (unit-test/no-box environments). The
 * captured state can be stale at commit time, and a delta computed from a
 * stale anchor shifts the live position in the wrong direction — a
 * wrong-direction adjustment the deferred verify chain cannot correct.
 * Exported for direct unit testing.
 */
export const resolveAnchorScrollTop = (
  scrollbox: { verticalScrollBar: { scrollPosition: number } } | null,
  maxScroll: number,
  fallback: number,
): number => {
  if (!scrollbox) return fallback
  return Math.min(
    Math.max(0, scrollbox.verticalScrollBar.scrollPosition),
    maxScroll,
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
  /**
   * Imperative at-bottom probe (from use-scroll-management via use-chat-ui).
   * Read during width changes to decide whether to re-pin to the bottom.
   */
  isAtBottomNow?: () => boolean
  /** Compensating scroll writer for above-viewport height changes. */
  adjustScrollTop?: (delta: number, opts?: { follow?: boolean }) => void
  /** Re-pin to the bottom after a width change when the user was at bottom. */
  scrollToLatest?: () => void
}

export interface ViewportWindow {
  startIndex: number
  endIndex: number
  topSpacerHeight: number
  bottomSpacerHeight: number
  viewportHeight: number
  scrollTop: number
  /**
   * Measurement registration for the windowed message wrappers. Called from
   * the wrapper's ref with the mounted BoxRenderable (or null on unmount,
   * which only detaches the resize handler and retains the last height).
   */
  registerMeasurement: (
    id: string,
    node: BoxRenderable | null,
  ) => void
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
  isAtBottomNow,
  adjustScrollTop,
  scrollToLatest,
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

  // The CURRENT available width, read at measurement-capture time (see
  // createMeasurementCapture): a still-mounted wrapper must observe the live
  // width so re-measures after a terminal width change (zoom) are tagged with
  // the new width instead of the width bound at attach time.
  const availableWidthRef = useRef(availableWidth)
  availableWidthRef.current = availableWidth
  // Real measured heights for mounted messages, keyed by message id and
  // tagged with the width at measure time. A measurement is NEVER deleted on
  // unmount (deleting caused a measure->unmount->revert oscillation); the
  // last known height is retained and simply stops being used once its width
  // no longer matches (a zoom) or the message is later re-measured.
  const measuredHeightsRef = useRef<Map<string, MeasuredHeight>>(new Map())
  // Widths of the measurements enqueued but not yet flushed into a render.
  const pendingMeasurementsRef = useRef<Set<string>>(new Set())
  // Bumped once per burst of measurements to trigger a single re-render.
  const [heightsVersion, setHeightsVersion] = useState(0)
  // Whether a flush is already scheduled for the current burst: captures
  // only enqueue ids, and one scheduled flush (queueMicrotask) bumps
  // heightsVersion exactly once per burst — N measurements cause one
  // re-render, not N.
  const flushScheduledRef = useRef(false)
  const flushMeasurementsRef = useRef<() => void>(() => {})
  flushMeasurementsRef.current = () => {
    if (flushScheduledRef.current) return
    flushScheduledRef.current = true
    queueMicrotask(() => {
      flushScheduledRef.current = false
      // The hook unmounted between scheduling this flush and the microtask
      // running: bumping heightsVersion now would update state on an
      // unmounted hook.
      if (!aliveRef.current) return
      if (pendingMeasurementsRef.current.size === 0) return
      pendingMeasurementsRef.current = new Set()
      setHeightsVersion((v) => v + 1)
    })
  }

  // The last-mounted node per message id, so the unmount (null) ref-callback
  // path can detach the resize handler from the outgoing node.
  const measuredNodesRef = useRef<Map<string, BoxRenderable>>(new Map())
  // Bounded zero-height retry chain per message id (see capture below): a
  // wrapper whose height is still 0 at ref-attachment time is re-captured on
  // a short timer chain until a usable height lands or the budget is
  // exhausted — measurement no longer depends on OpenTUI emitting
  // onSizeChange for the layout pass that assigns the initial height.
  const measureRetryTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map())
  const measureRetryAttemptsRef = useRef<Map<string, number>>(new Map())
  // Detached nodes awaiting teardown of their zero-height retry chain (see
  // scheduleZeroHeightDetachCleanup): keyed by message id, holding the node
  // that was detached so a re-attach can be recognized as the same instance.
  const pendingDetachNodesRef = useRef<Map<string, BoxRenderable>>(new Map())
  const clearZeroHeightRetry = (id: string): void => {
    const timer = measureRetryTimersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      measureRetryTimersRef.current.delete(id)
    }
    measureRetryAttemptsRef.current.delete(id)
  }
  // Deferred teardown of a detached node's zero-height retry chain: the
  // wrapper ref can detach (null) and re-attach the SAME node within one
  // commit, and tearing the chain down synchronously on every detach would
  // let frequent re-render churn re-arm the bounded chain indefinitely.
  // Defer instead: a same-node re-attach cancels the cleanup and the chain
  // (with its accumulated budget) survives; only a detach that survives to
  // the microtask — a genuine unmount — cancels it and resets the budget.
  const scheduleZeroHeightDetachCleanup = (
    id: string,
    node: BoxRenderable,
  ): void => {
    pendingDetachNodesRef.current.set(id, node)
    queueMicrotask(() => {
      // A re-attach deletes the entry (or replaces it with a different
      // node); a missing/replaced entry means this cleanup is superseded.
      if (pendingDetachNodesRef.current.get(id) !== node) return
      pendingDetachNodesRef.current.delete(id)
      clearZeroHeightRetry(id)
    })
  }
  // Liveness guard + teardown for the deferred measurement work (the
  // zero-height retry timers and the flush/detach microtasks they schedule):
  // without it a retry timer could fire after unmount and run capture()
  // against detached nodes, re-arming the chain and bumping heightsVersion on
  // the unmounted hook. On cleanup all pending retry timers are cleared and
  // every deferred microtask no-ops through the aliveRef guard; the effect
  // body RE-ARMS the guard on every run (a dev StrictMode-style remount
  // replays the cleanup first).
  const aliveRef = useRef(true)
  useEffect(() => {
    stepViewportLivenessGuard(
      aliveRef,
      {
        retryTimers: measureRetryTimersRef.current,
        retryAttempts: measureRetryAttemptsRef.current,
        detachNodes: pendingDetachNodesRef.current,
        pendingMeasurements: pendingMeasurementsRef.current,
      },
      'effect-run',
    )
    return () => {
      stepViewportLivenessGuard(
        aliveRef,
        {
          retryTimers: measureRetryTimersRef.current,
          retryAttempts: measureRetryAttemptsRef.current,
          detachNodes: pendingDetachNodesRef.current,
          pendingMeasurements: pendingMeasurementsRef.current,
        },
        'effect-cleanup',
      )
    }
  }, [])
  // Capture a wrapper's real rendered height. Called by message-list-window's
  // measurement ref with the freshly-mounted BoxRenderable. On unmount the
  // ref fires with null: the outgoing node's onSizeChange handler is cleared
  // synchronously, while the retry-chain teardown is deferred one microtask
  // (see scheduleZeroHeightDetachCleanup) so a same-node detach/re-attach
  // keeps the chain and its attempt budget; the last measured height for the
  // id is retained either way.
  const registerMeasurement = (
    id: string,
    node: BoxRenderable | null,
  ): void => {
    if (!node) {
      const outgoing = measuredNodesRef.current.get(id)
      if (outgoing) {
        outgoing.onSizeChange = undefined
        measuredNodesRef.current.delete(id)
        scheduleZeroHeightDetachCleanup(id, outgoing)
      }
      return
    }
    const scheduleZeroHeightRetry = (): void => {
      if (measureRetryTimersRef.current.has(id)) return
      const next = nextZeroHeightAttempt(
        measureRetryAttemptsRef.current.get(id) ?? 0,
      )
      if (next === null) return
      measureRetryAttemptsRef.current.set(id, next)
      measureRetryTimersRef.current.set(
        id,
        setTimeout(() => {
          measureRetryTimersRef.current.delete(id)
          capture()
        }, ZERO_HEIGHT_RETRY_DELAY_MS),
      )
    }
    // The capture closure is installed as BOTH the ref-attach capture and
    // the node's onSizeChange handler, so it outlives this render: it reads
    // the width at CAPTURE time (through availableWidthRef) rather than
    // binding the width at attach time, keeping re-measures after a terminal
    // width change (zoom) tagged with the live width (see
    // createMeasurementCapture).
    const capture = createMeasurementCapture(node, {
      isAlive: () => aliveRef.current,
      getWidth: () => availableWidthRef.current,
      scheduleZeroHeightRetry,
      clearZeroHeightRetry: () => clearZeroHeightRetry(id),
      getStored: () => measuredHeightsRef.current.get(id),
      store: (width, height) => {
        measuredHeightsRef.current.set(id, { width, height })
        pendingMeasurementsRef.current.add(id)
        flushMeasurementsRef.current()
      },
    })
    // A re-attach of the SAME node (React can detach and re-attach a ref
    // within one commit) keeps the pending chain and its accumulated attempt
    // budget; only a genuinely new node instance starts a fresh budget.
    const lastSeenNode =
      pendingDetachNodesRef.current.get(id) ?? measuredNodesRef.current.get(id)
    const isNewNode = isFreshMeasurementNode(lastSeenNode, node)
    pendingDetachNodesRef.current.delete(id)
    measuredNodesRef.current.set(id, node)
    if (isNewNode) {
      clearZeroHeightRetry(id)
    }
    capture()
    node.onSizeChange = capture
  }

  // Prune measurements for messages that have left the list (pagination
  // collapse, session reset, message pruning) so the height map does not grow
  // monotonically for the component's lifetime. Only ids absent from
  // `messages` are removed, so a message that merely unmounts while still
  // listed keeps its retained height (see pruneMeasuredHeights).
  const visibleMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages],
  )
  useLayoutEffect(() => {
    pruneMeasuredHeights(
      measuredHeightsRef.current,
      visibleMessageIds,
      pendingMeasurementsRef.current,
    )
  }, [visibleMessageIds])

  // Resolve heights: a measured height wins when its width matches; otherwise
  // fall back to a width-aware estimate. Recomputed from the measurement map
  // (never a width-blind cached estimate), so a width change (zoom) re-derives
  // estimates at the new width.
  const heights = useMemo(
    () =>
      messages.map((message) =>
        resolveMessageHeight(
          message,
          measuredHeightsRef.current.get(message.id),
          availableWidth,
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- heightsVersion
    // re-derives heights after a measurement burst lands.
    [messages, availableWidth, heightsVersion],
  )

  const messageListHeight = useMemo(
    () => heights.reduce((acc, h) => acc + h, 0),
    [heights],
  )
  const fixedTopHeight = headerHeight + (hasLoadPrevious ? 1 : 0)
  const totalHeight = fixedTopHeight + messageListHeight + trailingHeight

  // Width change (terminal zoom): every message re-wraps, so all offsets shift
  // at once and the width-tagged measurements go stale. Bump heightsVersion so
  // mismatched measurements are ignored and estimates recompute at the new
  // width, skip delta anchoring, and re-pin to the bottom if the user was
  // there (their intent is "watch the latest", not a specific message).
  // scrollToLatest's animation defers verification of the SETTLED bottom so
  // the deferred chain re-pins to the new bottom once the re-wrapped layout
  // commits (see use-scroll-management).
  const prevWidthRef = useRef(availableWidth)
  useLayoutEffect(() => {
    if (prevWidthRef.current === availableWidth) return
    prevWidthRef.current = availableWidth
    pendingMeasurementsRef.current = new Set()
    setHeightsVersion((v) => v + 1)
    const follow = isAtBottomNow ? isAtBottomNow() : true
    if (follow) {
      scrollToLatest?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- width-change edge
    // trigger only; the latest callbacks are read so the effect stays correct.
  }, [availableWidth, isAtBottomNow, scrollToLatest])

  // Scroll anchoring: when an above-viewport message's height changes — or
  // the visible list above the viewport mutates (LoadPrevious prepending
  // hidden messages, pruning/session edits removing messages) — shift
  // scrollTop by the delta that keeps the anchor message's content at the
  // same viewport position. The anchor is identified by message ID across
  // commits (see computeAnchorDelta), so a count-changing mutation above the
  // viewport cannot make a positional index refer to a different message in
  // the next layout. Computed from the prefix-offset shift of the anchor;
  // a change below the viewport (the streaming last message while scrolled
  // up) yields 0. Runs in a layout effect so the compensation lands in the
  // same commit as the spacer change; because OpenTUI's ordering between
  // this scrollTop write and the committed child layout producing the new
  // maxScroll cannot be assumed, use-scroll-management re-verifies the write
  // against settled geometry and re-applies any residual the initial clamp
  // swallowed (see ANCHOR_VERIFY_* there).
  // Message ids in render order, captured into the anchoring snapshot below
  // so the anchor is identified by message ID across commits (see
  // computeAnchorDelta).
  const messageIds = useMemo(
    () => messages.map((message) => message.id),
    [messages],
  )
  const anchorPrevRef = useRef<{
    width: number
    ids: string[]
    offsets: number[]
    heights: number[]
  } | null>(null)
  useLayoutEffect(() => {
    const prev = anchorPrevRef.current
    anchorPrevRef.current = {
      width: availableWidth,
      ids: messageIds,
      offsets,
      heights,
    }
    if (!prev || !adjustScrollTop) return
    // A width change (zoom) shifts every offset at once; never delta-anchor
    // across it (the width-change effect re-pins to the bottom instead).
    if (prev.width !== availableWidth) return
    // The anchor must be resolved against the LIVE canonical scroll position
    // at this effect's commit time (resolveAnchorScrollTop), not the
    // render-captured scrollTop React state: a further change event can land
    // between the state update and this commit, and computing the delta for
    // an anchor no longer under the viewport top makes adjustScrollTop shift
    // the live position by a wrong-direction delta the deferred verify chain
    // cannot correct.
    const liveBox = scrollTopOverride !== undefined ? null : scrollRef.current
    const maxScroll = liveBox
      ? Math.max(0, liveBox.scrollHeight - liveBox.viewport.height)
      : 0
    const anchorScrollTop = resolveAnchorScrollTop(
      liveBox,
      maxScroll,
      scrollTop,
    )
    const delta = computeAnchorDelta(
      prev.ids,
      prev.offsets,
      prev.heights,
      messageIds,
      offsets,
      heights,
      anchorScrollTop,
    )
    if (delta !== 0) {
      adjustScrollTop(delta)
    }
  })

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

  const { startIndex, endIndex, bottomSpacerHeight } = useMemo(
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

  // Top spacer relative to the message content area (fixed header excluded),
  // so message-list-window uses it directly without re-subtracting the header.
  const topSpacer = computeTopSpacer(
    offsets,
    heights,
    scrollTop,
    viewportHeight,
    overscanPx,
    fixedTopHeight,
  )

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
      registerMeasurement,
    }
  }

  return {
    startIndex,
    endIndex,
    topSpacerHeight: topSpacer,
    bottomSpacerHeight,
    viewportHeight,
    scrollTop,
    registerMeasurement,
  }
}
