import { useState } from 'react'
import { Button } from './button'
import { useTheme } from '../hooks/use-theme'

/** Quiet evidence disclosure; emphasis appears when the person approaches it. */
export function InspectAction({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)
  return (
    <Button
      onClick={onClick}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{ flexGrow: 0, flexShrink: 0, paddingLeft: 2, minWidth: 0 }}
    >
      <text wrapMode="word" fg={hovered ? theme.primary : theme.muted}>
        <span fg={hovered ? theme.primary : theme.border}>↗ </span>
        {label}
      </text>
    </Button>
  )
}
