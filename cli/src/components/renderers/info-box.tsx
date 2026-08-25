import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'

import type { InfoContentBlock } from '../../types/chat'

interface InfoBoxProps {
  block: InfoContentBlock
}

export const InfoBox = memo(({ block }: InfoBoxProps) => {
  const theme = useTheme()

  return (
    <HarnessBox tone="secondary" title="CLI Diagnostic Info" gap={0} paddingBottom={1}>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <text style={{ fg: theme.secondary }}>Version:</text>
        <text style={{ fg: theme.foreground }}>{` ${block.version}`}</text>
      </text>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <text style={{ fg: theme.secondary }}>Workspace:</text>
        <text style={{ fg: theme.foreground }}>{` ${block.workspace}`}</text>
      </text>
      <text style={{ wrapMode: 'word', fg: theme.foreground }}>
        <text style={{ fg: theme.secondary }}>Auth:</text>
        <text style={{ fg: theme.foreground }}> Local/BYOK Mode</text>
      </text>
    </HarnessBox>
  )
})
