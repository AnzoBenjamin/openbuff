import { useCallback, useEffect, useRef, useState } from 'react'

import type { ScrollBoxRenderable } from '@opentui/core'

// Scroll detection threshold - how close to bottom to consider "at bottom"
const SCROLL_NEAR_BOTTOM_THRESHOLD = 1

// Animation constants
const ANIMATION_FRAME_INTERVAL_MS = 16 // ~60fps
const DEFAULT_SCROLL_ANIMATION_DURATION_MS = 200

// Page scroll amount (fraction of viewport height)
const PAGE_SCROLL_FRACTION = 0.8

// Delay before auto-scrolling after content changes
const AUTO_SCROLL_DELAY_MS = 50

// Poll interval while waiting for the scrollbox to mount (the scrollRef is
// populated by the rendered scrollbox component, which can happen after this
// hook's first effect run)
const MOUNT_POLL_INTERVAL_MS = 50

// Slower poll interval once a scrollbox is mounted, used only to detect a
// remount (a new ScrollBoxRenderable instance replacing the subscribed one)
const REMOUNT_POLL_INTERVAL_MS = 500

const easeOutCubic = (t: number): number => {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Manages scroll behavior for the chat scrollbox with smooth animations and auto-scroll.
 *
 * @param scrollRef - Reference to the scrollbox component
 * @param messages - Array of chat messages (triggers auto-scroll on change)
 * @param isUserCollapsing - Callback to check if user is actively collapsing/expanding toggles.
 *                          When true, auto-scroll is temporarily suppressed to prevent jarring UX.
 * @returns Scroll management functions and state
 */
export const useChatScrollbox = (
  scrollRef: React.RefObject<ScrollBoxRenderable | null>,
  messages: any[],
  isUserCollapsing: () => boolean,
) => {
  const autoScrollEnabledRef = useRef<boolean>(true)
  const programmaticScrollRef = useRef<boolean>(false)
  const programmaticFollowRef = useRef<boolean>(false)
  const animationFrameRef = useRef<number | null>(null)
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true)

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      clearTimeout(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [])

  const animateScrollTo = useCallback(
    (
      targetScroll: number,
      duration = DEFAULT_SCROLL_ANIMATION_DURATION_MS,
      enableFollowOnComplete = false,
    ) => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return

      cancelAnimation()

      const startScroll = scrollbox.scrollTop
      const distance = targetScroll - startScroll
      const startTime = Date.now()
      const frameInterval = ANIMATION_FRAME_INTERVAL_MS

      const animate = () => {
        // A remount can swap in a new ScrollBoxRenderable while this
        // animation is in flight: the captured instance is then dead, so
        // writing to it would never be observed by the new subscription —
        // but re-arming the programmatic flag on each tick would
        // misattribute the new box's first genuine user scroll as
        // programmatic, losing the user's scroll intent. Abort instead of
        // writing to a stale instance.
        if (scrollRef.current !== scrollbox) {
          animationFrameRef.current = null
          return
        }
        const elapsed = Date.now() - startTime
        const progress = Math.min(elapsed / duration, 1)
        const easedProgress = easeOutCubic(progress)
        const newScroll = startScroll + distance * easedProgress

        // Only arm the programmatic flag when this tick's write actually
        // moves the scroll position: a no-op assignment (a zero-distance
        // animation, or a final tick landing on the position the previous
        // tick already wrote) emits no 'change' event, so an
        // unconditionally armed flag would survive the animation's
        // completion and misattribute the next genuine user scroll as
        // programmatic, losing the user's scroll intent — the same failure
        // mode the subscription-time reset and the auto-scroll effect
        // below guard against.
        if (newScroll !== scrollbox.scrollTop) {
          programmaticScrollRef.current = true
          programmaticFollowRef.current = enableFollowOnComplete
        }
        scrollbox.scrollTop = newScroll

        if (progress < 1) {
          animationFrameRef.current = setTimeout(animate, frameInterval) as any
        } else {
          animationFrameRef.current = null
        }
      }

      animate()
    },
    [scrollRef, cancelAnimation],
  )

  const scrollToLatest = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const maxScroll = Math.max(
      0,
      scrollbox.scrollHeight - scrollbox.viewport.height,
    )
    animateScrollTo(maxScroll, DEFAULT_SCROLL_ANIMATION_DURATION_MS, true)
  }, [scrollRef, animateScrollTo])

  const scrollUp = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const viewportHeight = scrollbox.viewport.height
    const scrollAmount = Math.floor(viewportHeight * PAGE_SCROLL_FRACTION)
    const targetScroll = Math.max(0, scrollbox.scrollTop - scrollAmount)
    autoScrollEnabledRef.current = false
    animateScrollTo(targetScroll)
  }, [scrollRef, animateScrollTo])

  const scrollDown = useCallback((): void => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const viewportHeight = scrollbox.viewport.height
    const maxScroll = Math.max(0, scrollbox.scrollHeight - viewportHeight)
    const scrollAmount = Math.floor(viewportHeight * PAGE_SCROLL_FRACTION)
    const targetScroll = Math.min(maxScroll, scrollbox.scrollTop + scrollAmount)
    animateScrollTo(
      targetScroll,
      DEFAULT_SCROLL_ANIMATION_DURATION_MS,
      targetScroll >= maxScroll,
    )
  }, [scrollRef, animateScrollTo])

  useEffect(() => {
    let handleScrollChange: (() => void) | null = null
    let subscribedBox: ScrollBoxRenderable | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const unsubscribe = () => {
      if (subscribedBox && handleScrollChange) {
        subscribedBox.verticalScrollBar.off('change', handleScrollChange)
      }
      subscribedBox = null
      handleScrollChange = null
    }

    // Re-subscribe whenever the scrollbox instance changes: the effect deps
    // are stable so the effect runs once, but nothing guarantees the first
    // instance survives the hook's lifetime (a remount swaps in a new
    // ScrollBoxRenderable). Without re-subscription, isAtBottom/auto-scroll
    // would track a dead instance and the old listener would leak.
    const subscribe = (scrollbox: ScrollBoxRenderable) => {
      if (scrollbox === subscribedBox) return
      unsubscribe()
      // A remount swapped in a new instance (or the first one attached): any
      // in-flight animation captured the previous instance. Cancel it here so
      // its pending frame cannot fire after this subscription and re-arm the
      // programmatic flag against the new box (the animate loop's own
      // instance guard is the backstop for a swap detected mid-tick).
      cancelAnimation()
      // A programmatic write that landed BEFORE this subscription had no
      // 'change' listener to consume its flag (the mount poll can subscribe
      // up to MOUNT_POLL_INTERVAL_MS after the auto-scroll effect armed the
      // flag and wrote scrollTop), so the flag would still be armed here and
      // misattribute the next genuine user scroll as programmatic, losing
      // the user's intent. The flag can only be consumed by a 'change' event
      // on the subscribed box, and none was delivered for that write, so
      // clear it at subscription time.
      programmaticScrollRef.current = false
      handleScrollChange = () => {
        const maxScroll = Math.max(
          0,
          scrollbox.scrollHeight - scrollbox.viewport.height,
        )
        const current = scrollbox.verticalScrollBar.scrollPosition
        const isNearBottom =
          Math.abs(maxScroll - current) <= SCROLL_NEAR_BOTTOM_THRESHOLD

        if (programmaticScrollRef.current) {
          programmaticScrollRef.current = false
          autoScrollEnabledRef.current =
            programmaticFollowRef.current && isNearBottom
          setIsAtBottom(isNearBottom)
          return
        }

        cancelAnimation()
        autoScrollEnabledRef.current = isNearBottom
        setIsAtBottom((prev) => (prev === isNearBottom ? prev : isNearBottom))
      }
      subscribedBox = scrollbox
      scrollbox.verticalScrollBar.on('change', handleScrollChange)
    }

    const pollForScrollbox = (): void => {
      const current = scrollRef.current
      if (current) {
        // No-op while the same instance stays mounted; re-subscribes when a
        // remount swaps in a new instance (or attaches the first one).
        subscribe(current)
      } else {
        unsubscribe()
      }
      pollTimer = setTimeout(
        pollForScrollbox,
        subscribedBox ? REMOUNT_POLL_INTERVAL_MS : MOUNT_POLL_INTERVAL_MS,
      )
    }
    pollForScrollbox()

    return () => {
      if (pollTimer) clearTimeout(pollTimer)
      unsubscribe()
    }
    // Both deps are stable (a ref object and a []-dep useCallback), so the
    // effect runs once; the poll keeps the subscription pinned to whichever
    // scrollbox instance is currently mounted. The handler itself only reads
    // refs and uses functional setState, so a stale closure is not a concern.
  }, [scrollRef, cancelAnimation])

  useEffect(() => {
    const scrollbox = scrollRef.current
    if (scrollbox) {
      const timeoutId = setTimeout(() => {
        // A remount can swap in a new ScrollBoxRenderable while this timer is
        // pending: the captured instance is then dead, so writing to it would
        // never be observed by the new box's subscription — but arming the
        // programmatic flag would misattribute the new box's first genuine
        // user scroll as programmatic, losing the user's scroll intent. Abort
        // instead of writing to a stale instance (the same guard
        // animateScrollTo applies per frame); the next messages change re-runs
        // this effect against the live instance.
        if (scrollRef.current !== scrollbox) {
          return
        }
        const maxScroll = Math.max(
          0,
          scrollbox.scrollHeight - scrollbox.viewport.height,
        )

        if (scrollbox.scrollTop > maxScroll) {
          programmaticScrollRef.current = true
          scrollbox.scrollTop = maxScroll
        } else if (
          autoScrollEnabledRef.current &&
          !isUserCollapsing() &&
          scrollbox.scrollTop < maxScroll
        ) {
          // Only arm the programmatic flag when the write actually moves the
          // scroll position: a no-op assignment to an already-at-bottom
          // scrollbox emits no 'change' event, which would leave the flag
          // armed and misattribute the next genuine user scroll as
          // programmatic (losing the user's scroll intent).
          programmaticScrollRef.current = true
          scrollbox.scrollTop = maxScroll
        }
      }, AUTO_SCROLL_DELAY_MS)

      return () => clearTimeout(timeoutId)
    }
    return undefined
  }, [messages, scrollToLatest, scrollRef, isUserCollapsing])

  useEffect(() => {
    return () => {
      cancelAnimation()
    }
  }, [cancelAnimation])

  return {
    scrollToLatest,
    scrollUp,
    scrollDown,
    scrollboxProps: {},
    isAtBottom,
  }
}
