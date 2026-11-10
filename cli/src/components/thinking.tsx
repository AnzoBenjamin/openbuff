import { TextAttributes } from '@opentui/core'
import React, { memo, type ReactNode } from 'react'

import { Button } from './button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { getLastNVisualLines } from '../utils/text-layout'

import type { ThinkingCollapseState } from '../types/chat'

const PREVIEW_LINE_COUNT = 5

interface ThinkingProps {
  content: string
  thinkingCollapseState: ThinkingCollapseState
  /** Whether the thinking has completed (streaming finished) */
  isThinkingComplete: boolean
  onToggle: () => void
  onInspect?: () => void
  previewLimited?: boolean
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
    onInspect,
    previewLimited,
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

    const width = Math.max(10, availableWidth ?? contentMaxWidth)
    const previewWidth = Math.max(10, width - 5)
    const preview =
      thinkingCollapseState === 'preview'
        ? getLastNVisualLines(
            content.slice(-8192).replace(/\n+/g, ' ').trim(),
            previewWidth,
            PREVIEW_LINE_COUNT,
          )
        : { lines: [], hasMore: false }
    const lines = preview.lines
    const hasMore = Boolean(
      previewLimited || preview.hasMore || content.length > 8192,
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
      <box style={{ flexDirection: 'column', width: '100%' }}>
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
              >
                {hasMore ? '…' + lines.join('\n') : lines.join('\n')}
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
                  wrapMode: 'word',
                  fg: theme.foreground,
                }}
              >
                {content}
              </text>
            </box>
          )}
        </Button>
        {thinkingCollapseState === 'hidden' ||
        (thinkingCollapseState === 'preview' && hasMore) ||
        onInspect ? (
          <box style={{ flexDirection: 'row', paddingLeft: 2, minWidth: 0 }}>
            {thinkingCollapseState === 'hidden' ? (
              <text fg={theme.muted}>
                {onInspect ? 'Hidden · ' : 'Reasoning hidden'}
              </text>
            ) : thinkingCollapseState === 'preview' && hasMore ? (
              <text fg={theme.muted}>
                {onInspect ? 'Tail preview · ' : 'Reasoning tail preview'}
              </text>
            ) : null}
            {onInspect ? (
              <Button onClick={onInspect} style={{ flexShrink: 0 }}>
                <text fg={theme.link}>Inspect reasoning</text>
              </Button>
            ) : null}
          </box>
        ) : null}
      </box>
    )
  },
)
