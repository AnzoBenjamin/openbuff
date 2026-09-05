import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'

import {
  buildContextLabel,
  contextLabelFallbacks,
  formatStatusTokenCount,
  SCROLL_BUTTON_COMPACT_RESERVATION,
  SCROLL_BUTTON_RESERVATION,
  selectStatusBarChips,
  shortenStatusModelName,
  statusBarChipBudget,
  statusBarClusterWidth,
  STOP_BUTTON_WIDTH,
  type SelectStatusBarChipsInput,
  type StatusBarChip,
  type StatusBarContextUsage,
} from '../status-bar-chips'

const full = {
  contextWindowUsage: { used: 96400, max: 200000 }, // 48%
  sessionCostCents: 12,
  modelName: 'anthropic/claude-sonnet-4-20250514',
  diffStats: { modified: 3, added: 2, deleted: 0 },
  indexChip: null,
  elapsedSeconds: 12,
  showTimer: true,
  showStop: true,
  isActive: true,
} satisfies Omit<SelectStatusBarChipsInput, 'widthSize' | 'terminalWidth'>

const indexChipVariants: SelectStatusBarChipsInput['indexChip'][] = [
  null,
  { label: 'idx ready', tone: 'secondary' },
  { label: 'idx building 1234 files', tone: 'warning' },
  { label: 'idx failed: 42 files could not be read', tone: 'error' },
]

const byId = (chips: StatusBarChip[]) =>
  Object.fromEntries(chips.map((chip) => [chip.id, chip])) as Partial<
    Record<StatusBarChip['id'], StatusBarChip>
  >

/**
 * Smallest terminal width whose chip budget covers `target`, so overflow tests
 * can key off cluster widths instead of magic widths coupled to the
 * width-budget ratio.
 */
const widthForBudget = (target: number, showStop: boolean): number => {
  for (let terminalWidth = 1; terminalWidth <= 1000; terminalWidth += 1) {
    if (statusBarChipBudget(terminalWidth, showStop) >= target) {
      return terminalWidth
    }
  }
  throw new Error(`No terminal width fits a chip budget of ${target}`)
}

describe('selectStatusBarChips', () => {
  test('lg includes context bar, shortened model, cost, git, and timer', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 180,
    })
    const chipsById = byId(chips)

    expect(chips.map((chip) => chip.id)).toEqual([
      'context',
      'git',
      'model',
      'cost',
      'timer',
    ])
    // Below 70% the lg label is a 10-cell bar plus the percent; token counts
    // belong to the >=70% branch only.
    expect(chipsById.context?.label).toMatch(/^[█░]{10} 48%$/)
    expect(chipsById.context?.label).not.toContain('/')
    expect(chipsById.context?.label).not.toContain('96.4k')
    expect(chipsById.context?.label).not.toContain('ctx')
    expect(chipsById.model?.label).not.toContain('anthropic/')
    expect(chipsById.cost?.label).toBe('$0.12')
    expect(chipsById.cost?.label).not.toContain('cost')
    expect(chipsById.git?.label).toBe('~3 +2')
    expect(chipsById.git?.label).not.toContain('git')
    expect(chipsById.timer?.label).toBe('12s')
  })

  test('lg at high context usage shows token counts and escalates the tone', () => {
    const warning = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 200,
        contextWindowUsage: { used: 150000, max: 200000 }, // 75%
      }).chips,
    )

    expect(warning.context?.tone).toBe('warning')
    expect(warning.context?.label).toContain('150k/200k')
    expect(warning.context?.label).toContain('75%')
    expect(warning.context?.label).toContain('█')

    const error = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 200,
        contextWindowUsage: { used: 190000, max: 200000 }, // 95%
      }).chips,
    )

    expect(error.context?.tone).toBe('error')
    expect(error.context?.label).toContain('190k/200k')
    expect(error.context?.label).toContain('95%')
  })

  test('lg tone and label switch exactly at the 70% and 90% thresholds', () => {
    const contextAt = (used: number) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth: 200,
          contextWindowUsage: { used, max: 200_000 },
        }).chips,
      ).context

    // 69%: below the warning threshold, so the bar-only label and the neutral
    // tone are kept.
    const belowWarning = contextAt(138_000)
    expect(belowWarning?.tone).toBe('secondary')
    expect(belowWarning?.label).toMatch(/^[█░]{10} 69%$/)

    // Exactly 70%: warning tone, and lg switches to the token-count label.
    const atWarning = contextAt(140_000)
    expect(atWarning?.tone).toBe('warning')
    expect(atWarning?.label).toContain('140k/200k')
    expect(atWarning?.label).toContain('70%')

    // 89%: still warning, one percent below the error threshold.
    expect(contextAt(178_000)?.tone).toBe('warning')

    // Exactly 90%: error tone, token-count label retained.
    const atError = contextAt(180_000)
    expect(atError?.tone).toBe('error')
    expect(atError?.label).toContain('180k/200k')
    expect(atError?.label).toContain('90%')
  })

  test('clamps the context percent when usage exceeds the max', () => {
    const chipsById = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 200,
        contextWindowUsage: { used: 300000, max: 200000 }, // 150% raw
      }).chips,
    )

    expect(chipsById.context?.label).toContain('100%')
    expect(chipsById.context?.label).not.toContain('150%')
    expect(chipsById.context?.label).toContain('300k/200k')
    // Fully filled bar, no empty cells.
    expect(chipsById.context?.label).not.toContain('░')
    expect(chipsById.context?.tone).toBe('error')
  })

  test('lg formats sub-cent cost with four decimals and hides a zero cost', () => {
    const subCent = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        sessionCostCents: 0.5,
      }).chips,
    )
    expect(subCent.cost?.label).toBe('$0.0050')

    const zero = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        sessionCostCents: 0,
      }).chips,
    )
    expect(zero.cost).toBeUndefined()
  })

  test('lg floors a cost below the rendered precision and hides a negative', () => {
    const tiny = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        sessionCostCents: 0.0004,
      }).chips,
    )
    // Would otherwise render '$0.0000', which looks like the hidden zero case.
    expect(tiny.cost?.label).toBe('<$0.0001')

    const negative = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        sessionCostCents: -5,
      }).chips,
    )
    // Same as the zero case: a non-positive cost hides the chip instead of
    // rendering a clamped '$0.00'.
    expect(negative.cost).toBeUndefined()
  })

  test('git chip is omitted for all-zero diff stats and includes deletions', () => {
    const clean = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        diffStats: { modified: 0, added: 0, deleted: 0 },
      }).chips,
    )
    expect(clean.git).toBeUndefined()

    const withDeletions = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        diffStats: { modified: 1, added: 0, deleted: 4 },
      }).chips,
    )
    expect(withDeletions.git?.label).toBe('~1 -4')
  })

  test('md includes context bar, model, git, and timer, but not cost', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'md',
      terminalWidth: 120,
    })
    const chipsById = byId(chips)

    // md renders a 6-cell bar, half the lg width.
    expect(chipsById.context?.label).toMatch(/^[█░]{6} 48%$/)
    expect(chipsById.model).toBeDefined()
    expect(chipsById.git).toBeDefined()
    expect(chipsById.timer).toBeDefined()
    expect(chipsById.cost).toBeUndefined()
  })

  test('model label width follows the width size (16 for lg, 12 for md)', () => {
    const modelName = 'anthropic/claude-sonnet-4-20250514-preview'
    const modelLabel = (widthSize: 'lg' | 'md', terminalWidth: number) =>
      byId(
        selectStatusBarChips({ ...full, widthSize, terminalWidth, modelName })
          .chips,
      ).model?.label ?? ''

    const lgLabel = modelLabel('lg', 180)
    expect(stringWidth(lgLabel)).toBe(16)
    expect(lgLabel.endsWith('…')).toBe(true)

    const mdLabel = modelLabel('md', 120)
    expect(stringWidth(mdLabel)).toBe(12)
    expect(mdLabel.endsWith('…')).toBe(true)
    expect(lgLabel.startsWith(mdLabel.slice(0, -1))).toBe(true)
  })

  test('sm prefixes the context percent and keeps git when there is no index chip', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'sm',
      terminalWidth: 80,
    })
    const chipsById = byId(chips)

    // 'ctx' prefix so the percent is not read as part of the neighbouring git
    // chip; sm still renders no bar.
    expect(chipsById.context?.label).toBe('ctx 48%')
    expect(chipsById.context?.label).not.toContain('█')
    expect(chipsById.model).toBeUndefined()
    expect(chipsById.cost).toBeUndefined()
    expect(chipsById.git?.label).toBe('~3 +2')
  })

  test('sm context degrades from the prefixed label to the bare percent', () => {
    const timerLabel = '12s'
    const budgetFor = (contextLabel: string) =>
      statusBarClusterWidth([
        { id: 'context', label: contextLabel, tone: 'secondary' },
        { id: 'timer', label: timerLabel, tone: 'secondary' },
      ])
    const contextAt = (terminalWidth: number) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'sm',
          terminalWidth,
          isActive: false,
        }).chips,
      ).context

    // Room for the prefixed label beside the timer, so nothing degrades.
    expect(
      contextAt(widthForBudget(budgetFor('ctx 48%'), full.showStop))?.label,
    ).toBe('ctx 48%')
    // One column tighter: the prefix goes and the bare percent survives.
    expect(
      contextAt(widthForBudget(budgetFor('ctx 48%') - 1, full.showStop))?.label,
    ).toBe('48%')
  })

  test('sm drops git for a secondary index chip, not only for alerts', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'sm',
      terminalWidth: 80,
      indexChip: { label: 'idx ready', tone: 'secondary' },
    })
    const chipsById = byId(chips)

    expect(chipsById.git).toBeUndefined()
    expect(chipsById.index?.label).toBe('idx ready')
    expect(chipsById.index?.tone).toBe('secondary')
  })

  test('sm with a warning index chip drops git and never drops the index', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'sm',
      terminalWidth: 80,
      indexChip: { label: 'idx building', tone: 'warning' },
    })
    const chipsById = byId(chips)

    expect(chipsById.git).toBeUndefined()
    expect(chipsById.index?.label).toBe('idx building')
    expect(chipsById.index?.tone).toBe('warning')
  })

  test('keeps a full error index label outside xs', () => {
    // Only 'xs' abbreviates an error label, so wider sizes must keep it intact
    // when the budget has room for it.
    for (const widthSize of ['sm', 'lg'] as const) {
      const chipsById = byId(
        selectStatusBarChips({
          ...full,
          widthSize,
          terminalWidth: 200,
          indexChip: {
            label: 'idx failed: 42 files could not be read',
            tone: 'error',
          },
        }).chips,
      )

      expect(chipsById.index?.label).toBe(
        'idx failed: 42 files could not be read',
      )
      expect(chipsById.index?.label).not.toContain('!')
      expect(chipsById.index?.tone).toBe('error')
    }
  })

  test('xs is percent-only and omits model, git, cost, bar, and timer when stop is shown', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'xs',
      terminalWidth: 40,
    })
    const chipsById = byId(chips)

    expect(chips.map((chip) => chip.id)).toEqual(['context'])
    expect(chipsById.context?.label).toBe('48%')
    expect(chipsById.context?.label).not.toContain('█')
    expect(chipsById.model).toBeUndefined()
    expect(chipsById.git).toBeUndefined()
    expect(chipsById.cost).toBeUndefined()
    expect(chipsById.timer).toBeUndefined()
  })

  test('xs with a failed index chip shows idx! and omits context percent', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'xs',
      terminalWidth: 40,
      indexChip: { label: 'idx failed', tone: 'error' },
    })
    const chipsById = byId(chips)

    expect(chips.map((chip) => chip.id)).toEqual(['index'])
    expect(chipsById.index?.label).toBe('idx!')
    expect(chipsById.index?.tone).toBe('error')
    expect(chipsById.context).toBeUndefined()
  })

  test('xs abbreviates an error index label to its own first word', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'xs',
      terminalWidth: 40,
      indexChip: { label: 'search failed', tone: 'error' },
    })

    expect(byId(chips).index?.label).toBe('search!')
  })

  test('xs marks a space-free error index label without cutting it', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'xs',
      terminalWidth: 40,
      indexChip: { label: 'indexing', tone: 'error' },
    })

    // No space to split on, so the whole label survives with the '!' marker.
    expect(chips.map((chip) => chip.id)).toEqual(['index'])
    expect(byId(chips).index?.label).toBe('indexing!')
  })

  test('xs keeps a non-error index label verbatim beside the context percent', () => {
    // False side of the xs error-only branches: no '!' suffix on the label, and
    // the context percent is not omitted for a non-error index chip.
    for (const indexChip of [
      { label: 'idx ready', tone: 'secondary' },
      { label: 'idx building', tone: 'warning' },
    ] as const) {
      // Roomy enough for the context percent plus the full index label, so the
      // overflow loop leaves both alone and the assertions below are about the
      // error-only branches rather than the width budget.
      const terminalWidth = widthForBudget(
        statusBarClusterWidth([
          { id: 'context', label: '48%', tone: 'secondary' },
          { id: 'index', label: indexChip.label, tone: indexChip.tone },
        ]),
        full.showStop,
      )
      const chipsById = byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'xs',
          terminalWidth,
          indexChip,
        }).chips,
      )

      expect(chipsById.index?.label).toBe(indexChip.label)
      expect(chipsById.index?.label).not.toContain('!')
      expect(chipsById.index?.tone).toBe(indexChip.tone)
      expect(chipsById.context?.label).toBe('48%')
    }
  })

  test('xs at width 20 keeps only the context percent, within the budget', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'xs',
      terminalWidth: 20,
    })

    expect(chips.map((chip) => chip.id)).toEqual(['context'])
    expect(chips[0]?.label).toBe('48%')
    expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(
      statusBarChipBudget(20, true),
    )
  })

  test('md at high context usage keeps the bar and percent, not counts', () => {
    const chipsById = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'md',
        terminalWidth: 120,
        contextWindowUsage: { used: 150000, max: 200000 }, // 75%
      }).chips,
    )

    // md only adds token counts from 80%; 75% keeps the bar-and-percent form.
    expect(chipsById.context?.label).toMatch(/^[█░]{6} 75%$/)
    expect(chipsById.context?.label).not.toContain('/')
    expect(chipsById.context?.tone).toBe('warning')
  })

  test('md shows token counts from 80% and degrades counts, then bar, then percent', () => {
    const contextAt = (terminalWidth: number) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'md',
          terminalWidth,
          contextWindowUsage: { used: 170_000, max: 200_000 }, // 85%
          isActive: false,
        }).chips,
      ).context

    const countsLabel = contextAt(200)?.label ?? ''
    expect(countsLabel).toMatch(/^170k\/200k [█░]{6} 85%$/)

    // Same label without its token-count prefix: the intermediate form the
    // overflow loop should stop at while it still fits.
    const barLabel = countsLabel.slice(countsLabel.indexOf(' ') + 1)
    const timerLabel = '12s'
    const budgetFor = (contextLabel: string) =>
      statusBarClusterWidth([
        { id: 'context', label: contextLabel, tone: 'warning' },
        { id: 'timer', label: timerLabel, tone: 'secondary' },
      ])

    const intermediate = contextAt(
      widthForBudget(budgetFor(barLabel), full.showStop),
    )
    expect(intermediate?.label).toBe(barLabel)
    expect(intermediate?.label).toMatch(/^[█░]{6} 85%$/)

    const bare = contextAt(
      widthForBudget(budgetFor(barLabel) - 1, full.showStop),
    )
    expect(bare?.label).toBe('85%')
  })

  test('compaction chip label and tone follow the width size and action', () => {
    const compactionAt = (
      widthSize: 'xs' | 'sm' | 'md' | 'lg',
      notice: NonNullable<SelectStatusBarChipsInput['compactionNotice']>,
    ) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize,
          terminalWidth: 400,
          compactionNotice: notice,
        }).chips,
      ).compaction

    const semantic = {
      count: 2,
      action: 'semantic_compaction',
      degraded: false,
    } as const

    expect(compactionAt('xs', semantic)?.label).toBe('⇲ 2')
    expect(compactionAt('sm', semantic)?.label).toBe('⇲ 2')
    expect(compactionAt('md', semantic)?.label).toBe('⇲ compacted ×2')
    expect(compactionAt('lg', semantic)?.label).toBe('⇲ compacted ×2')
    expect(compactionAt('lg', semantic)?.tone).toBe('warning')

    const trimmed = {
      count: 3,
      action: 'mechanical_trim',
      degraded: true,
    } as const
    expect(compactionAt('md', trimmed)?.label).toBe('⇲ trimmed ×3')
    expect(compactionAt('lg', trimmed)?.label).toBe('⇲ trimmed ×3')
    expect(compactionAt('lg', trimmed)?.tone).toBe('error')
    expect(compactionAt('sm', trimmed)?.label).toBe('⇲ 3')
    expect(compactionAt('sm', trimmed)?.tone).toBe('error')
  })

  test('compaction chip reports the live state while a pass is pending', () => {
    const pendingAt = (widthSize: 'xs' | 'sm' | 'md' | 'lg') =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize,
          terminalWidth: 400,
          compactionNotice: {
            // Nothing has completed yet: the chip must still render at count 0.
            count: 0,
            action: 'semantic_compaction',
            degraded: false,
            pending: true,
          },
        }).chips,
      ).compaction

    expect(pendingAt('xs')?.label).toBe('⇲ …')
    expect(pendingAt('sm')?.label).toBe('⇲ …')
    expect(pendingAt('md')?.label).toBe('⇲ compacting…')
    expect(pendingAt('lg')?.label).toBe('⇲ compacting…')
    expect(pendingAt('lg')?.tone).toBe('warning')

    // A degraded earlier pass does not tone the live chip red.
    const degradedPending = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 400,
        compactionNotice: {
          count: 1,
          action: 'mechanical_trim',
          degraded: true,
          pending: true,
        },
      }).chips,
    ).compaction
    expect(degradedPending?.label).toBe('⇲ compacting…')
    expect(degradedPending?.tone).toBe('warning')
  })

  // Same (widthSize, notice) shape as the `compactionAt` helper of the
  // label/tone test above, hoisted so the progress cases below share it.
  const compactionChipAt = (
    widthSize: 'xs' | 'sm' | 'md' | 'lg',
    notice: NonNullable<SelectStatusBarChipsInput['compactionNotice']>,
  ) =>
    byId(
      selectStatusBarChips({
        ...full,
        widthSize,
        terminalWidth: 400,
        compactionNotice: notice,
      }).chips,
    ).compaction

  test('a live pass reports its progress percent at md and lg', () => {
    const pendingWithProgress = {
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      progressPercent: 62,
    } as const

    // The wide sizes have room to report real movement instead of an
    // indefinite ellipsis.
    expect(compactionChipAt('md', pendingWithProgress)?.label).toBe(
      '⇲ compacting 62%',
    )
    expect(compactionChipAt('lg', pendingWithProgress)?.label).toBe(
      '⇲ compacting 62%',
    )
    // A live pass still reads as in progress rather than as a failed one.
    expect(compactionChipAt('lg', pendingWithProgress)?.tone).toBe('warning')

    // The narrow sizes have no room for the percent, so they keep their exact
    // previous label.
    expect(compactionChipAt('xs', pendingWithProgress)?.label).toBe('⇲ …')
    expect(compactionChipAt('sm', pendingWithProgress)?.label).toBe('⇲ …')
  })

  test('a live percent is rounded and clamped to the renderable range', () => {
    const labelFor = (progressPercent: number) =>
      compactionChipAt('lg', {
        count: 0,
        action: 'semantic_compaction',
        degraded: false,
        pending: true,
        progressPercent,
      })?.label

    expect(labelFor(62.6)).toBe('⇲ compacting 63%')
    expect(labelFor(150)).toBe('⇲ compacting 100%')
  })

  test('a live pass with no usable percent falls back to the ellipsis label', () => {
    const base = {
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
    } as const

    // Absent, zero, negative and non-finite all mean "no usable estimate": the
    // percent is best-effort telemetry, so the chip keeps its previous label.
    expect(compactionChipAt('md', base)?.label).toBe('⇲ compacting…')
    expect(compactionChipAt('lg', base)?.label).toBe('⇲ compacting…')
    for (const progressPercent of [
      0,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(compactionChipAt('md', { ...base, progressPercent })?.label).toBe(
        '⇲ compacting…',
      )
      expect(compactionChipAt('lg', { ...base, progressPercent })?.label).toBe(
        '⇲ compacting…',
      )
    }

    // Control: a usable percent does reach the label, so the fallbacks above
    // are the no-estimate branch rather than a chip that never reports one.
    const usable = compactionChipAt('lg', { ...base, progressPercent: 62 })
    expect(usable?.label).toBe('⇲ compacting 62%')
  })

  test('a settled notice ignores a carried progress percent', () => {
    // Progress only ever describes a live pass, so a settled notice that still
    // carries one keeps its exact count labels.
    expect(
      compactionChipAt('md', {
        count: 2,
        action: 'semantic_compaction',
        degraded: false,
        progressPercent: 62,
      })?.label,
    ).toBe('⇲ compacted ×2')
    expect(
      compactionChipAt('lg', {
        count: 3,
        action: 'mechanical_trim',
        degraded: true,
        progressPercent: 62,
      })?.label,
    ).toBe('⇲ trimmed ×3')

    // Control: the same percent on a PENDING notice is reported, so the
    // settled labels above are unchanged by choice rather than by accident.
    expect(
      compactionChipAt('lg', {
        count: 2,
        action: 'semantic_compaction',
        degraded: false,
        pending: true,
        progressPercent: 62,
      })?.label,
    ).toBe('⇲ compacting 62%')
  })

  test('an idle run stops reporting a pending pass as live', () => {
    // The run aborted mid-compaction, so no settling event will ever arrive.
    // The chip must not keep claiming a compaction is running.
    const settled = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 400,
        isActive: false,
        compactionNotice: {
          count: 2,
          action: 'mechanical_trim',
          degraded: true,
          pending: true,
        },
      }).chips,
    ).compaction
    expect(settled?.label).toBe('⇲ trimmed ×2')
    // Settled again, so the degraded pass tones the chip red.
    expect(settled?.tone).toBe('error')

    // Nothing ever completed: there is no count worth showing, so the chip is
    // dropped rather than rendering an information-free '⇲ 0'.
    expect(
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth: 400,
          isActive: false,
          compactionNotice: {
            count: 0,
            action: 'semantic_compaction',
            degraded: false,
            pending: true,
          },
        }).chips,
      ).compaction,
    ).toBeUndefined()
  })

  test('a zero-count settled notice renders no compaction chip', () => {
    expect(
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth: 400,
          compactionNotice: {
            count: 0,
            action: 'semantic_compaction',
            degraded: false,
          },
        }).chips,
      ).compaction,
    ).toBeUndefined()
  })

  test('compaction chip renders right after context and is omitted without a notice', () => {
    const withNotice = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 400,
      compactionNotice: {
        count: 1,
        action: 'semantic_compaction',
        degraded: false,
      },
      indexChip: { label: 'idx ready', tone: 'secondary' },
    })
    expect(withNotice.chips.map((chip) => chip.id)).toEqual([
      'context',
      'compaction',
      'index',
      'git',
      'model',
      'cost',
      'timer',
    ])

    const withoutNotice = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 400,
      compactionNotice: null,
    })
    expect(byId(withoutNotice.chips).compaction).toBeUndefined()
  })

  test('overflow drops the compaction chip after git but before context', () => {
    const compactionNotice = {
      count: 2,
      action: 'semantic_compaction',
      degraded: false,
    } as const
    const chipsAt = (terminalWidth: number) =>
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth,
        compactionNotice,
      }).chips
    const idsAt = (terminalWidth: number) =>
      chipsAt(terminalWidth).map((chip) => chip.id)

    const allChips = chipsAt(widthForBudget(120, full.showStop))
    const clusterWithout = (dropped: StatusBarChip['id'][]) =>
      statusBarClusterWidth(
        allChips.filter((chip) => !dropped.includes(chip.id)),
      )

    // The compaction chip survives while cost, model, and git are given up.
    expect(
      idsAt(
        widthForBudget(clusterWithout(['cost', 'model', 'git']), full.showStop),
      ),
    ).toEqual(['context', 'compaction', 'timer'])

    // One priority step further: the compaction chip goes before context is
    // shortened or dropped.
    expect(
      idsAt(
        widthForBudget(
          clusterWithout(['cost', 'model', 'git', 'compaction']),
          full.showStop,
        ),
      ),
    ).toEqual(['context', 'timer'])
  })

  test('marks the compaction trigger cell in the bar without widening the label', () => {
    const contextFor = (
      contextWindowUsage: SelectStatusBarChipsInput['contextWindowUsage'],
    ) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth: 400,
          contextWindowUsage,
        }).chips,
      ).context

    // 48% usage in a 200k window with the trigger at 140k (70%): the marker
    // lands on cell 7 of the 10-cell bar and replaces the glyph that cell
    // would otherwise have rendered.
    const withTrigger = contextFor({
      used: 96_400,
      max: 200_000,
      compactionTriggerTokens: 140_000,
    })
    const withoutTrigger = contextFor({ used: 96_400, max: 200_000 })

    expect(withTrigger?.label).toBe('█████░░│░░ 48%')
    expect(withoutTrigger?.label).toBe('█████░░░░░ 48%')
    // The marker replaces a cell rather than adding one, so the chip cannot
    // get wider for the same size and usage.
    expect(stringWidth(withTrigger?.label ?? '')).toBe(
      stringWidth(withoutTrigger?.label ?? ''),
    )

    // Marker on the very last cell with usage already past it: the crossing is
    // the useful signal, so the marker is still rendered.
    const crossed = contextFor({
      used: 200_000,
      max: 200_000,
      compactionTriggerTokens: 190_000,
    })
    expect(crossed?.label).toBe('200k/200k ⇲190k █████████│ 100%')
    expect(crossed?.tone).toBe('error')
  })

  test('suppresses a meaningless trigger and keeps the fixed-70 warning tone', () => {
    // A trigger at or above the window is misleading (the unknown-window
    // fallback budget can exceed a small configured window), and a non-finite,
    // zero, or negative value carries no information at all.
    for (const compactionTriggerTokens of [
      200_000,
      240_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -5,
    ]) {
      const warning = byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth: 400,
          contextWindowUsage: {
            used: 150_000,
            max: 200_000,
            compactionTriggerTokens,
          },
        }).chips,
      ).context

      expect(warning?.label).toBe('150k/200k ████████░░ 75%')
      expect(warning?.label).not.toContain('│')
      expect(warning?.label).not.toContain('⇲')
      // No trigger is known, so the tone falls back to the fixed 70.
      expect(warning?.tone).toBe('warning')

      const below = byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth: 400,
          contextWindowUsage: {
            used: 138_000, // 69%
            max: 200_000,
            compactionTriggerTokens,
          },
        }).chips,
      ).context
      expect(below?.tone).toBe('secondary')
    }
  })

  test('warns from the trigger percent when it is below the fixed 70', () => {
    // A 32k window with the model-aware trigger at 16.8k puts the warning at
    // 53% — the point at which the next step may compact.
    const toneAt = (used: number) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth: 400,
          contextWindowUsage: {
            used,
            max: 32_000,
            compactionTriggerTokens: 16_800,
          },
        }).chips,
      ).context

    expect(toneAt(15_000)?.tone).toBe('secondary') // 47%
    const atTrigger = toneAt(16_800) // 53%
    expect(atTrigger?.tone).toBe('warning')
    expect(atTrigger?.label).toBe('█████│░░░░ 53%')
    // The 90 error threshold stays fixed regardless of the trigger.
    expect(toneAt(28_800)?.tone).toBe('error') // 90%
  })

  test('lg shows the trigger suffix from 70% and drops it before the bar', () => {
    const usage = {
      used: 150_000, // 75%
      max: 200_000,
      compactionTriggerTokens: 140_000,
    }
    const contextAt = (terminalWidth: number) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth,
          contextWindowUsage: usage,
        }).chips,
      ).context

    const widest = contextAt(400)?.label ?? ''
    expect(widest).toBe('150k/200k ⇲140k ███████│░░ 75%')

    const timerLabel = '12s'
    const budgetFor = (contextLabel: string) =>
      statusBarClusterWidth([
        { id: 'context', label: contextLabel, tone: 'warning' },
        { id: 'timer', label: timerLabel, tone: 'secondary' },
      ])

    // One step down the ladder: the trigger suffix goes before the counts.
    const withoutSuffix = '150k/200k ███████│░░ 75%'
    expect(contextAt(widthForBudget(budgetFor(widest) - 1, full.showStop))
      ?.label).toBe(withoutSuffix)

    // Then the counts, and only then the bar.
    const barOnly = '███████│░░ 75%'
    expect(
      contextAt(widthForBudget(budgetFor(withoutSuffix) - 1, full.showStop))
        ?.label,
    ).toBe(barOnly)
    expect(
      contextAt(widthForBudget(budgetFor(barOnly) - 1, full.showStop))?.label,
    ).toBe('75%')
  })

  test('xs keeps the timer when the stop hint is hidden', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'xs',
      terminalWidth: 40,
      showStop: false,
    })
    const chipsById = byId(chips)

    expect(chips.map((chip) => chip.id)).toEqual(['context', 'timer'])
    expect(chipsById.timer?.label).toBe('12s')
    expect(chipsById.context?.label).toBe('48%')
    expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(
      statusBarChipBudget(40, false),
    )
  })

  test('overflow drops the timer before context when idle', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'sm',
      terminalWidth: 39,
      isActive: false,
    })
    const chipsById = byId(chips)

    expect(chipsById.timer).toBeUndefined()
    expect(chipsById.context?.label).toBe('48%')
    expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(
      statusBarChipBudget(39, full.showStop),
    )
  })

  test('overflow drops context before the timer during an active run', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'sm',
      terminalWidth: 39,
      isActive: true,
    })
    const chipsById = byId(chips)

    expect(chipsById.context).toBeUndefined()
    expect(chipsById.timer?.label).toBe('12s')
    expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(
      statusBarChipBudget(39, full.showStop),
    )
  })

  test('overflow drops context before the timer during an active run without the stop hint', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'sm',
      terminalWidth: 8,
      showStop: false,
      isActive: true,
    })
    const chipsById = byId(chips)

    // Same priority as the showStop case: the live timer outranks context.
    expect(chipsById.context).toBeUndefined()
    expect(chipsById.timer?.label).toBe('12s')
    expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(
      statusBarChipBudget(8, false),
    )
  })

  test('overflow drops cost, then model, then git, and never drops a warning index', () => {
    const chipsAt = (terminalWidth: number) =>
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth,
      }).chips
    const idsAt = (terminalWidth: number) =>
      chipsAt(terminalWidth).map((chip) => chip.id)

    // Budget larger than any lg cluster, so nothing is dropped or shortened.
    const allChips = chipsAt(widthForBudget(80, full.showStop))
    const clusterWithout = (dropped: StatusBarChip['id'][]) =>
      statusBarClusterWidth(
        allChips.filter((chip) => !dropped.includes(chip.id)),
      )

    // Each step gives the cluster exactly the budget the surviving chips need,
    // so the next-lowest priority chip is the one that has to go.
    expect(idsAt(widthForBudget(clusterWithout([]), full.showStop))).toEqual([
      'context',
      'git',
      'model',
      'cost',
      'timer',
    ])
    expect(
      idsAt(widthForBudget(clusterWithout(['cost']), full.showStop)),
    ).toEqual(['context', 'git', 'model', 'timer'])
    expect(
      idsAt(widthForBudget(clusterWithout(['cost', 'model']), full.showStop)),
    ).toEqual(['context', 'git', 'timer'])
    expect(
      idsAt(
        widthForBudget(clusterWithout(['cost', 'model', 'git']), full.showStop),
      ),
    ).toEqual(['context', 'timer'])

    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 60,
    })
    const chipsById = byId(chips)
    const remaining = statusBarChipBudget(60, full.showStop)

    expect(chipsById.cost).toBeUndefined()
    expect(chipsById.model).toBeUndefined()
    expect(chipsById.git).toBeUndefined()
    expect(chipsById.context?.label).toBe('48%')
    expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(remaining)

    const withIndex = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 60,
      indexChip: { label: 'idx building', tone: 'warning' },
    })
    const indexChip = withIndex.chips.find((chip) => chip.id === 'index')
    expect(indexChip?.label).toBe('idx building')
    expect(indexChip?.tone).toBe('warning')
    expect(byId(withIndex.chips).timer).toBeUndefined()
    expect(statusBarClusterWidth(withIndex.chips)).toBeLessThanOrEqual(
      remaining,
    )
  })

  test('lg context drops token counts before the bar when overflowing', () => {
    const contextAt = (terminalWidth: number) =>
      byId(
        selectStatusBarChips({
          ...full,
          widthSize: 'lg',
          terminalWidth,
          contextWindowUsage: { used: 150_000, max: 200_000 }, // 75%
        }).chips,
      )

    const tokenLabel = contextAt(200).context?.label ?? ''
    expect(tokenLabel).toMatch(/^150k\/200k [█░]{10} 75%$/)

    // The same label without its token-count prefix: the intermediate form the
    // overflow loop should stop at while it still fits.
    const barLabel = tokenLabel.slice(tokenLabel.indexOf(' ') + 1)
    const timerLabel = '12s'
    // Budget for the surviving cluster only (context plus the live timer), so
    // cost, model, and git are dropped and context has to shorten.
    const budgetFor = (contextLabel: string) =>
      statusBarClusterWidth([
        { id: 'context', label: contextLabel, tone: 'warning' },
        { id: 'timer', label: timerLabel, tone: 'secondary' },
      ])

    const intermediate = contextAt(
      widthForBudget(budgetFor(barLabel), full.showStop),
    )
    expect(intermediate.context?.label).toBe(barLabel)
    expect(intermediate.context?.label).toMatch(/^[█░]{10} 75%$/)
    expect(intermediate.context?.tone).toBe('warning')
    expect(intermediate.timer?.label).toBe(timerLabel)

    // One column tighter than the intermediate label needs, so the bar goes too
    // and only the bare percent survives.
    const bare = contextAt(
      widthForBudget(budgetFor(barLabel) - 1, full.showStop),
    )
    expect(bare.context?.label).toBe('75%')
    expect(bare.timer?.label).toBe(timerLabel)
  })

  test('omits the timer when it is hidden or nothing has elapsed', () => {
    const hidden = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        showTimer: false,
      }).chips,
    )
    expect(hidden.timer).toBeUndefined()

    const notStarted = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        elapsedSeconds: 0,
      }).chips,
    )
    expect(notStarted.timer).toBeUndefined()
  })

  test('omits the context chip for missing usage or a zero max', () => {
    const missing = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        contextWindowUsage: null,
      }).chips,
    )
    expect(missing.context).toBeUndefined()

    const zeroMax = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        contextWindowUsage: { used: 1000, max: 0 },
      }).chips,
    )
    expect(zeroMax.context).toBeUndefined()
  })

  test('lg omits the model chip when the model name is null', () => {
    const chipsById = byId(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 180,
        modelName: null,
      }).chips,
    )
    expect(chipsById.model).toBeUndefined()
    expect(chipsById.context).toBeDefined()
  })

  test('clamps a long index label to the chip budget', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'xs',
      terminalWidth: 20,
      indexChip: { label: 'idx building 1234 files', tone: 'warning' },
    })
    const chipsById = byId(chips)

    expect(chips.map((chip) => chip.id)).toEqual(['index'])
    expect(chipsById.index?.label.endsWith('…')).toBe(true)
    expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(
      statusBarChipBudget(20, full.showStop),
    )
  })

  test('drops every chip at width 1 with the stop hint', () => {
    // The chip budget is zero here, so clamping a label would otherwise leave a
    // zero-width chip behind.
    expect(statusBarChipBudget(1, true)).toBe(0)

    for (const widthSize of ['xs', 'sm', 'md', 'lg'] as const) {
      for (const isActive of [true, false]) {
        for (const indexChip of indexChipVariants) {
          const { chips } = selectStatusBarChips({
            ...full,
            widthSize,
            terminalWidth: 1,
            showStop: true,
            isActive,
            indexChip,
          })

          // Nothing fits beside the stop hint, so even the index chip goes.
          expect(chips).toEqual([])
        }
      }
    }
  })

  test('drops the index chip instead of clamping it to a bare ellipsis', () => {
    // One column is room for the ellipsis alone, an information-free label.
    expect(statusBarChipBudget(8, true)).toBe(1)

    for (const widthSize of ['xs', 'sm', 'md', 'lg'] as const) {
      for (const isActive of [true, false]) {
        for (const indexChip of indexChipVariants) {
          const { chips } = selectStatusBarChips({
            ...full,
            widthSize,
            terminalWidth: 8,
            showStop: true,
            isActive,
            indexChip,
          })

          expect(chips.map((chip) => chip.label)).not.toContain('…')
          expect(chips).toEqual([])
        }
      }
    }
  })

  test('never returns an empty-label chip where a clamped index chip survives', () => {
    // Two columns: room for one character plus the ellipsis, so the index chip
    // survives the clamp and the empty-label guard applies to a real label.
    expect(statusBarChipBudget(9, true)).toBe(2)

    for (const widthSize of ['xs', 'sm', 'md', 'lg'] as const) {
      for (const isActive of [true, false]) {
        // Skip the null variant: there is no index chip to clamp there.
        for (const indexChip of indexChipVariants.slice(1)) {
          const { chips } = selectStatusBarChips({
            ...full,
            widthSize,
            terminalWidth: 9,
            showStop: true,
            isActive,
            indexChip,
          })

          expect(chips.map((chip) => chip.id)).toEqual(['index'])
          for (const chip of chips) {
            expect(stringWidth(chip.label)).toBeGreaterThan(0)
            expect(chip.label).not.toBe('…')
          }
          expect(statusBarClusterWidth(chips)).toBeLessThanOrEqual(
            statusBarChipBudget(9, true),
          )
        }
      }
    }
  })

  test('a visible scroll button tightens the chip budget', () => {
    const withScroll = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 60,
      showScrollButton: true,
    })
    expect(statusBarClusterWidth(withScroll.chips)).toBeLessThanOrEqual(
      statusBarChipBudget(60, full.showStop, true),
    )

    // Omitting the flag keeps the existing selection, so the two-argument
    // budget path and the current call sites are unchanged.
    expect(
      selectStatusBarChips({ ...full, widthSize: 'lg', terminalWidth: 60 })
        .chips,
    ).toEqual(
      selectStatusBarChips({
        ...full,
        widthSize: 'lg',
        terminalWidth: 60,
        showScrollButton: false,
      }).chips,
    )
  })

  test('the compact scroll button form leaves the chips more room', () => {
    const idsFor = (scrollButtonCompact: boolean) =>
      selectStatusBarChips({
        ...full,
        widthSize: 'sm',
        terminalWidth: 80,
        showScrollButton: true,
        scrollButtonCompact,
      }).chips.map((chip) => chip.id)

    // At 'xs'/'sm' the button renders three columns, so the seven columns the
    // expanded reservation would have taken keep the git chip instead.
    expect(idsFor(true)).toEqual(['context', 'git', 'timer'])
    expect(idsFor(false)).toEqual(['context', 'timer'])

    // Omitting the flag keeps the expanded reservation, so existing call sites
    // are unaffected.
    expect(
      selectStatusBarChips({
        ...full,
        widthSize: 'sm',
        terminalWidth: 80,
        showScrollButton: true,
      }).chips.map((chip) => chip.id),
    ).toEqual(idsFor(false))
  })

  test('never exits overflow handling with an over-budget cluster', () => {
    for (const terminalWidth of [1, 8, 12, 20, 39, 60]) {
      for (const showStop of [true, false]) {
        for (const isActive of [true, false]) {
          for (const widthSize of ['xs', 'sm', 'md', 'lg'] as const) {
            for (const indexChip of indexChipVariants) {
              const { chips } = selectStatusBarChips({
                ...full,
                widthSize,
                terminalWidth,
                showStop,
                isActive,
                indexChip,
              })
              const clusterWidth = statusBarClusterWidth(chips)

              expect(clusterWidth).toBeLessThanOrEqual(
                statusBarChipBudget(terminalWidth, showStop),
              )
              // The cluster renders beside the stop hint, so the two together
              // must still fit the real row width. A terminal narrower than the
              // stop hint cannot fit the hint itself, so only the cluster
              // contribution is constrained there.
              const stopReservation = showStop ? STOP_BUTTON_WIDTH : 0
              expect(clusterWidth + stopReservation).toBeLessThanOrEqual(
                Math.max(terminalWidth, stopReservation),
              )
            }
          }
        }
      }
    }
  })
})

describe('contextLabelFallbacks', () => {
  test('its first entry is exactly the widest form buildContextLabel renders', () => {
    // Load-bearing invariant: the overflow loop steps down from
    // buildContextLabel's output, so a wider form added to one and not the
    // other silently breaks shortening. Checked with and without a known
    // compaction trigger, at every size and on both sides of the
    // token-count thresholds.
    //
    // The sizes that can render token counts only spend the columns on them
    // from their threshold up ('lg' 70%, 'md' 80%), so below it
    // buildContextLabel deliberately renders the narrower bar+percent form
    // while the fallback ladder always starts from the counts form. Equality
    // therefore holds only at or above the threshold; below it the invariant is
    // that the ladder can still reach the form actually rendered (the narrower
    // output appears in the list) and that its widest entry is never narrower
    // than what is rendered.
    const usages: StatusBarContextUsage[] = [
      { used: 150_000, max: 200_000 },
      { used: 150_000, max: 200_000, compactionTriggerTokens: 140_000 },
      // A meaningless trigger renders no suffix, so the two must still agree.
      { used: 150_000, max: 200_000, compactionTriggerTokens: 200_000 },
    ]

    for (const widthSize of ['xs', 'sm', 'md', 'lg'] as const) {
      // Mirrors contextCountsThreshold in the module under test.
      const threshold = widthSize === 'lg' ? 70 : widthSize === 'md' ? 80 : null

      for (const usage of usages) {
        for (const pct of [0, 48, 69, 70, 75, 85, 100]) {
          const fallbacks = contextLabelFallbacks(widthSize, usage, pct)
          const rendered = buildContextLabel(widthSize, usage, pct)

          if (threshold == null || pct >= threshold) {
            expect(fallbacks[0]).toBe(rendered)
            continue
          }

          // Narrower form by design: the ladder must still contain it, and its
          // widest entry must remain at least as wide as what is rendered.
          expect(fallbacks).toContain(rendered)
          expect(stringWidth(fallbacks[0])).toBeGreaterThanOrEqual(
            stringWidth(rendered),
          )
        }
      }
    }
  })
})

describe('statusBarChipBudget', () => {
  test('reserves the stop hint but still leaves room for one chip', () => {
    expect(statusBarChipBudget(60, false)).toBe(24)
    expect(statusBarChipBudget(60, true)).toBe(17)
    // Narrow terminal with the stop hint: the floor applies after the
    // reservation, so a chip still fits.
    expect(statusBarChipBudget(20, true)).toBe(8)
    // Below the floor the budget is clamped to the columns left beside the stop
    // hint instead of overflowing the row.
    expect(statusBarChipBudget(12, true)).toBe(5)
    expect(statusBarChipBudget(8, true)).toBe(1)
    expect(statusBarChipBudget(1, true)).toBe(0)
    expect(statusBarChipBudget(1, false)).toBe(1)
  })

  test('reserves the scroll button only when it is shown', () => {
    // 0.4 * 200 = 80 columns, so neither budget hits the MIN_WIDTH_BUDGET floor
    // and the difference is exactly the new reservation.
    for (const showStop of [true, false]) {
      const withoutScroll = statusBarChipBudget(200, showStop)
      const withScroll = statusBarChipBudget(200, showStop, true)

      expect(withScroll).toBe(withoutScroll - SCROLL_BUTTON_RESERVATION)
      expect(withScroll).toBeGreaterThan(0)
    }
  })

  test('reserves the compact width when the narrow button form is rendered', () => {
    // Strictly cheaper than the expanded reservation, so the narrow form can
    // never reserve more columns than it renders.
    expect(SCROLL_BUTTON_COMPACT_RESERVATION).toBe(3)
    expect(SCROLL_BUTTON_COMPACT_RESERVATION).toBeLessThan(
      SCROLL_BUTTON_RESERVATION,
    )

    // 0.4 * 200 = 80 columns, so no budget here hits the MIN_WIDTH_BUDGET floor
    // and each difference is exactly the reservation under test.
    for (const showStop of [true, false]) {
      const withoutScroll = statusBarChipBudget(200, showStop)
      const compact = statusBarChipBudget(200, showStop, true, true)
      const expanded = statusBarChipBudget(200, showStop, true)

      expect(compact).toBe(withoutScroll - 3)
      expect(compact).toBe(withoutScroll - SCROLL_BUTTON_COMPACT_RESERVATION)
      expect(compact).toBeGreaterThan(expanded)
      expect(compact - expanded).toBe(
        SCROLL_BUTTON_RESERVATION - SCROLL_BUTTON_COMPACT_RESERVATION,
      )
    }
  })

  test('the compact flag is ignored while the scroll button is hidden', () => {
    for (const terminalWidth of [1, 8, 12, 20, 60, 200]) {
      for (const showStop of [true, false]) {
        expect(statusBarChipBudget(terminalWidth, showStop, false, true)).toBe(
          statusBarChipBudget(terminalWidth, showStop),
        )
      }
    }
  })

  test('the two-argument form keeps its previous budgets', () => {
    // The third parameter is optional and defaults to false, so existing call
    // sites must be unaffected.
    for (const terminalWidth of [1, 8, 12, 20, 60, 200]) {
      for (const showStop of [true, false]) {
        expect(statusBarChipBudget(terminalWidth, showStop)).toBe(
          statusBarChipBudget(terminalWidth, showStop, false),
        )
      }
    }
    expect(statusBarChipBudget(60, false)).toBe(24)
    expect(statusBarChipBudget(60, true)).toBe(17)
  })
})

describe('formatStatusTokenCount', () => {
  test('formats integers, thousands, and millions', () => {
    expect(formatStatusTokenCount(480)).toBe('480')
    expect(formatStatusTokenCount(48200)).toBe('48.2k')
    expect(formatStatusTokenCount(100000)).toBe('100k')
    expect(formatStatusTokenCount(1_000)).toBe('1k')
    expect(formatStatusTokenCount(1_200_000)).toBe('1.2m')
    // Fractional counts are compared after rounding, so a value just below
    // 1_000 renders as '1k' rather than a 4-column '1000'.
    expect(formatStatusTokenCount(999.6)).toBe('1k')
    expect(formatStatusTokenCount(999.4)).toBe('999')
    // Counts that would round up to '1000k' render as millions instead.
    expect(formatStatusTokenCount(999_499)).toBe('999k')
    expect(formatStatusTokenCount(999_500)).toBe('1m')
    expect(formatStatusTokenCount(999_999)).toBe('1m')
  })
})

describe('shortenStatusModelName', () => {
  test('strips a leading openai/ prefix', () => {
    expect(shortenStatusModelName('openai/gpt-4.1', 16)).toBe('gpt-4.1')
  })

  test('strips the other provider prefixes too', () => {
    expect(shortenStatusModelName('openrouter/qwen3-max', 20)).toBe('qwen3-max')
    expect(shortenStatusModelName('google/gemini-2.5-pro', 20)).toBe(
      'gemini-2.5-pro',
    )
  })

  test('truncates with an ellipsis when the stripped name is too wide', () => {
    expect(shortenStatusModelName('openai/gpt-4.1', 6)).toBe('gpt-4…')
    expect(stringWidth(shortenStatusModelName('openai/gpt-4.1', 6))).toBe(6)
  })

  test('omits the ellipsis when maxChars cannot fit it', () => {
    expect(shortenStatusModelName('openai/gpt-4.1', 0)).toBe('')
    expect(shortenStatusModelName('openai/gpt-4.1', 1)).toBe('…')
    expect(stringWidth(shortenStatusModelName('openai/gpt-4.1', 1))).toBe(1)
  })

  test('truncates wide characters by display width, not code point count', () => {
    const shortened = shortenStatusModelName('中文模型名', 6)
    expect(stringWidth(shortened)).toBeLessThanOrEqual(6)
    expect(shortened).toBe('中文…')
  })

  test('keeps a ZWJ emoji sequence whole instead of cutting mid-grapheme', () => {
    const emoji = '👩‍💻'
    // Room for the sequence plus the ellipsis and nothing more, so the cut
    // lands right after the sequence.
    const maxChars = stringWidth(emoji) + stringWidth('…')
    const shortened = shortenStatusModelName(`${emoji}model`, maxChars)

    expect(shortened).toBe(`${emoji}…`)
    // A code-point-wise cut would leave a dangling zero-width joiner here.
    expect(shortened).not.toContain('\u200D…')
    expect(stringWidth(shortened)).toBeLessThanOrEqual(maxChars)
  })
})
