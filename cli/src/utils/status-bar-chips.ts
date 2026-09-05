import stringWidth from 'string-width'

import { formatElapsedTime } from './format-elapsed-time'

import type { CompactionNotice } from '../types/chat'

export type StatusBarChipId =
  | 'context'
  | 'compaction'
  | 'index'
  | 'git'
  | 'model'
  | 'cost'
  | 'timer'

export type StatusBarChipTone = 'muted' | 'secondary' | 'warning' | 'error'

export type StatusBarChip = {
  id: StatusBarChipId
  label: string
  tone: StatusBarChipTone
}

export type StatusBarWidthSize = 'xs' | 'sm' | 'md' | 'lg'

/**
 * Canonical context-window usage for the context chip. Declared once here and
 * reused by the SDK event handler that produces it (`SetContextWindowUsageFn`,
 * which re-exports it), the chat state that holds it, the send-message hook
 * that threads the setter, and the status-bar component, so a later additive
 * field cannot go silently missing from one consumer.
 *
 * `compactionTriggerTokens` is the runtime's model-aware semantic-compaction
 * trigger budget and is optional: it is absent for events emitted before the
 * field existed, and the chip then renders exactly as it did before.
 *
 * It is NOT bounded by `max`: the event derives it from the raw model window
 * while `max` is clamped by an explicit `maxContextLength` override, and an
 * unknown window yields a flat fallback budget (see
 * `printModeContextWindowSchema`). `contextTriggerTokens` below is the single
 * place that reconciles the two for rendering.
 */
export type StatusBarContextUsage = {
  used: number
  max: number
  compactionTriggerTokens?: number
}

export type SelectStatusBarChipsInput = {
  widthSize: StatusBarWidthSize
  terminalWidth: number
  contextWindowUsage?: StatusBarContextUsage | null
  sessionCostCents?: number | null
  modelName?: string | null
  diffStats?: { modified: number; added: number; deleted: number } | null
  /**
   * Index status. At 'xs' an error label is abbreviated to its first word plus
   * '!', so the label should lead with its subject (e.g. 'idx failed: …').
   */
  indexChip?: { label: string; tone: 'secondary' | 'warning' | 'error' } | null
  /** Whether the scroll-to-bottom button shares the row with the chips. */
  showScrollButton?: boolean
  /**
   * Whether that button renders its compact (glyph-only) form, which is three
   * columns instead of ten. Only consulted while `showScrollButton` is set.
   */
  scrollButtonCompact?: boolean
  /**
   * Accumulated context-compaction notice for the current turn, or null when
   * nothing has been compacted. `degraded` marks a compaction that did not fit
   * the budget or that stopped reclaiming space, and `pending` marks a pass
   * that is running right now (the chip renders even at `count: 0`). `pending`
   * is only honored while `isActive`: an aborted turn never delivers the
   * settling event, so an idle run must not keep claiming a live pass. `pending`
   * is derived from the notice's `pendingRunIds` set, which records EVERY run
   * with an unsettled pass — root and nested alike — so a subagent's compaction
   * keeps this shared chip live (without ever rendering a root-level card of its
   * own) until that run settles. A notice produced before that set existed can
   * carry a bare `pending: true` instead; the producers keep that flag, and this
   * selector reads `pending` alone, so the legacy shape renders identically.
   */
  compactionNotice?: CompactionNotice | null
  elapsedSeconds: number
  showTimer: boolean
  showStop: boolean
  isActive: boolean // waiting or streaming
}

const PROVIDER_PREFIX = /^(openai|anthropic|google|openrouter)\//

/** Fraction of the terminal width the chip cluster may occupy. */
const WIDTH_BUDGET_RATIO = 0.4
/** Floor so very narrow terminals still get room for one chip. */
const MIN_WIDTH_BUDGET = 8
/** Columns reserved for the stop-button hint rendered beside the chips. */
export const STOP_BUTTON_WIDTH = 7
/**
 * Columns reserved for the scroll-to-bottom button rendered beside the chips.
 * `SCROLL_BUTTON_WIDTH` in components/scroll-to-bottom-button.tsx is the source
 * of truth ('↓ Bottom' plus one column of padding per side); duplicated here so
 * this util does not import a component module.
 */
export const SCROLL_BUTTON_RESERVATION = 10
/**
 * Columns reserved for the compact (narrow-terminal) scroll-to-bottom button.
 * `SCROLL_BUTTON_COMPACT_WIDTH` in components/scroll-to-bottom-button.tsx is the
 * source of truth (the glyph plus one column of padding per side); duplicated
 * here for the same reason as the expanded reservation, so reserving the wider
 * form at 'xs'/'sm' cannot silently cost the chips seven columns.
 */
export const SCROLL_BUTTON_COMPACT_RESERVATION = 3
/** Columns rendered between two adjacent chips. */
const CHIP_SEPARATOR_WIDTH = 3
/** Suffix appended to a truncated status chip label. */
const LABEL_ELLIPSIS = '…'

export function formatStatusTokenCount(tokens: number): string {
  // Every threshold compares the rounded count, so a fractional value just
  // below 1_000 renders as '1k' instead of a 4-column '1000'.
  const roundedTokens = Math.round(tokens)
  if (roundedTokens < 1_000) return roundedTokens.toString()
  if (roundedTokens < 1_000_000) {
    const value = roundedTokens / 1_000
    if (value < 100) return `${value.toFixed(1).replace(/\.0$/, '')}k`
    const roundedThousands = Math.round(value)
    if (roundedThousands < 1_000) return `${roundedThousands}k`
  }
  return `${(roundedTokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

/** Shared because constructing a segmenter per truncation is needlessly costly. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

/** Truncate to a rendered width, marking the cut with an ellipsis when it fits. */
const truncateStatusLabel = (label: string, maxChars: number): string => {
  if (stringWidth(label) <= maxChars) return label

  // Below the ellipsis width there is no room to mark the truncation without
  // exceeding maxChars, so hard-truncate instead.
  const withEllipsis = maxChars >= stringWidth(LABEL_ELLIPSIS)
  const budget = Math.max(
    0,
    withEllipsis ? maxChars - stringWidth(LABEL_ELLIPSIS) : maxChars,
  )
  let truncated = ''
  let width = 0
  // Grapheme clusters rather than code points, so a ZWJ emoji sequence or a
  // combining mark is never cut in half (which would leave a dangling joiner
  // or reattach the mark to the ellipsis).
  for (const { segment: cluster } of GRAPHEME_SEGMENTER.segment(label)) {
    const clusterWidth = stringWidth(cluster)
    if (width + clusterWidth > budget) break
    truncated += cluster
    width += clusterWidth
  }
  return withEllipsis ? `${truncated}${LABEL_ELLIPSIS}` : truncated
}

export function shortenStatusModelName(
  modelName: string,
  maxChars: number,
): string {
  return truncateStatusLabel(modelName.replace(PROVIDER_PREFIX, ''), maxChars)
}

/**
 * Sanitized compaction trigger in tokens, or null when there is nothing
 * meaningful to report. Numbers arriving from persisted state are coerced
 * defensively before being divided by `max`, and a trigger at or above `max` is
 * suppressed rather than pinned to the end of the bar: the unknown-window
 * fallback budget can exceed a small configured window, where a marker at 100%
 * would be actively misleading.
 */
const contextTriggerTokens = (usage: StatusBarContextUsage): number | null => {
  const trigger = usage.compactionTriggerTokens
  if (typeof trigger !== 'number' || !Number.isFinite(trigger)) return null
  if (trigger <= 0) return null
  if (!(usage.max > 0) || trigger >= usage.max) return null
  return trigger
}

/** Trigger position as a 0..100 percent of the window, or null when unknown. */
const contextTriggerPct = (usage: StatusBarContextUsage): number | null => {
  const trigger = contextTriggerTokens(usage)
  if (trigger == null) return null
  return Math.min(100, Math.max(0, Math.round((trigger / usage.max) * 100)))
}

/**
 * Pure in its arguments: the warning threshold is the compaction trigger when
 * one is known (that is the point at which the next step may compact) and the
 * fixed 70 otherwise. The 90 error threshold is fixed either way.
 */
const contextTone = (
  pct: number,
  triggerPct?: number | null,
): StatusBarChipTone => {
  if (pct >= 90) return 'error'
  if (pct >= (triggerPct ?? 70)) return 'warning'
  return 'secondary'
}

/** Bare percent label, shared by the full labels and the overflow-shorten step. */
const percentLabel = (pct: number): string => `${pct}%`

/**
 * 'sm' prefixes the percent so it is not mistaken for part of a neighbouring
 * chip (a bare '48%' beside a git '~3 +1' chip reads ambiguously).
 */
const contextPercentLabel = (pct: number): string => `ctx ${pct}%`

/**
 * '<used>/<max>' prefix for the sizes wide enough to render token counts, plus
 * a '⇲<trigger>' suffix when `triggerTokens` is supplied. The glyph is the one
 * the compaction chip already uses, so it reads as the same concept.
 */
const contextCountsPrefix = (
  usage: StatusBarContextUsage,
  triggerTokens?: number | null,
): string => {
  const counts = `${formatStatusTokenCount(usage.used)}/${formatStatusTokenCount(usage.max)}`
  return triggerTokens == null
    ? counts
    : `${counts} ⇲${formatStatusTokenCount(triggerTokens)}`
}

/**
 * `pct` must already be clamped to 0..100 by the caller. A supplied
 * `triggerPct` marks its cell with '│' INSTEAD of the glyph that cell would
 * otherwise get, so the rendered width is unchanged. The marker is drawn even
 * when usage has already passed it: that the threshold was crossed is the
 * useful signal.
 */
const buildUsageBar = (
  pct: number,
  length: number,
  triggerPct?: number | null,
): string => {
  const filled = Math.round((pct / 100) * length)
  const markerIndex =
    triggerPct == null
      ? -1
      : Math.min(
          length - 1,
          Math.max(0, Math.floor((triggerPct / 100) * length)),
        )
  let bar = ''
  for (let index = 0; index < length; index++) {
    bar += index === markerIndex ? '│' : index < filled ? '█' : '░'
  }
  return bar
}

/** Bar cell count, or null for the sizes that render the percent only. */
const contextBarLength = (widthSize: StatusBarWidthSize): number | null => {
  if (widthSize === 'lg') return 10
  if (widthSize === 'md') return 6
  return null
}

/** '<bar> <pct>', or the bare percent for sizes that render no bar. */
const barPercentLabel = (
  widthSize: StatusBarWidthSize,
  pct: number,
  triggerPct?: number | null,
): string => {
  const barLength = contextBarLength(widthSize)
  return barLength == null
    ? percentLabel(pct)
    : `${buildUsageBar(pct, barLength, triggerPct)} ${percentLabel(pct)}`
}

/**
 * Usage percent at which a size that can render token counts starts doing so,
 * or null for the sizes that never render them. 'md' waits until 80% (its bar
 * is narrower, so the counts cost proportionally more of the row) while 'lg'
 * shows them from 70%.
 */
const contextCountsThreshold = (
  widthSize: StatusBarWidthSize,
): number | null => {
  if (widthSize === 'lg') return 70
  if (widthSize === 'md') return 80
  return null
}

/**
 * Progressively shorter context labels for the overflow loop, widest first, so
 * a token-count label gives up its compaction-trigger suffix, then its counts,
 * before its bar instead of collapsing straight to the bare percent. Sizes that
 * render neither counts nor a bar have fewer entries rather than repeating one.
 *
 * INVARIANT: the first entry is exactly the widest form buildContextLabel
 * renders, so the two cannot drift; adding a wider form to one and not the
 * other silently breaks overflow shortening. Both are exported so a test can
 * pin that invariant directly.
 */
export const contextLabelFallbacks = (
  widthSize: StatusBarWidthSize,
  usage: StatusBarContextUsage,
  pct: number,
): [string, ...string[]] => {
  const triggerTokens = contextTriggerTokens(usage)
  const barPercent = barPercentLabel(widthSize, pct, contextTriggerPct(usage))
  if (contextCountsThreshold(widthSize) != null) {
    return [
      `${contextCountsPrefix(usage, triggerTokens)} ${barPercent}`,
      `${contextCountsPrefix(usage)} ${barPercent}`,
      barPercent,
      percentLabel(pct),
    ]
  }
  if (widthSize === 'sm') {
    return [contextPercentLabel(pct), percentLabel(pct)]
  }
  return [percentLabel(pct)]
}

/** Widest context label for a size; see the invariant on contextLabelFallbacks. */
export const buildContextLabel = (
  widthSize: StatusBarWidthSize,
  usage: StatusBarContextUsage,
  pct: number,
): string => {
  const barPercent = barPercentLabel(widthSize, pct, contextTriggerPct(usage))
  const countsThreshold = contextCountsThreshold(widthSize)

  if (countsThreshold != null) {
    return pct >= countsThreshold
      ? `${contextCountsPrefix(usage, contextTriggerTokens(usage))} ${barPercent}`
      : barPercent
  }

  return widthSize === 'sm' ? contextPercentLabel(pct) : barPercent
}

/**
 * Compaction notice label: the count alone at the narrow sizes, and a worded
 * form at 'md'/'lg' that distinguishes a semantic compaction from an emergency
 * mechanical trim. A pass that is still running reports the live state instead
 * of a count, which may still be 0 when nothing has completed yet.
 *
 * A live pass with a usable `progressPercent` reports it at 'md'/'lg' ('⇲
 * compacting 62%') so the chip shows real movement rather than an indefinite
 * ellipsis. The percent is best-effort telemetry, so a missing, non-finite or
 * zero value falls back to the previous ellipsis label, and the narrow sizes —
 * which have no room for it — keep their exact previous labels.
 */
const buildCompactionLabel = (
  widthSize: StatusBarWidthSize,
  notice: Pick<
    CompactionNotice,
    'count' | 'action' | 'pending' | 'progressPercent'
  >,
): string => {
  const narrow = widthSize === 'xs' || widthSize === 'sm'
  if (notice.pending) {
    if (narrow) return '⇲ …'
    const percent = notice.progressPercent
    return typeof percent === 'number' && Number.isFinite(percent) && percent > 0
      ? `⇲ compacting ${Math.min(100, Math.round(percent))}%`
      : '⇲ compacting…'
  }
  if (narrow) return `⇲ ${notice.count}`
  const verb = notice.action === 'mechanical_trim' ? 'trimmed' : 'compacted'
  return `⇲ ${verb} ×${notice.count}`
}

/**
 * Only reached for a positive cost: a zero or negative sessionCostCents hides
 * the chip entirely, so there is no '$0.00' or '$-0.0100' case here. Sub-cent
 * costs render with four decimals, and anything smaller than that precision
 * renders as '<$0.0001' so a tiny non-zero cost stays distinguishable from the
 * hidden zero case rather than showing a misleading '$0.0000'.
 */
const formatCostLabel = (sessionCostCents: number): string => {
  const dollars = sessionCostCents / 100
  if (dollars >= 0.01) return `$${dollars.toFixed(2)}`
  const fixed = dollars.toFixed(4)
  return fixed === '0.0000' ? '<$0.0001' : `$${fixed}`
}

const formatGitLabel = (diffStats: {
  modified: number
  added: number
  deleted: number
}): string | null => {
  const { modified, added, deleted } = diffStats
  if (modified + added + deleted <= 0) return null
  const parts: string[] = []
  if (modified > 0) parts.push(`~${modified}`)
  if (added > 0) parts.push(`+${added}`)
  if (deleted > 0) parts.push(`-${deleted}`)
  return parts.join(' ')
}

/** 'xs' has no room for a full error label, so keep only its subject word. */
const abbreviateIndexErrorLabel = (label: string): string => {
  const firstSpace = label.indexOf(' ')
  return `${firstSpace === -1 ? label : label.slice(0, firstSpace)}!`
}

/** Only 'lg' and 'md' render the model chip. */
const modelMaxChars = (widthSize: 'lg' | 'md'): number =>
  widthSize === 'lg' ? 16 : 12

/** Rendered width of a chip cluster, including the inter-chip separators. */
export function statusBarClusterWidth(chips: StatusBarChip[]): number {
  if (chips.length === 0) return 0
  const separators = CHIP_SEPARATOR_WIDTH * (chips.length - 1)
  return chips.reduce((sum, chip) => sum + stringWidth(chip.label), separators)
}

/**
 * Columns available to the chip cluster for a given terminal width.
 * `scrollButtonCompact` selects the narrow three-column reservation, matching
 * the form the button actually renders at 'xs'/'sm'.
 */
export function statusBarChipBudget(
  terminalWidth: number,
  showStop: boolean,
  showScrollButton = false,
  scrollButtonCompact = false,
): number {
  const scrollReservation = !showScrollButton
    ? 0
    : scrollButtonCompact
      ? SCROLL_BUTTON_COMPACT_RESERVATION
      : SCROLL_BUTTON_RESERVATION
  const reservedColumns = (showStop ? STOP_BUTTON_WIDTH : 0) + scrollReservation
  const available =
    Math.floor(terminalWidth * WIDTH_BUDGET_RATIO) - reservedColumns
  // The floor applies after the stop-hint and scroll-button reservations so one
  // chip still fits in a narrow terminal, then the result is clamped to the
  // columns actually left beside those two controls so the cluster can never
  // overflow the real row width.
  return Math.max(
    0,
    Math.min(
      Math.max(MIN_WIDTH_BUDGET, available),
      terminalWidth - reservedColumns,
    ),
  )
}

const removeChip = (chips: StatusBarChip[], id: StatusBarChipId): boolean => {
  const index = chips.findIndex((chip) => chip.id === id)
  if (index === -1) return false
  chips.splice(index, 1)
  return true
}

export function selectStatusBarChips(input: SelectStatusBarChipsInput): {
  chips: StatusBarChip[]
} {
  const {
    widthSize,
    terminalWidth,
    contextWindowUsage,
    sessionCostCents,
    modelName,
    diffStats,
    indexChip,
    compactionNotice,
    elapsedSeconds,
    showTimer,
    showStop,
    showScrollButton,
    scrollButtonCompact,
    isActive,
  } = input

  const chips: StatusBarChip[] = []
  let contextPct: number | null = null
  let contextUsage: StatusBarContextUsage | null = null

  const hasIndexError = indexChip?.tone === 'error'
  const omitContextForIndexError = widthSize === 'xs' && hasIndexError

  if (
    contextWindowUsage &&
    contextWindowUsage.max > 0 &&
    !omitContextForIndexError
  ) {
    // Clamped so an over-full context (used > max) renders '100%' with a full
    // bar instead of an out-of-range percent such as '150%'.
    contextPct = Math.min(
      100,
      Math.max(
        0,
        Math.round((contextWindowUsage.used / contextWindowUsage.max) * 100),
      ),
    )
    chips.push({
      id: 'context',
      label: buildContextLabel(widthSize, contextWindowUsage, contextPct),
      tone: contextTone(contextPct, contextTriggerPct(contextWindowUsage)),
    })
    contextUsage = contextWindowUsage
  }

  // A pending pass can only be live while the run is: an abort mid-compaction
  // never delivers `settled` or a result, so once the run is idle the chip
  // falls back to the settled form instead of reporting a compaction that is
  // no longer running. A notice that never counted a completed pass then has
  // nothing to report and is dropped entirely rather than rendering '⇲ 0'.
  const compactionPending = compactionNotice?.pending === true && isActive
  if (compactionNotice && (compactionPending || compactionNotice.count > 0)) {
    chips.push({
      id: 'compaction',
      label: buildCompactionLabel(widthSize, {
        count: compactionNotice.count,
        action: compactionNotice.action,
        pending: compactionPending,
        ...(compactionNotice.progressPercent !== undefined && {
          progressPercent: compactionNotice.progressPercent,
        }),
      }),
      // A live pass reads as in-progress, not as a failed one: a degraded
      // earlier pass only tones the chip red once it has settled.
      tone:
        compactionNotice.degraded && !compactionPending ? 'error' : 'warning',
    })
  }

  if (indexChip) {
    chips.push({
      id: 'index',
      label:
        widthSize === 'xs' && hasIndexError
          ? abbreviateIndexErrorLabel(indexChip.label)
          : indexChip.label,
      tone: indexChip.tone,
    })
  }

  const gitLabel = diffStats ? formatGitLabel(diffStats) : null
  if (
    gitLabel != null &&
    widthSize !== 'xs' &&
    !(widthSize === 'sm' && indexChip != null)
  ) {
    chips.push({ id: 'git', label: gitLabel, tone: 'secondary' })
  }

  if (modelName && (widthSize === 'lg' || widthSize === 'md')) {
    chips.push({
      id: 'model',
      label: shortenStatusModelName(modelName, modelMaxChars(widthSize)),
      tone: 'muted',
    })
  }

  const hasSessionCost = sessionCostCents != null && sessionCostCents > 0
  if (widthSize === 'lg' && hasSessionCost) {
    chips.push({
      id: 'cost',
      label: formatCostLabel(sessionCostCents),
      tone: 'muted',
    })
  }

  const allowTimer =
    showTimer && elapsedSeconds > 0 && !(widthSize === 'xs' && showStop)
  if (allowTimer) {
    chips.push({
      id: 'timer',
      label: formatElapsedTime(elapsedSeconds),
      tone: 'secondary',
    })
  }

  const budget = statusBarChipBudget(
    terminalWidth,
    showStop,
    showScrollButton,
    scrollButtonCompact,
  )

  while (statusBarClusterWidth(chips) > budget) {
    if (removeChip(chips, 'cost')) continue
    if (removeChip(chips, 'model')) continue
    if (removeChip(chips, 'git')) continue

    // Mid-priority: the compaction notice is worth less than the context usage
    // and the index readiness chip, but more than the model/cost/git chips.
    if (removeChip(chips, 'compaction')) continue

    const contextChip = chips.find((chip) => chip.id === 'context')
    if (contextChip && contextPct != null && contextUsage != null) {
      // Step down one rendered form at a time (token counts first, then the
      // bar) so an intermediate label that would still fit is not skipped.
      // Compared by rendered width instead of scanning for bar glyphs so
      // shortening keeps working if the bar characters change.
      const shorter = contextLabelFallbacks(
        widthSize,
        contextUsage,
        contextPct,
      ).find((label) => stringWidth(label) < stringWidth(contextChip.label))
      if (shorter != null) {
        contextChip.label = shorter
        continue
      }
    }

    // An idle timer is worth less than the context percent, so it goes here; a
    // live timer outranks context and is only given up at the last-resort step
    // below.
    if (!isActive && removeChip(chips, 'timer')) continue

    // The run is still active here, so context always goes before the timer:
    // the elapsed time of a live run matters more than the usage percent, and
    // dropping context first also leaves room for an index chip. Unconditional
    // on purpose so the priority does not flip when the stop hint is hidden.
    if (removeChip(chips, 'context')) continue

    // Last resort: drop the timer even during an active run so a warning or
    // error index chip still fits instead of overflowing the width budget.
    if (removeChip(chips, 'timer')) continue

    // The index chip is otherwise never dropped, so clamp a long caller-supplied
    // label rather than letting it overflow the row. Every other chip has been
    // removed by this point, so the whole budget belongs to it. A zero budget
    // leaves no room for even one character, and a one-column budget leaves
    // room for the ellipsis alone, so both clamps drop the chip instead of
    // keeping an information-free label that renderers would draw as stray
    // padding or a dangling separator.
    const remainingIndexChip = chips.find((chip) => chip.id === 'index')
    if (remainingIndexChip) {
      const clamped = truncateStatusLabel(remainingIndexChip.label, budget)
      if (clamped === '' || clamped === LABEL_ELLIPSIS) {
        removeChip(chips, 'index')
        continue
      }
      if (clamped !== remainingIndexChip.label) {
        remainingIndexChip.label = clamped
        continue
      }
    }

    // Unreachable, kept as a termination guard: every branch above removes or
    // shortens a chip and loops, and truncateStatusLabel only returns its input
    // unchanged when the label already fits the budget.
    break
  }

  // Chips are pushed in render order (context, compaction, index, git, model,
  // cost, timer) and the overflow loop only removes or shortens them, so the
  // array is already ordered here.
  return { chips }
}
