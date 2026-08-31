import { TextAttributes } from '@opentui/core'
import { useState } from 'react'
import stringWidth from 'string-width'

import { Button } from './button'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'

import type { WidthLayoutHelper } from '../hooks/use-terminal-layout'

/** Expanded (hovered) label. Short on purpose: the button reserves its width
 * permanently, so a longer hint would crowd the status-bar chips. */
export const SCROLL_HINT_LABEL = '↓ Bottom'

/**
 * Fixed width of the expanded button: the hint label plus one column of padding
 * per side. Reserved in both states so hovering never reflows the status row.
 * Rendered width rather than `.length`, because the label leads with a
 * non-ASCII glyph.
 */
export const SCROLL_BUTTON_WIDTH = stringWidth(SCROLL_HINT_LABEL) + 2

/** Resting/compact glyph. */
export const SCROLL_GLYPH = '↓'

/** Fixed width of the compact (narrow-terminal) form: glyph plus padding. */
export const SCROLL_BUTTON_COMPACT_WIDTH = stringWidth(SCROLL_GLYPH) + 2

/** Single source for which form the button renders; StatusBar uses the same
 * predicate to size the chip-budget reservation, so the two cannot drift. */
export const isScrollButtonCompact = (width: WidthLayoutHelper): boolean =>
  width.atMost('sm')

interface ScrollToBottomButtonProps {
  onClick: () => void
}

export const ScrollToBottomButton = ({
  onClick,
}: ScrollToBottomButtonProps) => {
  const theme = useTheme()
  const { width } = useTerminalLayout()
  const [hovered, setHovered] = useState(false)
  const isCompact = isScrollButtonCompact(width)

  return (
    <Button
      style={{
        // Fixed width and stable padding: the hovered and resting states must
        // occupy identical space or the whole status row reflows on hover.
        width: isCompact ? SCROLL_BUTTON_COMPACT_WIDTH : SCROLL_BUTTON_WIDTH,
        paddingLeft: 1,
        paddingRight: 1,
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
          {hovered && !isCompact ? SCROLL_HINT_LABEL : SCROLL_GLYPH}
        </span>
      </text>
    </Button>
  )
}
