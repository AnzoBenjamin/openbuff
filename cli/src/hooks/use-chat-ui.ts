/**
 * Chat UI hook - scroll behavior, terminal dimensions, and theme.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  computeIsNearBottom,
  useChatScrollbox,
} from './use-scroll-management'
import { useTerminalDimensions } from './use-terminal-dimensions'
import { useTerminalLayout } from './use-terminal-layout'
import { useTheme } from './use-theme'
import { createChatScrollAcceleration } from '../utils/chat-scroll-accel'
import { createMarkdownPalette } from '../utils/theme-system'

import type { ChatMessage } from '../types/chat'
import type { ChatTheme } from '../types/theme-system'
import type { MarkdownPalette } from '../utils/markdown-renderer'
import type { ScrollBoxRenderable } from '@opentui/core'

export interface UseChatUIOptions {
  messages: ChatMessage[]
  isUserCollapsing: () => boolean
}

export interface UseChatUIReturn {
  // Scroll management
  scrollRef: React.RefObject<ScrollBoxRenderable | null>
  scrollToLatest: () => void
  scrollUp: () => void
  scrollDown: () => void
  adjustScrollTop: (delta: number, opts?: { follow?: boolean }) => void
  isAtBottomNow: () => boolean
  appliedScrollboxProps: Record<string, unknown>
  isAtBottom: boolean
  hasOverflow: boolean

  // Terminal dimensions
  terminalWidth: number
  terminalHeight: number
  separatorWidth: number
  messageAvailableWidth: number
  isCompactHeight: boolean
  isNarrowWidth: boolean

  // Theme
  theme: ChatTheme
  markdownPalette: MarkdownPalette
}

export function useChatUI({
  messages,
  isUserCollapsing,
}: UseChatUIOptions): UseChatUIReturn {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const hasOverflowRef = useRef(false)

  // Terminal dimensions
  const { separatorWidth, terminalWidth, terminalHeight } =
    useTerminalDimensions()
  const { height: heightLayout, width: widthLayout } = useTerminalLayout()
  const isCompactHeight = heightLayout.is('xs')
  const isNarrowWidth = widthLayout.is('xs')
  const messageAvailableWidth = separatorWidth

  // Theme
  const theme = useTheme()
  const markdownPalette = useMemo(() => createMarkdownPalette(theme), [theme])

  // Scroll management
  const {
    scrollToLatest,
    scrollUp,
    scrollDown,
    adjustScrollTop,
    scrollboxProps,
    isAtBottom,
  } = useChatScrollbox(scrollRef, messages, isUserCollapsing)

  // Imperative at-bottom probe for the windowing hook: true while the scroll
  // position is pinned to the bottom. Width changes re-derive every offset, so
  // the anchor path is skipped and an at-bottom view is re-pinned to the new
  // bottom instead of delta-anchored across the change.
  const isAtBottomNow = useCallback((): boolean => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return true
    const maxScroll = Math.max(
      0,
      scrollbox.scrollHeight - scrollbox.viewport.height,
    )
    // Read the position through the same source every other scroll-position
    // reader in this data flow uses (verticalScrollBar.scrollPosition) and
    // compare with the shared computeIsNearBottom: scrollbox.scrollTop can
    // transiently diverge from the scrollbar position (e.g. right after a
    // programmatic scrollTop write), and a divergent read here would misdrive
    // the width-change re-pin decision.
    return computeIsNearBottom(
      scrollbox.verticalScrollBar.scrollPosition,
      maxScroll,
    )
  }, [scrollRef])

  // Check if content has overflowed and needs scrolling
  useEffect(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return

    const checkOverflow = () => {
      const contentHeight = scrollbox.scrollHeight
      const viewportHeight = scrollbox.viewport.height
      const isOverflowing = contentHeight > viewportHeight

      if (hasOverflowRef.current !== isOverflowing) {
        hasOverflowRef.current = isOverflowing
        setHasOverflow(isOverflowing)
      }
    }

    checkOverflow()
    scrollbox.verticalScrollBar.on('change', checkOverflow)

    return () => {
      scrollbox.verticalScrollBar.off('change', checkOverflow)
    }
  })

  // Inertial scroll acceleration
  const inertialScrollAcceleration = useMemo(
    () => createChatScrollAcceleration(),
    [],
  )

  const appliedScrollboxProps = useMemo(
    () =>
      inertialScrollAcceleration
        ? { ...scrollboxProps, scrollAcceleration: inertialScrollAcceleration }
        : scrollboxProps,
    [scrollboxProps, inertialScrollAcceleration],
  )

  return {
    // Scroll management
    scrollRef,
    scrollToLatest,
    scrollUp,
    scrollDown,
    adjustScrollTop,
    isAtBottomNow,
    appliedScrollboxProps,
    isAtBottom,
    hasOverflow,

    // Terminal dimensions
    terminalWidth,
    terminalHeight,
    separatorWidth,
    messageAvailableWidth,
    isCompactHeight,
    isNarrowWidth,

    // Theme
    theme,
    markdownPalette,
  }
}
