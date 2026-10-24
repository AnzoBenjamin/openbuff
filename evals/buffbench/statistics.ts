/**
 * P0-T6: Pure, dependency-free statistical helpers for the BuffBench eval
 * harness. Every function here is deterministic and side-effect free, handles
 * empty/singleton inputs safely (documented per-function return), and never
 * NaN-propagates silently. No npm imports are permitted in this module.
 */

/**
 * Arithmetic mean of the input values.
 *
 * @returns the mean, or `0` for an empty array.
 */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  let sum = 0
  for (const x of xs) sum += x
  return sum / xs.length
}

/**
 * Sample standard deviation using the n-1 (Bessel-corrected) denominator.
 *
 * @returns `0` when fewer than 2 values are provided.
 */
export function sampleStandardDeviation(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let sumSq = 0
  for (const x of xs) {
    const d = x - m
    sumSq += d * d
  }
  return Math.sqrt(sumSq / (xs.length - 1))
}

/**
 * Standard error of the mean: sampleStandardDeviation / sqrt(n).
 *
 * @returns `0` when fewer than 2 values are provided.
 */
export function standardError(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  return sampleStandardDeviation(xs) / Math.sqrt(xs.length)
}

/**
 * Create a deterministic mulberry32 pseudo-random generator.
 *
 * @param seed integer seed; the same seed always yields the same sequence.
 * @returns a function producing numbers in the half-open interval [0, 1).
 */
export function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0
  return function (): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Paired bootstrap confidence interval for the mean of per-pair differences
 * (after - before). Resamples the diffs with replacement using a seeded RNG
 * for reproducibility and returns the observed mean diff plus percentile CI
 * bounds.
 *
 * @returns all zeros (`meanDiff`, `lower`, `upper` = 0) when `pairs` is empty.
 */
export function pairedBootstrapMeanDiffCI(
  pairs: ReadonlyArray<{ before: number; after: number }>,
  options?: { iterations?: number; seed?: number; confidence?: number },
): { meanDiff: number; lower: number; upper: number; iterations: number } {
  const iterations = options?.iterations ?? 2000
  const seed = options?.seed ?? 1
  const confidence = options?.confidence ?? 0.95

  if (pairs.length === 0) {
    return { meanDiff: 0, lower: 0, upper: 0, iterations }
  }

  const diffs = pairs.map((p) => p.after - p.before)
  const observedMeanDiff = mean(diffs)

  const n = diffs.length
  const rng = makeSeededRng(seed)
  const bootMeans: number[] = new Array(iterations)
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n)
      sum += diffs[idx]
    }
    bootMeans[i] = sum / n
  }

  bootMeans.sort((a, b) => a - b)
  const alpha = 1 - confidence
  const lowerIdx = Math.floor((alpha / 2) * iterations)
  const upperIdx = Math.min(
    iterations - 1,
    Math.ceil((1 - alpha / 2) * iterations) - 1,
  )

  return {
    meanDiff: observedMeanDiff,
    lower: bootMeans[lowerIdx],
    upper: bootMeans[upperIdx],
    iterations,
  }
}

/**
 * Standard normal cumulative distribution function, implemented locally via
 * the Abramowitz-Stegun 7.1.26 erf approximation. Deterministic.
 */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/**
 * Error function approximation (Abramowitz & Stegun 7.1.26). Deterministic and
 * dependency-free. Maximum absolute error ~1.5e-7.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

/**
 * P8-T4a: minimum number of nonzero paired differences required before the
 * Wilcoxon normal approximation (with continuity and tie corrections) is
 * considered reliable. Below this, the test reports a structured
 * not-applicable verdict instead of a computed p-value.
 */
export const WILCOXON_NORMAL_APPROX_MIN_N = 10

/** Reason reported when the Wilcoxon normal approximation is not applicable. */
export const WILCOXON_NOT_APPLICABLE_REASON =
  'n < 10; normal approximation unreliable'

/**
 * Result of the Wilcoxon signed-rank test. `applicable` is false when the
 * normal approximation was not applied (n below WILCOXON_NORMAL_APPROX_MIN_N);
 * `reason` then explains why and `pValueTwoSided` carries the neutral 1 rather
 * than a computed value. Callers must treat a not-applicable result as NOT
 * significant.
 */
export interface WilcoxonSignedRankResult {
  statistic: number
  n: number
  z: number
  pValueTwoSided: number
  applicable: boolean
  reason?: string
}

/**
 * Wilcoxon signed-rank test on the nonzero per-pair differences
 * (after - before). Zero diffs are dropped before ranking; tied absolute
 * differences receive average ranks. W is the sum of positive ranks. The
 * normal approximation with continuity and tie corrections gives z, and the
 * two-sided p-value is derived from the local normal CDF.
 *
 * P8-T4a: the normal approximation is applied only when n (the count of
 * nonzero diffs) is at least WILCOXON_NORMAL_APPROX_MIN_N. Below that the
 * result is a structured not-applicable verdict, not a computed p-value.
 *
 * @returns `{applicable: false, reason}` with `pValueTwoSided: 1` when there
 *   are fewer than WILCOXON_NORMAL_APPROX_MIN_N nonzero diffs (including the
 *   empty/`pairs`-empty case, where `n` is 0). `n` is the count of nonzero
 *   diffs.
 */
export function wilcoxonSignedRankTest(
  pairs: ReadonlyArray<{ before: number; after: number }>,
): WilcoxonSignedRankResult {
  const diffs = pairs
    .map((p) => p.after - p.before)
    .filter((d) => d !== 0)

  const n = diffs.length
  if (n === 0) {
    return {
      statistic: 0,
      n: 0,
      z: 0,
      pValueTwoSided: 1,
      applicable: false,
      reason: WILCOXON_NOT_APPLICABLE_REASON,
    }
  }

  // Rank by absolute value with average ranks for ties.
  const indexed = diffs.map((d) => ({ abs: Math.abs(d), sign: d > 0 ? 1 : -1 }))
  indexed.sort((a, b) => a.abs - b.abs)

  const ranks: number[] = new Array(n)
  const tieSizes: number[] = []
  let i = 0
  while (i < n) {
    let j = i
    while (j < n - 1 && indexed[j + 1].abs === indexed[i].abs) {
      j++
    }
    // Positions i..j (0-indexed) are tied; ranks are 1-indexed.
    const groupSize = j - i + 1
    const averageRank = (i + 1 + (j + 1)) / 2
    for (let k = i; k <= j; k++) {
      ranks[k] = averageRank
    }
    if (groupSize > 1) tieSizes.push(groupSize)
    i = j + 1
  }

  // W = sum of positive ranks.
  let W = 0
  for (let k = 0; k < n; k++) {
    if (indexed[k].sign > 0) W += ranks[k]
  }

  // P8-T4a: the normal approximation is only reliable for sufficiently large
  // samples. Below the minimum n, return a structured not-applicable verdict
  // instead of a fake p-value; callers must treat this as NOT significant.
  if (n < WILCOXON_NORMAL_APPROX_MIN_N) {
    return {
      statistic: W,
      n,
      z: 0,
      pValueTwoSided: 1,
      applicable: false,
      reason: WILCOXON_NOT_APPLICABLE_REASON,
    }
  }

  const meanW = (n * (n + 1)) / 4
  const tieCorrection =
    tieSizes.reduce((sum, t) => sum + (t * t * t - t), 0) / 48
  const varW = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection

  if (varW <= 0) {
    return {
      statistic: W,
      n,
      z: 0,
      pValueTwoSided: 1,
      applicable: true,
    }
  }

  // Continuity correction toward the mean.
  const diff = W - meanW
  const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0
  const z = (diff - sign * 0.5) / Math.sqrt(varW)
  const pValueTwoSided = 2 * (1 - normalCdf(Math.abs(z)))

  return {
    statistic: W,
    n,
    z,
    pValueTwoSided: Math.min(1, Math.max(0, pValueTwoSided)),
    applicable: true,
  }
}
