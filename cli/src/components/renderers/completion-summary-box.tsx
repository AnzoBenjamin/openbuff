import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'

import type { CompletionSummaryContentBlock } from '../../types/chat'
import type { ChatTheme } from '../../types/theme-system'
import type { CompletionSummary } from '../../utils/completion-summary'

type Tone = 'secondary' | 'success' | 'error' | 'warning'

/**
 * Row labels. The label column carries the noun, so the row values are bare
 * descriptors ('2 edited') and no icon is needed to identify the row.
 */
const ROW_LABELS = {
  files: 'Files',
  hooks: 'Hooks',
  review: 'Review',
  tests: 'Tests',
  agents: 'Agents',
  errors: 'Errors',
} as const

/**
 * Shared label column: the longest label plus a two-column gutter, so every
 * value starts at the same offset. Derived rather than hardcoded so a longer
 * label added later cannot silently misalign the column. `.length` is correct
 * only because these labels are plain ASCII — a label with wide or combining
 * characters would need rendered-width math instead.
 */
const LABEL_COLUMN_WIDTH =
  Math.max(...Object.values(ROW_LABELS).map((label) => label.length)) + 2

const deriveTone = (summary: CompletionSummary): Tone => {
  const isBlockingVerdict =
    summary.reviewVerdict === 'BLOCKING' ||
    summary.reviewVerdict === 'NEEDS_WORK'
  const isWarningVerdict = summary.reviewVerdict === 'NON_BLOCKING'
  const hasFailed =
    summary.filesFailed > 0 ||
    summary.testFailed > 0 ||
    summary.hooksFailed > 0 ||
    summary.auxiliaryFailed > 0
  const hasUnconfirmed = summary.filesUnconfirmed > 0
  const hasRollbackIncomplete = summary.rollbackIncomplete > 0
  const hasRolledBack = summary.filesRolledBack > 0

  if (
    hasFailed ||
    hasUnconfirmed ||
    hasRollbackIncomplete ||
    isBlockingVerdict ||
    summary.errors > 0
  ) {
    return 'error'
  }
  if (hasRolledBack || isWarningVerdict) {
    return 'warning'
  }
  const hasSuccess =
    summary.filesEdited > 0 ||
    summary.testPassed > 0 ||
    summary.hooksPassed > 0 ||
    summary.auxiliaryCompleted > 0 ||
    summary.reviewVerdict === 'LOOKS_GOOD' ||
    summary.reviewVerdict === 'APPROVED'
  if (hasSuccess) return 'success'
  return 'secondary'
}

const statusColorForTone = (tone: Tone, theme: ChatTheme): string => {
  switch (tone) {
    case 'success':
      return theme.success
    case 'error':
      return theme.error
    case 'warning':
      return theme.warning
    default:
      return theme.secondary
  }
}

interface SummaryRowProps {
  label: string
  value: string
  tone: Tone
}

/**
 * One compact row: a muted, padded label column followed by the toned value.
 * Exactly two inline spans inside a single `<text>` — OpenTUI rejects nested
 * block elements inside text.
 */
const SummaryRow = ({ label, value, tone }: SummaryRowProps) => {
  const theme = useTheme()
  return (
    <text style={{ wrapMode: 'word' }}>
      <span style={{ fg: theme.muted }}>
        {label.padEnd(LABEL_COLUMN_WIDTH)}
      </span>
      <span style={{ fg: statusColorForTone(tone, theme) }}>{value}</span>
    </text>
  )
}

interface CompletionSummaryBoxProps {
  block: CompletionSummaryContentBlock
}

export const CompletionSummaryBox = memo(
  ({ block }: CompletionSummaryBoxProps) => {
    const summary = block.summary
    const tone = deriveTone(summary)

    const hasFiles =
      summary.filesEdited > 0 ||
      summary.filesFailed > 0 ||
      summary.filesUnconfirmed > 0 ||
      summary.filesRolledBack > 0 ||
      summary.rollbackIncomplete > 0
    const hasHooks =
      summary.hooksPassed > 0 ||
      summary.hooksFailed > 0 ||
      summary.hooksSkipped > 0
    const hasTests = summary.testPassed > 0 || summary.testFailed > 0
    const hasAux = summary.auxiliaryCompleted > 0 || summary.auxiliaryFailed > 0

    const filesTone: Tone =
      summary.filesFailed > 0 ||
      summary.rollbackIncomplete > 0 ||
      summary.filesUnconfirmed > 0
        ? 'error'
        : summary.filesRolledBack > 0
          ? 'warning'
          : 'success'
    const hooksTone: Tone = summary.hooksFailed > 0 ? 'error' : 'success'
    const testsTone: Tone = summary.testFailed > 0 ? 'error' : 'success'
    const auxTone: Tone = summary.auxiliaryFailed > 0 ? 'error' : 'success'

    // Row values are built inside each guarded branch below, so a hidden row's
    // string is never assembled.
    const buildFilesText = (): string => {
      const parts: string[] = []
      if (summary.filesEdited > 0) parts.push(`${summary.filesEdited} edited`)
      if (summary.filesFailed > 0) parts.push(`${summary.filesFailed} failed`)
      if (summary.filesUnconfirmed > 0)
        parts.push(`${summary.filesUnconfirmed} unconfirmed`)
      if (summary.filesRolledBack > 0)
        parts.push(`${summary.filesRolledBack} rolled back`)
      if (summary.rollbackIncomplete > 0)
        parts.push(`${summary.rollbackIncomplete} rollback incomplete`)
      return parts.join(', ')
    }
    const buildHooksText = (): string => {
      const parts: string[] = []
      if (summary.hooksPassed > 0) parts.push(`${summary.hooksPassed} passed`)
      if (summary.hooksFailed > 0) parts.push(`${summary.hooksFailed} failed`)
      if (summary.hooksSkipped > 0)
        parts.push(`${summary.hooksSkipped} skipped`)
      return parts.join(', ')
    }
    const buildTestsText = (): string => {
      const parts: string[] = []
      if (summary.testPassed > 0) parts.push(`${summary.testPassed} passed`)
      if (summary.testFailed > 0) parts.push(`${summary.testFailed} failed`)
      return parts.join(', ')
    }
    const buildAuxText = (): string =>
      `${summary.auxiliaryCompleted} completed${summary.auxiliaryFailed > 0 ? `, ${summary.auxiliaryFailed} failed` : ''}`
    const buildErrorsText = (): string =>
      `${summary.errors} error${summary.errors !== 1 ? 's' : ''}`
    const reviewTone: Tone =
      summary.reviewVerdict === 'BLOCKING' ||
      summary.reviewVerdict === 'NEEDS_WORK'
        ? 'error'
        : summary.reviewVerdict === 'NON_BLOCKING'
          ? 'warning'
          : 'success'

    return (
      <HarnessBox tone={tone} title="Run summary" gap={0} paddingBottom={0}>
        {hasFiles ? (
          <SummaryRow
            label={ROW_LABELS.files}
            value={buildFilesText()}
            tone={filesTone}
          />
        ) : null}
        {hasHooks ? (
          <SummaryRow
            label={ROW_LABELS.hooks}
            value={buildHooksText()}
            tone={hooksTone}
          />
        ) : null}
        {summary.reviewVerdict ? (
          <SummaryRow
            label={ROW_LABELS.review}
            value={summary.reviewVerdict}
            tone={reviewTone}
          />
        ) : null}
        {hasTests ? (
          <SummaryRow
            label={ROW_LABELS.tests}
            value={buildTestsText()}
            tone={testsTone}
          />
        ) : null}
        {hasAux ? (
          <SummaryRow
            label={ROW_LABELS.agents}
            value={buildAuxText()}
            tone={auxTone}
          />
        ) : null}
        {summary.errors > 0 ? (
          <SummaryRow
            label={ROW_LABELS.errors}
            value={buildErrorsText()}
            tone="error"
          />
        ) : null}
      </HarnessBox>
    )
  },
)
