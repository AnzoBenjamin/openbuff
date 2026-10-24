import { TextAttributes } from '@opentui/core'
import React, { memo, type ReactNode } from 'react'

import { Button } from './button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import {
  getLastNVisualLines,
  wrapTextPreservingNewlines,
} from '../utils/text-layout'

import type { ThinkingCollapseState } from '../types/chat'

const PREVIEW_LINE_COUNT = 5

interface ThinkingProps {
  content: string
  thinkingCollapseState: ThinkingCollapseState
  /** Whether the thinking has completed (streaming finished) */
  isThinkingComplete: boolean
  onToggle: () => void
  availableWidth?: number
  /** Epoch ms the reasoning started; enables the `Thinking · 6s` duration header. */
  thinkingStartedAt?: number
  /** Epoch ms the reasoning completed; undefined while streaming (live ticker). */
  thinkingEndedAt?: number
}

export const Thinking = memo(
  ({
    content,
    thinkingCollapseState,
    isThinkingComplete,
    onToggle,
    thinkingStartedAt,
    thinkingEndedAt,
    availableWidth,
  }: ThinkingProps): ReactNode => {
    const theme = useTheme()
    // Duration header: a STATIC `Thought · 6s` from the block's start/end
    // stamps once complete. Deliberately no live ticker while streaming — a
    // self-rescheduling interval keeps the event loop alive in render tests
    // that never unmount the component (it hung `bun test --isolate`), and
    // the streaming state already carries its own activity indicator.
    // Restored sessions from before the stamps existed simply omit it.
    const durationMs =
      isThinkingComplete &&
      thinkingStartedAt !== undefined &&
      thinkingEndedAt !== undefined
        ? thinkingEndedAt - thinkingStartedAt
        : undefined
    const durationLabel =
      durationMs === undefined
        ? ''
        : ` · ${Math.max(1, Math.round(durationMs / 1000))}s`

    const { contentMaxWidth } = useTerminalDimensions()

    // Special case: single **bold** string under 100 chars gets compact rendering
    const singleBoldMatch =
      content.length < 100 ? content.trim().match(/^\*\*([^*]+)\*\*$/) : null
    if (singleBoldMatch) {
      return null
    }

    const width = Math.max(10, availableWidth ?? contentMaxWidth)
    // Child rows are indented by two cells, and preview rows may also carry
    // the ellipsis prefix, so wrap text to the space the renderer actually has.
    const previewWidth = Math.max(10, width - 2 - 3)
    const expandedWidth = Math.max(10, width - 2)
    // Normalize content to single line for consistent preview (but preserve in expanded mode)
    const normalizedContent = content.replace(/\n+/g, ' ').trim()
    const { lines, hasMore } = getLastNVisualLines(
      normalizedContent,
      previewWidth,
      PREVIEW_LINE_COUNT,
    )
    // In expanded mode, preserve original line breaks while hard-wrapping long tokens.
    const expandedContent = wrapTextPreservingNewlines(
      content.replace(/\n\n+/g, '\n\n').trim(),
      expandedWidth,
    )

    const showFull = thinkingCollapseState === 'expanded'
    const showPreview = thinkingCollapseState === 'preview' && lines.length > 0

    const toggleIndicator = !isThinkingComplete
      ? '• '
      : showFull
        ? '▾ '
        : showPreview
          ? '• '
          : '▸ '

    return (
      <Button
        style={{
          flexDirection: 'column',
          gap: 0,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
        }}
        onClick={onToggle}
      >
        <text style={{ fg: theme.foreground }}>
          <span>{toggleIndicator}</span>
          <span attributes={TextAttributes.BOLD}>
            {isThinkingComplete ? 'Thought' : 'Thinking'}
          </span>
          {durationLabel ? (
            <span fg={theme.muted}>{durationLabel}</span>
          ) : null}
        </text>
        {showPreview && (
          <box
            style={{
              paddingLeft: 2,
              flexGrow: 1,
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            <text
              style={{
                wrapMode: 'none',
                fg: theme.muted,
              }}
              attributes={TextAttributes.ITALIC}
            >
              {hasMore ? '...' + lines.join('\n') : lines.join('\n')}
            </text>
          </box>
        )}
        {showFull && (
          <box
            style={{
              paddingLeft: 2,
              flexGrow: 1,
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            <text
              style={{
                wrapMode: 'none',
                fg: theme.muted,
              }}
              attributes={TextAttributes.ITALIC}
            >
              {expandedContent}
            </text>
          </box>
        )}
      </Button>
    )
  },
)
