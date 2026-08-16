import { TextAttributes } from '@opentui/core'
import { useState } from 'react'

import { Button } from './button'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'

interface ScrollToBottomButtonProps {
  onClick: () => void
  /** Keep the glyph-only label even on hover (narrow terminals). */
  compact?: boolean
}

export const ScrollToBottomButton = ({
  onClick,
  compact,
}: ScrollToBottomButtonProps) => {
  const theme = useTheme()
  const { width } = useTerminalLayout()
  const [hovered, setHovered] = useState(false)
  const isCompact = compact ?? width.atMost('sm')

  return (
    <Button
      style={{
        paddingLeft: isCompact ? 1 : 2,
        paddingRight: isCompact ? 1 : 2,
      }}
      onClick={onClick}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text>
        <span
          fg={theme.info}
          attributes={hovered ? TextAttributes.BOLD : TextAttributes.DIM}
        >
          {hovered && !isCompact ? '↓ Scroll to bottom ↓' : '↓'}
        </span>
      </text>
    </Button>
  )
}
