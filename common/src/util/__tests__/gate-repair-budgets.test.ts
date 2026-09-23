import { afterEach, describe, expect, it } from 'bun:test'

import {
  DEFAULT_MAX_NO_VERDICT_RETRIES,
  formatGateRepairBudgetsForCli,
  MAX_MAX_GATE_REPAIR_ROUNDS,
  MAX_MAX_NO_VERDICT_RETRIES,
  resolveEffectiveGateRepairBudgets,
  resolveMaxRepairRounds,
  resolveMaxReviewerNoVerdictRetries,
  resolveMaxReviewerRepairRounds,
  resolveMaxSpecialistNoVerdictRetries,
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
    expect(resolvePositiveIntBudget(99, null, MAX_MAX_GATE_REPAIR_ROUNDS)).toBe(
      MAX_MAX_GATE_REPAIR_ROUNDS,
    )
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

  it('no-verdict retry resolvers default to Infinity, reject invalid, and cap at 10', () => {
    // Legacy reference value only; the resolvers no longer default to it.
    expect(DEFAULT_MAX_NO_VERDICT_RETRIES).toBe(2)
    expect(MAX_MAX_NO_VERDICT_RETRIES).toBe(10)
    for (const resolve of [
      resolveMaxReviewerNoVerdictRetries,
      resolveMaxSpecialistNoVerdictRetries,
    ]) {
      // Missing / invalid / empty / non-positive → unlimited (Infinity).
      expect(resolve(undefined)).toBe(Number.POSITIVE_INFINITY)
      expect(resolve('  ')).toBe(Number.POSITIVE_INFINITY)
      expect(resolve('nope')).toBe(Number.POSITIVE_INFINITY)
      expect(resolve(0)).toBe(Number.POSITIVE_INFINITY)
      expect(resolve(-3)).toBe(Number.POSITIVE_INFINITY)
      // Positive ints pass through; floats floor.
      expect(resolve(3)).toBe(3)
      expect(resolve(4.9)).toBe(4)
      // Env string parsing.
      expect(resolve('5')).toBe(5)
      // Cap at 10 only when a finite positive int is configured.
      expect(resolve(99)).toBe(MAX_MAX_NO_VERDICT_RETRIES)
      expect(resolve('50')).toBe(MAX_MAX_NO_VERDICT_RETRIES)
      // Explicit finite fallback overrides the unlimited default for invalid input.
      expect(resolve(undefined, 7)).toBe(7)
    }
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
