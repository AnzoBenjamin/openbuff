import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'

import {
  formatStatusTokenCount,
  selectStatusBarChips,
  shortenStatusModelName,
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

const byId = (chips: StatusBarChip[]) =>
  Object.fromEntries(chips.map((chip) => [chip.id, chip])) as Partial<
    Record<StatusBarChip['id'], StatusBarChip>
  >

const chipClusterWidth = (chips: StatusBarChip[]): number => {
  if (chips.length === 0) return 0
  return (
    chips.reduce((sum, chip) => sum + stringWidth(chip.label), 0) +
    3 * (chips.length - 1)
  )
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
    expect(chipsById.context?.label).toContain('█')
    expect(chipsById.context?.label).toContain('48%')
    expect(chipsById.context?.label).not.toContain('ctx')
    expect(chipsById.model?.label).not.toContain('anthropic/')
    expect(chipsById.cost?.label).toBe('$0.12')
    expect(chipsById.cost?.label).not.toContain('cost')
    expect(chipsById.git?.label).toBe('~3 +2')
    expect(chipsById.git?.label).not.toContain('git')
    expect(chipsById.timer?.label).toBe('12s')
  })

  test('md includes context bar, model, git, and timer, but not cost', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'md',
      terminalWidth: 120,
    })
    const chipsById = byId(chips)

    expect(chipsById.context?.label).toContain('█')
    expect(chipsById.model).toBeDefined()
    expect(chipsById.git).toBeDefined()
    expect(chipsById.timer).toBeDefined()
    expect(chipsById.cost).toBeUndefined()
  })

  test('sm is percent-only context and keeps git when there is no index alert', () => {
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

  test('overflow drops cost then model then git and never drops a warning index', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 60,
    })
    const chipsById = byId(chips)
    const remaining = Math.max(8, Math.floor(60 * 0.4)) - 7

    expect(chipsById.cost).toBeUndefined()
    expect(chipsById.model).toBeUndefined()
    expect(chipsById.git).toBeUndefined()
    expect(chipClusterWidth(chips)).toBeLessThanOrEqual(remaining)

    const withIndex = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 60,
      indexChip: { label: 'idx building', tone: 'warning' },
    })
    const indexChip = withIndex.chips.find((chip) => chip.id === 'index')
    expect(indexChip?.label).toBe('idx building')
    expect(indexChip?.tone).toBe('warning')
    expect(chipClusterWidth(withIndex.chips)).toBeLessThanOrEqual(remaining)
  })

  test('a null indexChip never produces an index chip', () => {
    const { chips } = selectStatusBarChips({
      ...full,
      widthSize: 'lg',
      terminalWidth: 180,
      indexChip: null,
    })
    expect(chips.some((chip) => chip.id === 'index')).toBe(false)
  })
})

describe('formatStatusTokenCount', () => {
  test('formats integers, thousands, and millions', () => {
    expect(formatStatusTokenCount(480)).toBe('480')
    expect(formatStatusTokenCount(48200)).toBe('48.2k')
    expect(formatStatusTokenCount(100000)).toBe('100k')
    expect(formatStatusTokenCount(1_200_000)).toBe('1.2m')
  })
})

describe('shortenStatusModelName', () => {
  test('strips a leading openai/ prefix', () => {
    expect(shortenStatusModelName('openai/gpt-4.1', 16)).toBe('gpt-4.1')
  })
})
