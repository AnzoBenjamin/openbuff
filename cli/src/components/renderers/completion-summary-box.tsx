import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'

import type { CompletionSummaryContentBlock } from '../../types/chat'
import type { ChatTheme } from '../../types/theme-system'
import type { CompletionSummary } from '../../utils/completion-summary'

type Tone = 'secondary' | 'success' | 'error' | 'warning' | 'info'

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
    case 'info':
      return theme.info
    default:
      return theme.secondary
  }
}

const reviewIcon = (verdict: string | null): string => {
  if (verdict === 'BLOCKING' || verdict === 'NEEDS_WORK') return '🔴'
  if (verdict === 'NON_BLOCKING') return '🟡'
  if (verdict === 'LOOKS_GOOD' || verdict === 'APPROVED') return '🟢'
  return '🟢'
}

interface CompletionSummaryBoxProps {
  block: CompletionSummaryContentBlock
}

export const CompletionSummaryBox = memo(
  ({ block }: CompletionSummaryBoxProps) => {
    const theme = useTheme()
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

    const filesText = (() => {
      const parts: string[] = []
      if (summary.filesEdited > 0)
        parts.push(
          `${summary.filesEdited} file${summary.filesEdited !== 1 ? 's' : ''} edited`,
        )
      if (summary.filesFailed > 0) parts.push(`${summary.filesFailed} failed`)
      if (summary.filesUnconfirmed > 0)
        parts.push(`${summary.filesUnconfirmed} unconfirmed`)
      if (summary.filesRolledBack > 0)
        parts.push(`${summary.filesRolledBack} rolled back`)
      if (summary.rollbackIncomplete > 0)
        parts.push(`${summary.rollbackIncomplete} rollback incomplete`)
      return parts.join(', ')
    })()
    const hooksText = (() => {
      const parts: string[] = []
      if (summary.hooksPassed > 0) parts.push(`${summary.hooksPassed} passed`)
      if (summary.hooksFailed > 0) parts.push(`${summary.hooksFailed} failed`)
      if (summary.hooksSkipped > 0)
        parts.push(`${summary.hooksSkipped} skipped`)
      return `Hooks: ${parts.join(', ')}`
    })()
    const testsText = (() => {
      let part = 'Tests: '
      if (summary.testPassed > 0) part += `${summary.testPassed} passed`
      if (summary.testFailed > 0) {
        if (summary.testPassed > 0) part += ', '
        part += `${summary.testFailed} failed`
      }
      return part
    })()
    const auxText = `${summary.auxiliaryCompleted} auxiliary agent${summary.auxiliaryCompleted === 1 ? '' : 's'} completed${summary.auxiliaryFailed > 0 ? `, ${summary.auxiliaryFailed} failed` : ''}`
    const errorsText = `${summary.errors} error${summary.errors !== 1 ? 's' : ''}`
    const reviewTone: Tone =
      summary.reviewVerdict === 'BLOCKING' ||
      summary.reviewVerdict === 'NEEDS_WORK'
        ? 'error'
        : summary.reviewVerdict === 'NON_BLOCKING'
          ? 'warning'
          : 'success'

    return (
      <HarnessBox tone={tone} gap={1} paddingBottom={1}>
        {hasFiles ? (
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            <span style={{ fg: statusColorForTone(filesTone, theme) }}>
              {filesTone === 'error'
                ? '❌'
                : filesTone === 'warning'
                  ? '⚠️'
                  : '✅'}
            </span>
            <span style={{ fg: theme.foreground }}>{` ${filesText}`}</span>
          </text>
        ) : null}
        {hasHooks ? (
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            <span style={{ fg: statusColorForTone(hooksTone, theme) }}>
              {hooksTone === 'error' ? '❌' : '✅'}
            </span>
            <span style={{ fg: theme.foreground }}>{` ${hooksText}`}</span>
          </text>
        ) : null}
        {summary.reviewVerdict ? (
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            <span style={{ fg: theme.foreground }}>Reviewed:</span>
            <span
              style={{ fg: statusColorForTone(reviewTone, theme) }}
            >{` ${reviewIcon(summary.reviewVerdict)}`}</span>
            <span
              style={{ fg: theme.foreground }}
            >{` ${summary.reviewVerdict}`}</span>
          </text>
        ) : null}
        {hasTests ? (
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            <span style={{ fg: statusColorForTone(testsTone, theme) }}>
              {testsTone === 'error' ? '❌' : '✅'}
            </span>
            <span style={{ fg: theme.foreground }}>{` ${testsText}`}</span>
          </text>
        ) : null}
        {hasAux ? (
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            <span style={{ fg: statusColorForTone(auxTone, theme) }}>
              {auxTone === 'error' ? '⚠️' : '✅'}
            </span>
            <span style={{ fg: theme.foreground }}>{` ${auxText}`}</span>
          </text>
        ) : null}
        {summary.errors > 0 ? (
          <text style={{ wrapMode: 'word', fg: theme.foreground }}>
            <span style={{ fg: theme.error }}>❌</span>
            <span style={{ fg: theme.foreground }}>{` ${errorsText}`}</span>
          </text>
        ) : null}
      </HarnessBox>
    )
  },
)
