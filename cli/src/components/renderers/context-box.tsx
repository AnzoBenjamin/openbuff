import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'
import { Button } from '../button'
import { capturedDiagnosticDocument } from '../../utils/captured-diagnostic-document'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { clipEvidenceLine } from '../../utils/bounded-evidence'
import { InlineResults } from '../tools/inline-results'

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
  const instructionLines =
    block.instructionFilesText && block.instructionFilesText.trim().length > 0
      ? block.instructionFilesText
          .split('\n')
          .filter((line) => line !== 'Instruction files')
      : []

  return (
    <HarnessBox tone="secondary" title="Context" gap={1} paddingBottom={1}>
      {!ledgerLines.length && !gateLines.length && (
        <text fg={theme.muted}>
          Context budget and gate detail were not captured in this saved result.
        </text>
      )}
      {(ledgerLines.length > 0 || gateLines.length > 0) && (
        <Button
          onClick={() =>
            useOutputReaderStore.getState().open({
              document: capturedDiagnosticDocument(
                'context-status',
                'Captured context budget',
                block,
              ),
            })
          }
        >
          <text fg={theme.secondary}>Inspect captured context</text>
        </Button>
      )}
      {ledgerLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text style={{ wrapMode: 'word', fg: theme.secondary }}>
            Budget ledger
          </text>
          <InlineResults
            scope="ledger"
            items={ledgerLines}
            previewCount={8}
            noun="ledger row"
            renderItem={(line, idx) => (
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
                {line.length > 0 ? clipEvidenceLine(line, 120) : ' '}
              </text>
            )}
          />
        </box>
      ) : null}
      {gateLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text style={{ wrapMode: 'word', fg: theme.secondary }}>
            Gate budgets
          </text>
          <InlineResults
            scope="gates"
            items={gateLines}
            previewCount={8}
            noun="gate row"
            renderItem={(line, idx) => {
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
                  {line.length > 0 ? clipEvidenceLine(line, 120) : ' '}
                </text>
              )
            }}
          />
        </box>
      ) : null}
      {instructionLines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0 }}>
          <text style={{ wrapMode: 'word', fg: theme.secondary }}>
            Instruction files
          </text>
          <InlineResults
            scope="instructions"
            items={instructionLines}
            previewCount={8}
            noun="instruction file"
            renderItem={(line, idx) => (
              <text
                key={`instruction-${idx}`}
                style={{ wrapMode: 'word', fg: theme.foreground }}
              >
                {line.length > 0 ? clipEvidenceLine(line, 120) : ' '}
              </text>
            )}
          />
        </box>
      ) : null}
    </HarnessBox>
  )
})
