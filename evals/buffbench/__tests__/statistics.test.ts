import { describe, expect, it } from 'bun:test'

import {
  makeSeededRng,
  mean,
  pairedBootstrapMeanDiffCI,
  sampleStandardDeviation,
  standardError,
  wilcoxonSignedRankTest,
} from '../statistics'

describe('mean', () => {
  it('returns 0 for empty input', () => {
    expect(mean([])).toBe(0)
  })

  it('returns the single value for a singleton', () => {
    expect(mean([7])).toBe(7)
  })

  it('computes the mean of a known vector', () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5)
  })
})

describe('sampleStandardDeviation', () => {
  it('returns 0 for empty and singleton input', () => {
    expect(sampleStandardDeviation([])).toBe(0)
    expect(sampleStandardDeviation([5])).toBe(0)
  })

  it('uses the n-1 denominator on a known vector', () => {
    // For [2,4,4,4,5,5,7,9] the population SD is 2; with n-1 denominator the
    // sample SD is sqrt(32/7).
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(
      Math.sqrt(32 / 7),
      12,
    )
  })
})

describe('standardError', () => {
  it('returns 0 for empty and singleton input', () => {
    expect(standardError([])).toBe(0)
    expect(standardError([5])).toBe(0)
  })

  it('is sampleSD / sqrt(n)', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9]
    expect(standardError(xs)).toBeCloseTo(Math.sqrt(32 / 7) / Math.sqrt(8), 12)
  })
})

describe('makeSeededRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeSeededRng(42)
    const b = makeSeededRng(42)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('produces values in [0, 1)', () => {
    const rng = makeSeededRng(1)
    for (let i = 0; i < 100; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('produces different sequences for different seeds', () => {
    const a = makeSeededRng(1)
    const b = makeSeededRng(2)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })
})

describe('pairedBootstrapMeanDiffCI', () => {
  it('returns all zeros for empty pairs', () => {
    const result = pairedBootstrapMeanDiffCI([])
    expect(result.meanDiff).toBe(0)
    expect(result.lower).toBe(0)
    expect(result.upper).toBe(0)
  })

  it('computes the observed meanDiff correctly', () => {
    const pairs = [
      { before: 1, after: 3 },
      { before: 2, after: 4 },
      { before: 3, after: 5 },
    ]
    // diffs are all +2, so meanDiff = 2.
    const result = pairedBootstrapMeanDiffCI(pairs, { iterations: 500, seed: 7 })
    expect(result.meanDiff).toBe(2)
    // With a constant diff the CI collapses to the point estimate.
    expect(result.lower).toBe(2)
    expect(result.upper).toBe(2)
  })

  it('is reproducible under a fixed seed and brackets meanDiff', () => {
    const pairs = [
      { before: 1, after: 2 },
      { before: 2, after: 5 },
      { before: 3, after: 3 },
      { before: 4, after: 8 },
      { before: 5, after: 6 },
    ]
    const a = pairedBootstrapMeanDiffCI(pairs, { iterations: 1000, seed: 3 })
    const b = pairedBootstrapMeanDiffCI(pairs, { iterations: 1000, seed: 3 })
    expect(a).toEqual(b)
    expect(a.lower).toBeLessThanOrEqual(a.meanDiff)
    expect(a.upper).toBeGreaterThanOrEqual(a.meanDiff)
  })
})

describe('wilcoxonSignedRankTest', () => {
  it('returns n 0 and p 1 when all diffs are zero', () => {
    const pairs = [
      { before: 1, after: 1 },
      { before: 2, after: 2 },
    ]
    const result = wilcoxonSignedRankTest(pairs)
    expect(result.n).toBe(0)
    expect(result.pValueTwoSided).toBe(1)
    expect(result.statistic).toBe(0)
    expect(result.z).toBe(0)
  })

  it('returns a small p for a clearly-shifted set', () => {
    // Every pair improves substantially.
    const pairs = Array.from({ length: 12 }, (_, i) => ({
      before: i,
      after: i + 5,
    }))
    const result = wilcoxonSignedRankTest(pairs)
    expect(result.n).toBe(12)
    expect(result.pValueTwoSided).toBeLessThan(0.05)
  })

  it('returns p near 1 for a symmetric/no-effect set', () => {
    // Balanced positive and negative diffs of equal magnitude.
    const pairs = [
      { before: 0, after: 1 },
      { before: 0, after: -1 },
      { before: 0, after: 2 },
      { before: 0, after: -2 },
      { before: 0, after: 3 },
      { before: 0, after: -3 },
    ]
    const result = wilcoxonSignedRankTest(pairs)
    expect(result.pValueTwoSided).toBeGreaterThan(0.9)
  })
})
