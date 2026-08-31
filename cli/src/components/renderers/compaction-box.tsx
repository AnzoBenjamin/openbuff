import { memo } from 'react'

import { HarnessBox } from './harness-box'
import { useTheme } from '../../hooks/use-theme'
import { CLI_LIVE_SESSION_ID } from '../../types/chat'
import { formatStatusTokenCount } from '../../utils/status-bar-chips'

import type {
  CompactionCategoryDelta,
  CompactionContentBlock,
} from '../../types/chat'
import type { ChatTheme } from '../../types/theme-system'

type Tone = 'secondary' | 'warning' | 'error'

/**
 * Blocks are persisted and replayed, so a field can come back missing,
 * non-finite, or negative. Mirrors `sanitizeLedgerNumber` in
 * common/src/util/context-budget.ts: coerce to a safe non-negative integer
 * instead of rendering NaN or throwing.
 */
const sanitizeCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0

/**
 * Exhaustive by construction: a new ContextCategory fails to compile here
 * rather than rendering its raw key.
 */
const CATEGORY_LABEL: Record<CompactionCategoryDelta['category'], string> = {
  toolResults: 'tool results',
  todos: 'todos',
  fileReads: 'file reads',
  subagents: 'subagents',
  userAssistantMessages: 'conversation',
}

/** Falls back to the raw key for a category a persisted block no longer maps. */
const categoryLabel = (category: string): string =>
  category in CATEGORY_LABEL
    ? CATEGORY_LABEL[category as CompactionCategoryDelta['category']]
    : category

/**
 * A pending pass is only live in the process that created it. The abort and
 * turn-end paths rewrite a pass that never reported a result to
 * `status: 'interrupted'`, so this stamp is defense in depth for a crash that
 * ran no teardown at all: such a block is replayed with an absent or foreign
 * `liveSessionId` and must render as an interrupted pass rather than a
 * permanently "compacting" card.
 */
const isLiveCompaction = (block: CompactionContentBlock): boolean =>
  block.status === 'pending' && block.liveSessionId === CLI_LIVE_SESSION_ID

/** Shown for a pass that ended before it reported a result. */
const INTERRUPTED_TEXT = 'Interrupted before this pass reported a result.'

/**
 * The pending/interrupted/unsettled triple that both the tone and every
 * rendered line depend on.
 */
type CompactionPresentation = {
  unsettled: boolean
  pending: boolean
  interrupted: boolean
}

/**
 * Single source of truth for pending vs interrupted, consumed by both
 * {@link deriveTone} and the render path so the chosen tone and the rendered
 * lines cannot drift apart.
 *
 * `unsettled` covers a live pass, a terminated one and a replayed pending one:
 * none has result fields, so the result lines stay suppressed for all. A
 * pending block that is not live in THIS process (absent or foreign
 * `liveSessionId`, i.e. a replayed transcript) is deliberately presented as
 * interrupted — see {@link isLiveCompaction}.
 */
const derivePresentation = (
  block: CompactionContentBlock,
): CompactionPresentation => {
  const unsettled = block.status === 'pending' || block.status === 'interrupted'
  const pending = block.status === 'pending' && isLiveCompaction(block)
  return { unsettled, pending, interrupted: unsettled && !pending }
}

const deriveTone = (
  block: CompactionContentBlock,
  presentation: CompactionPresentation,
): Tone => {
  // A pass that is still running has no result to judge yet, so it always
  // reads as neutral regardless of `action`; a pass that never settled reads
  // as a warning.
  if (presentation.interrupted) return 'warning'
  if (presentation.pending) return 'secondary'
  if (block.fitsBudget === false) return 'error'
  const noProgress = block.consecutiveNoProgressCompactions
  if (
    (noProgress !== undefined && sanitizeCount(noProgress) >= 2) ||
    block.action === 'mechanical_trim' ||
    block.escalated === true
  ) {
    return 'warning'
  }
  return 'secondary'
}

const statusColorForTone = (tone: Tone, theme: ChatTheme): string => {
  switch (tone) {
    case 'error':
      return theme.error
    case 'warning':
      return theme.warning
    default:
      return theme.secondary
  }
}

interface CompactionBoxProps {
  block: CompactionContentBlock
}

export const CompactionBox = memo(({ block }: CompactionBoxProps) => {
  const theme = useTheme()
  const { unsettled, pending, interrupted } = derivePresentation(block)
  const tone = deriveTone(block, { unsettled, pending, interrupted })
  const title = pending
    ? 'Compacting context…'
    : interrupted
      ? 'Compaction interrupted'
      : block.action === 'mechanical_trim'
        ? 'Context trimmed (emergency)'
        : 'Context compacted'

  const beforeTokens = sanitizeCount(block.beforeTokens)
  const afterTokens = sanitizeCount(block.afterTokens)
  const reductionPercent = Math.min(100, sanitizeCount(block.reductionPercent))
  const headline = `${formatStatusTokenCount(beforeTokens)} → ${formatStatusTokenCount(afterTokens)} tokens (−${reductionPercent}%)`
  const messagesText = `  ${sanitizeCount(block.beforeMessages)} → ${sanitizeCount(block.afterMessages)} messages`
  // Live state: the result fields are not known yet, so only the current size
  // and (when reported) the target it is compacting toward are shown.
  const pendingText =
    block.targetBudgetTokens === undefined
      ? `${formatStatusTokenCount(beforeTokens)} tokens`
      : `${formatStatusTokenCount(beforeTokens)} tokens → target ${formatStatusTokenCount(sanitizeCount(block.targetBudgetTokens))}`

  const categoryDeltas = Array.isArray(block.categoryDeltas)
    ? block.categoryDeltas
    : []

  const showBudget =
    block.triggerBudgetTokens !== undefined &&
    block.targetBudgetTokens !== undefined
  const budgetText = showBudget
    ? `Window ${
        block.resolvedContextWindowTokens === undefined
          ? 'unknown'
          : formatStatusTokenCount(
              sanitizeCount(block.resolvedContextWindowTokens),
            )
      } · trigger ${formatStatusTokenCount(
        sanitizeCount(block.triggerBudgetTokens),
      )} · target ${formatStatusTokenCount(
        sanitizeCount(block.targetBudgetTokens),
      )}`
    : ''

  const shortfallText =
    block.shortfallTokens === undefined
      ? 'Still over budget'
      : `Still over budget by ${formatStatusTokenCount(sanitizeCount(block.shortfallTokens))} tokens`

  const noProgress = block.consecutiveNoProgressCompactions
  const showThrash = noProgress !== undefined && sanitizeCount(noProgress) >= 2
  const thrashText = `Compaction is not reclaiming space (${sanitizeCount(noProgress)} consecutive low-yield passes)`

  const reason = typeof block.reason === 'string' ? block.reason.trim() : ''
  const recovery =
    typeof block.recovery === 'string' ? block.recovery.trim() : ''
  const memoryText = block.retainedKnowledgeMemory
    ? 'Knowledge memory retained'
    : 'No knowledge memory retained'

  return (
    <HarnessBox tone={tone} title={title} gap={0} paddingBottom={1}>
      {unsettled ? (
        <text
          style={{
            wrapMode: 'word',
            fg: pending ? theme.secondary : theme.warning,
          }}
        >
          {pendingText}
        </text>
      ) : (
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          <span style={{ fg: statusColorForTone(tone, theme) }}>
            {headline}
          </span>
          <span style={{ fg: theme.muted }}>{messagesText}</span>
        </text>
      )}
      {categoryDeltas.length > 0
        ? categoryDeltas.map((delta, index) => (
            <text
              key={`category-${index}-${delta.category}`}
              style={{ wrapMode: 'word', fg: theme.muted }}
            >
              {`  ${categoryLabel(delta.category)}  ${formatStatusTokenCount(sanitizeCount(delta.beforeTokens))} → ${formatStatusTokenCount(sanitizeCount(delta.afterTokens))}`}
            </text>
          ))
        : null}
      {unsettled ? null : (
        <text
          style={{
            wrapMode: 'word',
            fg: block.retainedKnowledgeMemory ? theme.success : theme.warning,
          }}
        >
          {memoryText}
        </text>
      )}
      {interrupted ? (
        <text style={{ wrapMode: 'word', fg: theme.muted }}>
          {INTERRUPTED_TEXT}
        </text>
      ) : null}
      {showBudget ? (
        <text style={{ wrapMode: 'word', fg: theme.muted }}>{budgetText}</text>
      ) : null}
      {block.fitsBudget === false ? (
        <text style={{ wrapMode: 'word', fg: theme.error }}>
          {shortfallText}
        </text>
      ) : null}
      {showThrash ? (
        <text style={{ wrapMode: 'word', fg: theme.warning }}>
          {thrashText}
        </text>
      ) : null}
      {reason ? (
        <text style={{ wrapMode: 'word', fg: theme.muted }}>{reason}</text>
      ) : null}
      {recovery && !unsettled ? (
        <text style={{ wrapMode: 'word', fg: theme.foreground }}>
          {recovery}
        </text>
      ) : null}
    </HarnessBox>
  )
})
