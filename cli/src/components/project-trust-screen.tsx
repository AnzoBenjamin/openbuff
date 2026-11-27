import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import React, { useCallback, useRef, useState } from 'react'

import { Button } from './button'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

interface ProjectTrustScreenProps {
  lines: string[]
  onDecision: (trusted: boolean) => void
}

export function ProjectTrustScreen({
  lines,
  onDecision,
}: ProjectTrustScreenProps) {
  const theme = useTheme()
  const { terminalHeight } = useTerminalLayout()
  const [selected, setSelected] = useState(false)
  const selectedRef = useRef(selected)
  const decided = useRef(false)

  const decide = useCallback(
    (trusted: boolean) => {
      if (decided.current) return
      decided.current = true
      onDecision(trusted)
    },
    [onDecision],
  )
  const select = useCallback((trusted: boolean) => {
    selectedRef.current = trusted
    setSelected(trusted)
  }, [])

  useKeyboard((key) => {
    const keyName = key.name.toLowerCase()
    if (key.defaultPrevented) return
    if (keyName === 'escape' || (key.ctrl && keyName === 'c')) {
      key.preventDefault()
      decide(false)
    } else if (keyName === 'y') {
      key.preventDefault()
      decide(true)
    } else if (keyName === 'n') {
      key.preventDefault()
      decide(false)
    } else if (
      keyName === 'left' ||
      keyName === 'up' ||
      (keyName === 'tab' && key.shift)
    ) {
      key.preventDefault()
      select(false)
    } else if (keyName === 'right' || keyName === 'down' || keyName === 'tab') {
      key.preventDefault()
      select(true)
    } else if (isPlainEnterKey(key)) {
      key.preventDefault()
      decide(selectedRef.current)
    }
  })

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: terminalHeight >= 24 ? 1 : 0,
        backgroundColor: theme.background,
      }}
    >
      <text
        fg={theme.primary}
        attributes={TextAttributes.BOLD}
        style={{ flexShrink: 0 }}
      >
        Project trust
      </text>
      <text fg={theme.foreground} style={{ flexShrink: 0, marginBottom: 1 }}>
        This project would enable the following settings and content:
      </text>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1 }} scrollX={false}>
        <box style={{ flexDirection: 'column', gap: 1 }}>
          {lines.map((line, index) => (
            <text
              key={`${index}:${line}`}
              fg={theme.foreground}
              wrapMode="word"
            >
              {`• ${line}`}
            </text>
          ))}
        </box>
      </scrollbox>
      <text
        fg={theme.muted}
        wrapMode="word"
        style={{ flexShrink: 0, marginTop: 1 }}
      >
        Without trust, these project settings remain blocked. Your choice is
        saved for this project and asked again if its configuration changes.
      </text>
      <box
        style={{ flexDirection: 'row', gap: 3, flexShrink: 0, marginTop: 1 }}
      >
        <Button onClick={() => decide(false)}>
          <text fg={selected ? theme.foreground : theme.primary}>
            {`${selected ? ' ' : '› '}Keep untrusted (N)`}
          </text>
        </Button>
        <Button onClick={() => decide(true)}>
          <text fg={selected ? theme.primary : theme.foreground}>
            {`${selected ? '› ' : ' '}Trust project (Y)`}
          </text>
        </Button>
      </box>
      <text fg={theme.muted} style={{ flexShrink: 0, marginTop: 1 }}>
        Left/Right choose · Enter confirms · Esc keeps untrusted
      </text>
    </box>
  )
}
