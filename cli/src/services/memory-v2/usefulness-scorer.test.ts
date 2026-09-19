import { describe, expect, test } from 'bun:test'

import {
  ageBucketDays,
  deriveUsefulnessTier,
  scoreUsefulness,
  USEFULNESS_SCORE_MODEL_VERSION,
} from './usefulness-scorer'

describe('deriveUsefulnessTier', () => {
  test('derives explicit only from record_decision decisions and constraints', () => {
    expect(
      deriveUsefulnessTier({
        kind: 'decision',
        provenance: { toolName: 'record_decision' },
      }),
    ).toBe('explicit')
    expect(
      deriveUsefulnessTier({
        kind: 'constraint',
        provenance: { toolName: 'record_decision' },
      }),
    ).toBe('explicit')
  })

  test('never derives explicit from non-agent-explicit provenance or kinds', () => {
    expect(
      deriveUsefulnessTier({
        kind: 'decision',
        provenance: { toolName: 'create_plan' },
      }),
    ).toBe('derived')
    expect(
      deriveUsefulnessTier({
        kind: 'discovery',
        provenance: { toolName: 'record_decision' },
      }),
    ).toBe('derived')
    expect(deriveUsefulnessTier({ kind: 'decision' })).toBe('derived')
    expect(
      deriveUsefulnessTier({ kind: 'decision', provenance: null }),
    ).toBe('derived')
  })

  test('derives outcome for outcome kind and derived otherwise', () => {
    expect(deriveUsefulnessTier({ kind: 'outcome' })).toBe('outcome')
    // record_decision provenance only elevates decisions/constraints; an
    // outcome stays in the outcome tier (architect ruling Q1).
    expect(
      deriveUsefulnessTier({
        kind: 'outcome',
        provenance: { toolName: 'record_decision' },
      }),
    ).toBe('outcome')
    expect(deriveUsefulnessTier({ kind: 'discovery' })).toBe('derived')
  })
})

describe('ageBucketDays', () => {
  test('buckets whole elapsed days deterministically', () => {
    const createdAt = '2025-01-02T00:00:00.000Z'
    expect(ageBucketDays(createdAt, '2025-01-02T00:00:00.000Z')).toBe(0)
    expect(ageBucketDays(createdAt, '2025-01-03T00:00:00.000Z')).toBe(1)
    // Jan 2 -> Mar 3 2025 (non-leap) is exactly 60 whole days.
    expect(ageBucketDays(createdAt, '2025-03-03T00:00:00.000Z')).toBe(60)
  })

  test('caps the bucket at 90 days', () => {
    const createdAt = '2025-01-02T00:00:00.000Z'
    expect(ageBucketDays(createdAt, '2025-04-03T00:00:00.000Z')).toBe(90)
    expect(ageBucketDays(createdAt, '2030-01-02T00:00:00.000Z')).toBe(90)
  })

  test('never calls Date.now: unparseable or inverted clocks bucket to 0', () => {
    expect(ageBucketDays('not-a-timestamp', '2025-01-02T00:00:00.000Z')).toBe(0)
    expect(ageBucketDays('2025-01-02T00:00:00.000Z', 'also-invalid')).toBe(0)
    expect(
      ageBucketDays('2025-01-03T00:00:00.000Z', '2025-01-02T00:00:00.000Z'),
    ).toBe(0)
  })
})

describe('scoreUsefulness', () => {
  const base = {
    used: 0,
    ignored: 0,
    staled: 0,
    reinforced: 0,
    pinned: 0,
    createdAtWall: '2025-01-02T00:00:00.000Z',
    asOfTurnWall: '2025-01-02T00:00:00.000Z',
    tier: 'derived' as const,
  }

  test('is reproducible: identical inputs yield deep-equal integer results', () => {
    const first = scoreUsefulness({ ...base, used: 3, ignored: 1 })
    const second = scoreUsefulness({ ...base, used: 3, ignored: 1 })
    expect(first).toEqual(second)
    expect(Number.isInteger(first.score)).toBe(true)
    expect(first.modelVersion).toBe(USEFULNESS_SCORE_MODEL_VERSION)
    expect(USEFULNESS_SCORE_MODEL_VERSION).toBe('usefulness-v1')
  })

  test('applies the isolated weight arithmetic per counter', () => {
    // w_used = 4: +1 used adds exactly 4 (from the zero-score base).
    expect(
      scoreUsefulness({ ...base, used: 1 }).score - scoreUsefulness(base).score,
    ).toBe(4)
    // With positive headroom (used: 2 -> score 8), the negative weights are
    // observable without clamping: w_ignore = 3 subtracts exactly 3.
    const headroom = { ...base, used: 2 }
    expect(scoreUsefulness(headroom).score).toBe(8)
    expect(
      scoreUsefulness(headroom).score -
        scoreUsefulness({ ...headroom, ignored: 1 }).score,
    ).toBe(3)
    // w_pin = 8: pinning adds exactly 8.
    expect(
      scoreUsefulness({ ...headroom, pinned: 1 }).score -
        scoreUsefulness(headroom).score,
    ).toBe(8)
    // w_age = 2: one extra day bucket subtracts exactly 2.
    expect(
      scoreUsefulness(headroom).score -
        scoreUsefulness({
          ...headroom,
          asOfTurnWall: '2025-01-03T00:00:00.000Z',
        }).score,
    ).toBe(2)
    // w_reinf = 6 (reserved, no P5 producers) and w_stale = 5 (reserved)
    // are documented: callers pass 0 today.
  })

  test('enforces the agent-explicit age floor only for explicit tier', () => {
    // Old, ignored explicit decision: raw 0 - 3*1 - 2*90 clamps to 0, floor
    // lifts it to 12.
    const explicit = scoreUsefulness({
      ...base,
      ignored: 1,
      tier: 'explicit',
      asOfTurnWall: '2025-07-01T00:00:00.000Z',
    })
    expect(explicit.score).toBe(12)
    // Equally-ignored derived observation: clamps to 0, no floor.
    const derived = scoreUsefulness({
      ...base,
      ignored: 1,
      tier: 'derived',
      asOfTurnWall: '2025-07-01T00:00:00.000Z',
    })
    expect(derived.score).toBe(0)
    expect(explicit.score).toBeGreaterThan(derived.score)
  })

  test('clamps negative and huge counters and keeps the final score in [0,1000]', () => {
    expect(scoreUsefulness({ ...base, used: -50 }).score).toBe(0)
    expect(
      scoreUsefulness({ ...base, ignored: -50, tier: 'derived' }).score,
    ).toBe(0)
    expect(scoreUsefulness({ ...base, used: 10_000_000 }).score).toBe(1000)
    expect(scoreUsefulness({ ...base, ignored: 10_000_000 }).score).toBe(0)
    for (const used of [-10, 0, 1, 999_999, 10_000_000]) {
      const { score } = scoreUsefulness({ ...base, used })
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1000)
    }
  })
})
