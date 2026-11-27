import { memo, type ReactNode } from 'react'
import { TextAttributes } from '@opentui/core'

import { useTheme } from '../../hooks/use-theme'
import { BORDER_CHARS } from '../../utils/ui-constants'

import type { ChatTheme } from '../../types/theme-system'

type HarnessTone = 'secondary' | 'success' | 'error' | 'warning' | 'info'

interface HarnessBoxProps {
  tone?: HarnessTone
  title?: string
  gap?: 0 | 1
  paddingBottom?: 0 | 1
  children: ReactNode
}

const getBorderColor = (theme: ChatTheme, tone: HarnessTone): string => {
  const colors: Record<HarnessTone, string> = {
    secondary: theme.secondary,
    success: theme.success,
    error: theme.error,
    warning: theme.warning,
    info: theme.info,
  }
  return colors[tone]
}

export const HarnessBox = memo(
  ({
    tone = 'secondary',
    title,
    gap = 1,
    paddingBottom = 1,
    children,
  }: HarnessBoxProps) => {
    const theme = useTheme()
    const borderColor = getBorderColor(theme, tone)
    return (
      <box
        style={{
          flexDirection: 'column',
          gap,
          width: '100%',
          borderStyle: 'single',
          borderColor,
          customBorderChars: BORDER_CHARS,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 0,
          paddingBottom,
        }}
      >
        {title ? (
          <text
            attributes={TextAttributes.BOLD}
            style={{ fg: tone === 'secondary' ? theme.primary : borderColor }}
          >
            {title}
          </text>
        ) : null}
        {children}
      </box>
    )
  },
)
