import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'

import type { ContextContentBlock } from '../../types/chat'

interface ContextBoxProps {
  block: ContextContentBlock
}

export const ContextBox = memo(({ block }: ContextBoxProps) => {
  const theme = useTheme()
  const ledgerLines =
    block.ledgerText && block.ledgerText.trim().length > 0 ? block.ledgerText.split('\n') : []
  const gateLines =
    block.gateBudgetsText && block.gateBudgetsText.trim().length > 0 ? block.gateBudgetsText.split('\n') : []

  return (
    <HarnessBox tone="secondary" title="Context" gap={1} paddingBottom={1}>
      {ledgerLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          {ledgerLines.map((line, idx) => {
            const isHeader = idx < 2
            return (
              <text
                key={`ledger-${idx}`}
                style={{ wrapMode: 'word', fg: isHeader ? theme.secondary : theme.muted }}
              >
                {line.length > 0 ? line : ' '}
              </text>
            )
          })}
        </box>
      ) : null}
      {gateLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          {gateLines.map((line, idx) => {
            const isTitle = line.startsWith('Gate repair budgets') || line.startsWith('Gate budgets')
            return (
              <text
                key={`gate-${idx}`}
                style={{ wrapMode: 'word', fg: isTitle ? theme.secondary : theme.foreground }}
              >
                {line.length > 0 ? line : ' '}
              </text>
            )
          })}
        </box>
      ) : null}
    </HarnessBox>
  )
})
