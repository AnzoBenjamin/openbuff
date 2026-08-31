import { TextAttributes } from '@opentui/core'
import React, { useEffect, useState } from 'react'

import { Button } from './button'
import {
  isScrollButtonCompact,
  ScrollToBottomButton,
} from './scroll-to-bottom-button'
import { ShimmerText } from './shimmer-text'

import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import {
  formatIndexStatusChip,
  type IndexStatusPeek,
} from '../utils/index-status'
import {
  selectStatusBarChips,
  type StatusBarChipTone,
} from '../utils/status-bar-chips'
import type { CompactionNotice } from '../types/chat'
import type { StatusIndicatorState } from '../utils/status-indicator-state'

/** A small status-bar action button with hover-bold styling. */
const StatusActionButton = ({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick: () => void
}) => {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)

  return (
    <Button
      style={{ paddingLeft: 1, paddingRight: 1 }}
      onClick={onClick}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text>
        <span
          fg={theme.secondary}
          attributes={hovered ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {children}
        </span>
      </text>
    </Button>
  )
}

const SHIMMER_INTERVAL_MS = 160

const chipForeground = (
  theme: ReturnType<typeof useTheme>,
  tone: StatusBarChipTone,
) => {
  switch (tone) {
    case 'muted':
      return theme.muted
    case 'secondary':
      return theme.secondary
    case 'warning':
      return theme.warning
    case 'error':
      return theme.error
  }
}

interface StatusBarProps {
  timerStartTime: number | null
  isAtBottom: boolean
  scrollToLatest: () => void
  statusIndicatorState: StatusIndicatorState
  contextWindowUsage?: { used: number; max: number } | null
  /**
   * Accumulated context-compaction notice for the current turn (null once the
   * next turn starts). Rendered as a chip beside the context usage.
   */
  compactionNotice?: CompactionNotice | null
  /** Session-accumulated cost in cents (1 dollar = 100 cents). */
  sessionCostCents?: number | null
  /** Resolved model id for the active agent mode (short display string). */
  modelName?: string | null
  /** Git working-tree diff stats (modified/added/deleted counts). */
  diffStats?: { modified: number; added: number; deleted: number } | null
  /** Compact index readiness chip from the CLI IndexManager singleton. */
  indexStatus?: IndexStatusPeek
  onStop?: () => void
}

export const StatusBar = ({
  timerStartTime,
  isAtBottom,
  scrollToLatest,
  statusIndicatorState,
  contextWindowUsage,
  compactionNotice,
  sessionCostCents,
  modelName,
  diffStats,
  indexStatus,
  onStop,
}: StatusBarProps) => {
  const theme = useTheme()
  const { width, terminalWidth } = useTerminalLayout()
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const kind = statusIndicatorState.kind
  const isActive = kind === 'waiting' || kind === 'streaming'
  const showStop = Boolean(onStop && isActive)

  // Show timer when actively working (streaming or waiting for response) or paused (ask_user)
  // This uses statusIndicatorState as the single source of truth for "is the LLM working?"
  const shouldShowTimer =
    kind === 'waiting' || kind === 'streaming' || kind === 'paused'

  useEffect(() => {
    if (!timerStartTime || !shouldShowTimer) {
      setElapsedSeconds(0)
      return
    }

    // When paused, don't update the timer - just keep the frozen value
    if (kind === 'paused') {
      // Calculate current elapsed time once and freeze it
      const now = Date.now()
      const elapsed = Math.floor((now - timerStartTime) / 1000)
      setElapsedSeconds(elapsed)
      return
    }

    const updateElapsed = () => {
      const now = Date.now()
      const elapsed = Math.floor((now - timerStartTime) / 1000)
      setElapsedSeconds(elapsed)
    }

    updateElapsed()
    const interval = setInterval(updateElapsed, 1000)

    return () => clearInterval(interval)
  }, [timerStartTime, shouldShowTimer, kind])

  const { chips } = selectStatusBarChips({
    widthSize: width.size,
    terminalWidth,
    contextWindowUsage,
    compactionNotice,
    sessionCostCents,
    modelName,
    diffStats,
    indexChip: formatIndexStatusChip(indexStatus ?? null),
    elapsedSeconds,
    showTimer: shouldShowTimer,
    showStop,
    showScrollButton: !isAtBottom,
    // ScrollToBottomButton renders its compact form on the same shared
    // predicate, so the reserved columns match the width it actually renders.
    scrollButtonCompact: isScrollButtonCompact(width),
    isActive,
  })

  const renderStatusIndicator = () => {
    switch (statusIndicatorState.kind) {
      case 'ctrlC':
        return <span fg={theme.secondary}>Press Ctrl-C again to exit</span>

      case 'clipboard':
        // Use green color for feedback success messages
        const isFeedbackSuccess =
          statusIndicatorState.message.includes('Feedback sent')
        return (
          <span fg={isFeedbackSuccess ? theme.success : theme.primary}>
            {statusIndicatorState.message}
          </span>
        )

      case 'reconnected':
        return <span fg={theme.success}>Reconnected</span>

      case 'retrying':
        return <ShimmerText text="retrying..." primaryColor={theme.warning} />

      case 'connecting':
        return <ShimmerText text="connecting..." />

      case 'waiting':
        return (
          <ShimmerText
            text={
              width.is('xs')
                ? '…'
                : statusIndicatorState.phaseLabel || 'thinking...'
            }
            interval={SHIMMER_INTERVAL_MS}
            primaryColor={theme.secondary}
          />
        )

      case 'streaming':
        return (
          <ShimmerText
            text={
              width.is('xs')
                ? '…'
                : statusIndicatorState.phaseLabel || 'working...'
            }
            interval={SHIMMER_INTERVAL_MS}
            primaryColor={theme.secondary}
          />
        )

      case 'paused':
        return null

      case 'idle':
        return null
    }
  }

  const statusIndicatorContent = renderStatusIndicator()
  const hasContent =
    Boolean(statusIndicatorContent) ||
    chips.length > 0 ||
    !isAtBottom ||
    showStop

  return (
    <box
      style={{
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 1,
        paddingRight: 1,
        gap: 1,
        backgroundColor: hasContent ? theme.surface : 'transparent',
      }}
    >
      {/* Left: the working label, sized to its content. */}
      <box
        style={{
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        <text style={{ wrapMode: 'none' }}>{statusIndicatorContent}</text>
      </box>

      {/* Middle: the chip cluster, left-aligned inside the growing region so it
          fills the empty middle instead of packing against the right edge. */}
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          flexDirection: 'row',
          justifyContent: 'flex-start',
          alignItems: 'center',
        }}
      >
        <text style={{ wrapMode: 'none' }}>
          {chips.map((chip, index) => (
            <React.Fragment key={chip.id}>
              {index > 0 && <span fg={theme.muted}> · </span>}
              <span
                fg={chipForeground(theme, chip.tone)}
                attributes={
                  chip.tone === 'muted' ? TextAttributes.DIM : undefined
                }
              >
                {chip.label}
              </span>
            </React.Fragment>
          ))}
        </text>
      </box>

      {/* Right: every width-varying control lives here so a hover cannot reflow
          the label or the chips. No minWidth: 0, which would collapse the
          scroll button's reserved width. */}
      <box
        style={{
          flexShrink: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 1,
        }}
      >
        {!isAtBottom && <ScrollToBottomButton onClick={scrollToLatest} />}
        {showStop && onStop && (
          <StatusActionButton onClick={onStop}>■ Esc</StatusActionButton>
        )}
      </box>
    </box>
  )
}
