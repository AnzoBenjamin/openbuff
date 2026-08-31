import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'

import type { ContextContentBlock } from '../../types/chat'

interface ContextBoxProps {
  block: ContextContentBlock
}

/**
 * Lines `formatLedgerForCli` emits as its own heading, which the box replaces
 * with an explicit sub-heading. Matched exactly: if the producer's output ever
 * changes, the lines simply render as-is rather than being silently dropped.
 */
const REDUNDANT_LEDGER_HEADINGS = new Set([
  'Context Budget Breakdown',
  '------------------------',
])

/** The ledger's summary rows start their label at column 0. */
const isSummaryLedgerRow = (line: string): boolean =>
  line.startsWith('total') || line.startsWith('window')

/** Staleness note appended by `formatLedgerForCli` after a /compact. */
const isStalenessNote = (line: string): boolean =>
  line.startsWith('(recorded before the last /compact')

export const ContextBox = memo(({ block }: ContextBoxProps) => {
  const theme = useTheme()
  const ledgerLines = (
    block.ledgerText && block.ledgerText.trim().length > 0
      ? block.ledgerText.split('\n')
      : []
  ).filter((line) => !REDUNDANT_LEDGER_HEADINGS.has(line))
  const gateLines =
    block.gateBudgetsText && block.gateBudgetsText.trim().length > 0
      ? block.gateBudgetsText.split('\n')
      : []

  return (
    <HarnessBox tone="secondary" title="Context" gap={1} paddingBottom={1}>
      {ledgerLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text style={{ wrapMode: 'word', fg: theme.secondary }}>
            Budget ledger
          </text>
          {ledgerLines.map((line, idx) => (
            <text
              key={`ledger-${idx}`}
              style={{
                wrapMode: 'word',
                fg: isStalenessNote(line)
                  ? theme.warning
                  : isSummaryLedgerRow(line)
                    ? theme.foreground
                    : theme.muted,
              }}
            >
              {line.length > 0 ? line : ' '}
            </text>
          ))}
        </box>
      ) : null}
      {gateLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text style={{ wrapMode: 'word', fg: theme.secondary }}>
            Gate budgets
          </text>
          {gateLines.map((line, idx) => {
            const isTitle =
              line.startsWith('Gate repair budgets') ||
              line.startsWith('Gate budgets')
            return (
              <text
                key={`gate-${idx}`}
                style={{
                  wrapMode: 'word',
                  fg: isTitle ? theme.secondary : theme.foreground,
                }}
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
