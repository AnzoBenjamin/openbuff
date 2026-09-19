import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'

import type { UpdateContentBlock } from '../../types/chat'

interface UpdateBoxProps {
  block: UpdateContentBlock
}

export const UpdateBox = memo(({ block }: UpdateBoxProps) => {
  const theme = useTheme()

  if (block.updateStatus === 'staged') {
    return (
      <HarnessBox tone="info" title="Update available" gap={0} paddingBottom={1}>
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: theme.secondary }}>Current:</span>
          <span style={{ fg: theme.foreground }}>{` ${block.current ?? 'unknown'}`}</span>
        </text>
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: theme.secondary }}>Available:</span>
          <span style={{ fg: theme.success }}>{` ${block.pending ?? 'unknown'}`}</span>
        </text>
        {block.lines.map((line, idx) => (
          <text
            key={`update-line-${idx}`}
            style={{ wrapMode: 'word', fg: theme.muted }}
          >
            {line}
          </text>
        ))}
      </HarnessBox>
    )
  }

  if (block.updateStatus === 'current') {
    return (
      <HarnessBox tone="success" title="Up to date" gap={0} paddingBottom={1}>
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: theme.secondary }}>Version:</span>
          <span style={{ fg: theme.foreground }}>{` ${block.current ?? 'unknown'}`}</span>
        </text>
        {block.lines.map((line, idx) => (
          <text
            key={`update-line-${idx}`}
            style={{ wrapMode: 'word', fg: theme.muted }}
          >
            {line}
          </text>
        ))}
      </HarnessBox>
    )
  }

  return (
    <HarnessBox tone="warning" title="Update" gap={0} paddingBottom={1}>
      {block.lines.map((line, idx) => (
        <text
          key={`update-line-${idx}`}
          style={{
            wrapMode: 'word',
            fg: idx === 0 ? theme.foreground : theme.muted,
          }}
        >
          {line}
        </text>
      ))}
    </HarnessBox>
  )
})
