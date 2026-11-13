import { useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { IMAGE_CARD_BORDER_CHARS } from '../utils/ui-constants'

import type { ReactNode } from 'react'

export interface AttachmentCardProps {
  /** Width of the card in characters */
  width: number
  /** Content to render inside the bordered card. */
  children: ReactNode
  /** Callback when the remove button is clicked. If omitted, the button is hidden. */
  onRemove?: () => void
  /** Whether to show the remove button (default: true). Ignored if onRemove is not provided. */
  showRemoveButton?: boolean
  onInspect?: () => void
  onRetry?: () => void
}

/**
 * Shared attachment card shell used by image and text attachments.
 * Renders a bordered card with an optional 'X' remove button to the right.
 */
export const AttachmentCard = ({
  width,
  children,
  onRemove,
  showRemoveButton = true,
  onInspect,
  onRetry,
}: AttachmentCardProps) => {
  const theme = useTheme()
  const [isCloseHovered, setIsCloseHovered] = useState(false)

  const shouldShowClose = showRemoveButton && !!onRemove

  return (
    <box style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
      <box
        style={{
          flexDirection: 'column',
          borderStyle: 'single',
          borderColor: theme.imageCardBorder,
          width,
          padding: 0,
        }}
        customBorderChars={IMAGE_CARD_BORDER_CHARS}
      >
        {children}
        {(onInspect || onRetry) && (
          <box style={{ flexDirection: 'row', gap: 1 }}>
            {onInspect && (
              <Button onClick={onInspect}>
                <text fg={theme.primary}>Inspect</text>
              </Button>
            )}
            {onRetry && (
              <Button onClick={onRetry}>
                <text fg={theme.primary}>Retry</text>
              </Button>
            )}
          </box>
        )}
      </box>

      {shouldShowClose ? (
        <Button
          onClick={onRemove}
          onMouseOver={() => setIsCloseHovered(true)}
          onMouseOut={() => setIsCloseHovered(false)}
          style={{ marginLeft: 1, paddingLeft: 0, paddingRight: 0 }}
        >
          <text style={{ fg: isCloseHovered ? theme.error : theme.muted }}>
            Remove
          </text>
        </Button>
      ) : (
        // Keep layout aligned when there is no close button
        <box style={{ width: 1 }} />
      )}
    </box>
  )
}
