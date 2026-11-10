import React, { useEffect, useRef, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import { TextAttributes } from '@opentui/core'
import stringWidth from 'string-width'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { AGENT_MODES } from '../utils/constants'

import type { Segment } from './segmented-control'
import type { AgentMode } from '../utils/constants'

export const OPEN_DELAY_MS = 0 // Delay before expanding on hover
export const CLOSE_DELAY_MS = 250 // Delay before collapsing when mouse leaves
export const REOPEN_SUPPRESS_MS = 250 // Time to block reopening after explicit close (prevents flicker)

export const agentModeLabel = (mode: AgentMode): string => {
  return {
    DEFAULT: 'Default',
    PLAN: 'Plan',
    EXECUTE_PLAN: 'Execute plan',
  }[mode]
}

/**
 * Manages the open/close state with hover delays and reopen suppression.
 * Provides timer-based state transitions to create smooth hover interactions.
 */
export function useHoverToggle(onOpenChange?: (open: boolean) => void) {
  const [isOpen, setIsOpen] = useState(false)
  const isOpenRef = useRef(false)
  const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const openTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reopenBlockedUntilRef = useRef<number>(0)

  // Timer cleanup helpers
  const clearOpenTimer = () => {
    clearTimeout(openTimeoutRef.current!)
    openTimeoutRef.current = null
  }

  const clearCloseTimer = () => {
    clearTimeout(closeTimeoutRef.current!)
    closeTimeoutRef.current = null
  }

  const clearAllTimers = () => {
    clearOpenTimer()
    clearCloseTimer()
  }

  // State transition actions
  const openNow = () => {
    clearAllTimers()
    isOpenRef.current = true
    onOpenChange?.(true)
    setIsOpen(true)
  }

  const closeNow = (suppressReopen = false) => {
    clearAllTimers()
    isOpenRef.current = false
    onOpenChange?.(false)
    setIsOpen(false)
    if (suppressReopen) {
      reopenBlockedUntilRef.current = Date.now() + REOPEN_SUPPRESS_MS
    }
  }

  const scheduleOpen = () => {
    if (isOpen) return
    if (Date.now() < reopenBlockedUntilRef.current) return

    clearOpenTimer()
    openTimeoutRef.current = setTimeout(() => {
      openNow()
    }, OPEN_DELAY_MS)
  }

  const scheduleClose = () => {
    if (!isOpen) return

    clearCloseTimer()
    closeTimeoutRef.current = setTimeout(() => {
      closeNow()
    }, CLOSE_DELAY_MS)
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearAllTimers()
      if (isOpenRef.current) onOpenChange?.(false)
    }
  }, [])

  return {
    isOpen,
    isOpenRef,
    openNow,
    closeNow,
    scheduleOpen,
    scheduleClose,
    // Expose individual timer clear helpers so callers can
    // cancel the opposite pending action during hover transitions.
    // These were used by the component but not returned previously,
    // causing runtime errors when hover events fired.
    clearOpenTimer,
    clearCloseTimer,
    clearAllTimers,
  }
}

/**
 * Builds the segment configuration for the expanded state.
 * Shows all modes plus an active indicator with reversed arrow.
 */
export function buildExpandedSegments(currentMode: AgentMode): Segment[] {
  return [
    // All mode options (disabled for current mode)
    ...AGENT_MODES.map((m) => ({
      id: m,
      label: agentModeLabel(m),
      isBold: false,
      disabled: m === currentMode,
    })),
    // Active mode indicator with reversed arrow
    {
      id: `active-${currentMode}`,
      label: `> ${agentModeLabel(currentMode)}`,
      isSelected: true,
      defaultHighlighted: true,
    },
  ]
}

export type AgentModeClickAction =
  | { type: 'closeActive' }
  | { type: 'selectMode'; mode: AgentMode }
  | { type: 'toggleMode'; mode: AgentMode }

/**
 * Decide what high-level action a click on a segment should perform.
 * Extracted for unit testing and clarity.
 */
export const resolveAgentModeClick = (
  currentMode: AgentMode,
  clickedId: string,
  hasOnSelectMode: boolean,
): AgentModeClickAction => {
  if (clickedId.startsWith('active-')) return { type: 'closeActive' }
  const target = clickedId as AgentMode
  if (hasOnSelectMode) {
    return { type: 'selectMode', mode: target }
  }
  return { type: 'toggleMode', mode: target }
}

/**
 * AgentModeToggle
 *
 * Compact, hover-expandable segmented control for switching agent modes.
 * - Clicking the current mode toggles expansion (open/close)
 * - Clicking a different mode calls `onSelectMode` when provided,
 *   otherwise falls back to `onToggle`
 */
export const AgentModeToggle = ({
  mode,
  onToggle,
  onSelectMode,
  onOpenChange,
}: {
  mode: AgentMode
  onToggle: () => void
  onSelectMode?: (mode: AgentMode) => void
  /** Synchronous focus ownership signal; root pauses composer/global keys while open. */
  onOpenChange?: (open: boolean) => void
}) => {
  const theme = useTheme()
  const label = agentModeLabel(mode)
  const inputFocused = useChatStore((state) => state.inputFocused)
  const [isCollapsedHovered, setIsCollapsedHovered] = useState(false)
  const hoverToggle = useHoverToggle(onOpenChange)
  const [selected, setSelected] = useState(
    Math.max(0, AGENT_MODES.indexOf(mode as (typeof AGENT_MODES)[number])),
  )
  const selectedRef = useRef(selected)
  const select = (index: number) => {
    selectedRef.current = index
    setSelected(index)
  }
  useKeyboard((key) => {
    if (!hoverToggle.isOpenRef.current) return
    key.preventDefault()
    key.stopPropagation()
    hoverToggle.clearAllTimers()
    if (key.name === 'escape') {
      hoverToggle.closeNow(true)
      return
    }
    if (key.name === 'up' || key.name === 'left')
      select(Math.max(0, selectedRef.current - 1))
    else if (key.name === 'down' || key.name === 'right')
      select(Math.min(AGENT_MODES.length - 1, selectedRef.current + 1))
    else if (
      key.name === 'return' ||
      key.name === 'enter' ||
      key.name === 'linefeed'
    ) {
      const target = AGENT_MODES[selectedRef.current]
      if (target) onSelectMode ? onSelectMode(target) : onToggle()
      hoverToggle.closeNow(true)
    }
  })

  const handleMouseOver = () => {
    // Don't open on hover if terminal is not focused
    if (!inputFocused) return
    hoverToggle.clearCloseTimer()
    hoverToggle.scheduleOpen()
  }

  const handleMouseOut = () => {
    hoverToggle.scheduleClose()
    setIsCollapsedHovered(false)
  }

  const handleSegmentClick = (id: string) => {
    const action = resolveAgentModeClick(mode, id, !!onSelectMode)
    if (action.type === 'closeActive') {
      hoverToggle.closeNow(true)
      return
    }
    if (action.type === 'selectMode') {
      onSelectMode?.(action.mode)
      hoverToggle.closeNow(true)
      return
    }
    // Toggle fallback (no onSelectMode provided)
    hoverToggle.clearAllTimers()
    onToggle()
    hoverToggle.closeNow(true)
  }

  const collapsed = (
    <Button
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 2,
        paddingRight: 2,
      }}
      onClick={() => {
        if (!inputFocused) return
        hoverToggle.clearAllTimers()
        select(
          Math.max(
            0,
            AGENT_MODES.indexOf(mode as (typeof AGENT_MODES)[number]),
          ),
        )
        hoverToggle.openNow()
      }}
      onMouseOver={() => {
        if (inputFocused) {
          setIsCollapsedHovered(true)
        }
        handleMouseOver()
      }}
      onMouseOut={handleMouseOut}
    >
      <text
        wrapMode="none"
        fg={isCollapsedHovered ? theme.primary : theme.muted}
        attributes={isCollapsedHovered ? TextAttributes.BOLD : 0}
      >
        {`${label} ▾`}
      </text>
    </Button>
  )

  return (
    <box
      width={stringWidth(`${label} ▾`) + 4}
      height={3}
      flexShrink={0}
      justifyContent="center"
    >
      {collapsed}
      {hoverToggle.isOpen && (
        <box
          position="absolute"
          right={0}
          bottom={3}
          zIndex={20}
          width={
            Math.max(...AGENT_MODES.map((value) => stringWidth(value))) + 6
          }
          border
          borderColor={theme.border}
          backgroundColor={theme.surface}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          onMouseOver={() => hoverToggle.clearCloseTimer()}
          onMouseOut={handleMouseOut}
        >
          <text fg={theme.foreground}>
            <b>Mode</b>
          </text>
          {AGENT_MODES.map((value, index) => (
            <Button key={value} onClick={() => handleSegmentClick(value)}>
              <text
                fg={selected === index ? theme.primary : theme.muted}
              >{`${selected === index ? '> ' : '  '}${agentModeLabel(value)}`}</text>
            </Button>
          ))}
          <text fg={theme.muted}>↑↓ Enter · Esc</text>
        </box>
      )}
    </box>
  )
}
