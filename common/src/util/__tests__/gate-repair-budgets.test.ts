import { afterEach, describe, expect, it } from 'bun:test'

import {
  DEFAULT_MAX_REPAIR_ROUNDS,
  DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS,
  DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS,
  formatGateRepairBudgetsForCli,
  MAX_MAX_GATE_REPAIR_ROUNDS,
  resolveEffectiveGateRepairBudgets,
  resolveMaxRepairRounds,
  resolveMaxReviewerRepairRounds,
  resolveMaxSpecialistRepairRounds,
  resolvePositiveIntBudget,
} from '../gate-repair-budgets'

describe('gate-repair-budgets', () => {
  const envKeys = [
    'OPENBUFF_MAX_REPAIR_ROUNDS',
    'OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS',
    'OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS',
  ] as const
  const previousEnv: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previousEnv[key]
      }
      delete previousEnv[key]
    }
  })

  function snapshotEnv(): void {
    for (const key of envKeys) {
      previousEnv[key] = process.env[key]
      delete process.env[key]
    }
  }

  it('resolvePositiveIntBudget defaults, rejects invalid, and caps', () => {
    expect(resolvePositiveIntBudget(undefined, 3)).toBe(3)
    expect(resolvePositiveIntBudget('  ', 3)).toBe(3)
    expect(resolvePositiveIntBudget('nope', 3)).toBe(3)
    expect(resolvePositiveIntBudget(0, 3)).toBe(3)
    expect(resolvePositiveIntBudget(-2, 3)).toBe(3)
    expect(resolvePositiveIntBudget(4.9, 3)).toBe(4)
    expect(resolvePositiveIntBudget('7', 3)).toBe(7)
    expect(
      resolvePositiveIntBudget(99, 3, MAX_MAX_GATE_REPAIR_ROUNDS),
    ).toBe(MAX_MAX_GATE_REPAIR_ROUNDS)
  })

  it('per-budget resolvers use their defaults', () => {
    expect(resolveMaxRepairRounds(undefined)).toBe(DEFAULT_MAX_REPAIR_ROUNDS)
    expect(resolveMaxReviewerRepairRounds(undefined)).toBe(
      DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS,
    )
    expect(resolveMaxSpecialistRepairRounds(undefined)).toBe(
      DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS,
    )
  })

  it('resolveEffectiveGateRepairBudgets reads defaults from process.env', () => {
    snapshotEnv()
    expect(resolveEffectiveGateRepairBudgets()).toEqual({
      maxRepairRounds: DEFAULT_MAX_REPAIR_ROUNDS,
      maxReviewerRepairRounds: DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS,
      maxSpecialistRepairRounds: DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS,
    })
  })

  it('resolveEffectiveGateRepairBudgets reads OPENBUFF_* env strings', () => {
    snapshotEnv()
    process.env.OPENBUFF_MAX_REPAIR_ROUNDS = '5'
    process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS = '9'
    process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS = '4'
    expect(resolveEffectiveGateRepairBudgets()).toEqual({
      maxRepairRounds: 5,
      maxReviewerRepairRounds: 9,
      maxSpecialistRepairRounds: 4,
    })
  })

  it('resolveEffectiveGateRepairBudgets prefers explicit bag fields', () => {
    expect(
      resolveEffectiveGateRepairBudgets({
        maxRepairRounds: 2,
        maxReviewerRepairRounds: 8,
        maxSpecialistRepairRounds: 1,
        OPENBUFF_MAX_REPAIR_ROUNDS: '99',
      } as Record<string, string | number | undefined>),
    ).toEqual({
      maxRepairRounds: 2,
      maxReviewerRepairRounds: 8,
      maxSpecialistRepairRounds: 1,
    })
  })

  it('formatGateRepairBudgetsForCli is byte-stable with labels and numbers', () => {
    const output = formatGateRepairBudgetsForCli({
      maxRepairRounds: 3,
      maxReviewerRepairRounds: 6,
      maxSpecialistRepairRounds: 3,
    })
    const labelWidth = 'reviewer (code-review)'.length
    expect(output).toBe(
      [
        'Gate repair budgets',
        '-------------------',
        `${'validation (hooks)'.padEnd(labelWidth)}  3`,
        `${'reviewer (code-review)'.padEnd(labelWidth)}  6`,
        `${'specialist (aux)'.padEnd(labelWidth)}  3`,
        '(env: OPENBUFF_MAX_REPAIR_ROUNDS / OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS / OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS; createBase2 options win at agent load)',
      ].join('\n'),
    )
    expect(output).toContain('validation (hooks)')
    expect(output).toContain('reviewer (code-review)')
    expect(output).toContain('specialist (aux)')
  })
})
