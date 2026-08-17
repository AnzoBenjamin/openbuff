import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'

import {
  formatStatusTokenCount,
  selectStatusBarChips,
  shortenStatusModelName,
  statusBarChipBudget,
  statusBarClusterWidth,
  STOP_BUTTON_WIDTH,
  type SelectStatusBarChipsInput,
  type StatusBarChip,
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

  test('sm is percent-only context and keeps git when there is no index chip', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'sm',
      terminalWidth: 80,
    })
    const chipsById = byId(chips)

    expect(chipsById.context?.label).toBe('48%')
    expect(chipsById.context?.label).not.toContain('█')
    expect(chipsById.model).toBeUndefined()
    expect(chipsById.cost).toBeUndefined()
    expect(chipsById.git?.label).toBe('~3 +2')
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

    // Token counts belong to the lg >=70% branch only.
    expect(chipsById.context?.label).toMatch(/^[█░]{6} 75%$/)
    expect(chipsById.context?.label).not.toContain('/')
    expect(chipsById.context?.tone).toBe('warning')
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
