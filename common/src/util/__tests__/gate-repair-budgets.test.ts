import { afterEach, describe, expect, it } from 'bun:test'

import {
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

  it('resolvePositiveIntBudget defaults to unlimited, rejects invalid, and caps', () => {
    expect(resolvePositiveIntBudget(undefined)).toBe(null)
    expect(resolvePositiveIntBudget('  ')).toBe(null)
    expect(resolvePositiveIntBudget('nope')).toBe(null)
    expect(resolvePositiveIntBudget(0)).toBe(null)
    expect(resolvePositiveIntBudget(-2)).toBe(null)
    expect(resolvePositiveIntBudget(4.9)).toBe(4)
    expect(resolvePositiveIntBudget('7')).toBe(7)
    expect(
      resolvePositiveIntBudget(99, null, MAX_MAX_GATE_REPAIR_ROUNDS),
    ).toBe(MAX_MAX_GATE_REPAIR_ROUNDS)
  })

  it('per-budget resolvers default to unlimited (null)', () => {
    expect(resolveMaxRepairRounds(undefined)).toBe(null)
    expect(resolveMaxReviewerRepairRounds(undefined)).toBe(null)
    expect(resolveMaxSpecialistRepairRounds(undefined)).toBe(null)
  })

  it('resolveEffectiveGateRepairBudgets defaults unlimited from process.env', () => {
    snapshotEnv()
    expect(resolveEffectiveGateRepairBudgets()).toEqual({
      maxRepairRounds: null,
      maxReviewerRepairRounds: null,
      maxSpecialistRepairRounds: null,
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

  it('formatGateRepairBudgetsForCli shows unlimited for null budgets', () => {
    const output = formatGateRepairBudgetsForCli({
      maxRepairRounds: null,
      maxReviewerRepairRounds: null,
      maxSpecialistRepairRounds: null,
    })
    const labelWidth = 'reviewer (code-review)'.length
    const valueWidth = 'unlimited'.length
    expect(output).toBe(
      [
        'Gate repair budgets',
        '-------------------',
        `${'validation (hooks)'.padEnd(labelWidth)}  ${'unlimited'.padStart(valueWidth)}`,
        `${'reviewer (code-review)'.padEnd(labelWidth)}  ${'unlimited'.padStart(valueWidth)}`,
        `${'specialist (aux)'.padEnd(labelWidth)}  ${'unlimited'.padStart(valueWidth)}`,
        '(default unlimited / progress-gated; set OPENBUFF_MAX_REPAIR_ROUNDS / OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS / OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS or createBase2 options to a positive int to cap; createBase2 options win at agent load)',
      ].join('\n'),
    )
    expect(output).toContain('validation (hooks)')
    expect(output).toContain('unlimited')
  })

  it('formatGateRepairBudgetsForCli is byte-stable with mixed caps', () => {
    const output = formatGateRepairBudgetsForCli({
      maxRepairRounds: 3,
      maxReviewerRepairRounds: 6,
      maxSpecialistRepairRounds: null,
    })
    expect(output).toContain('validation (hooks)')
    expect(output).toContain('3')
    expect(output).toContain('6')
    expect(output).toContain('unlimited')
  })
})
