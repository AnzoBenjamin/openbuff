/**
 * Hermetic unit tests for the OpenAI provider-vs-estimator token-count
 * calibration harness (P3-T10 evidence generator).
 *
 * The harness itself is network-gated on OPENAI_API_KEY, so these tests
 * inject a mocked fetch that NEVER touches the network: provider counts come
 * from the mock, while the estimator side runs the real (local,
 * deterministic) gpt-4o BPE via countTokens/countTokensJson. The assertions
 * pin the ratio-computation and tolerance-verdict logic: estimator/provider
 * per workload, the aggregate mean, and the inclusive
 * |factor - ratio| <= tolerance band.
 */
import { describe, expect, test } from 'bun:test'

import {
  aggregateMeasuredRatio,
  CALIBRATION_TOLERANCE,
  CALIBRATION_WORKLOADS,
  formatCalibrationReport,
  ratioForWorkload,
  runCalibration,
  verdictForRatio,
  type TokenCountFetch,
} from '../calibrate-openai-tokens'

interface FetchCall {
  url: string
  headers: Record<string, string>
  body: { model: unknown; input: unknown }
}

/**
 * Builds the mocked OpenAI fetch: returns the queued provider counts in call
 * order and records every request so tests can assert the endpoint/auth
 * pattern. Never performs I/O.
 */
function mockFetchWithProviderCounts(providerCounts: readonly number[]): {
  fetchImpl: TokenCountFetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  let index = 0
  const fetchImpl: TokenCountFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    const inputTokens =
      providerCounts[Math.min(index, providerCounts.length - 1)]
    index += 1
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        object: 'response.input_tokens',
        input_tokens: inputTokens,
      }),
    }
  }
  return { fetchImpl, calls }
}

describe('calibrate-openai-tokens (hermetic, mocked fetch)', () => {
  test('computes estimator/provider ratio per workload and the aggregate mean', async () => {
    const providerCounts = CALIBRATION_WORKLOADS.map((_, i) => 100 * (i + 1))
    const { fetchImpl, calls } = mockFetchWithProviderCounts(providerCounts)

    const report = await runCalibration({ apiKey: 'test-key', fetchImpl })

    // One provider call per workload, against the real endpoint/auth shape.
    expect(calls.length).toBe(CALIBRATION_WORKLOADS.length)
    for (const call of calls) {
      expect(call.url).toBe(
        'https://api.openai.com/v1/responses/input_tokens',
      )
      expect(call.headers.Authorization).toBe('Bearer test-key')
      expect(call.headers['Content-Type']).toBe('application/json')
      expect(call.body.model).toBe('gpt-4o')
    }

    // Per-workload ratio is estimator/provider against the mocked counts.
    expect(report.workloads.length).toBe(CALIBRATION_WORKLOADS.length)
    report.workloads.forEach((result, i) => {
      expect(result.name).toBe(CALIBRATION_WORKLOADS[i].name)
      expect(result.estimatorTokens).toBeGreaterThan(0)
      expect(result.providerTokens).toBe(providerCounts[i])
      expect(result.ratio).toBe(result.estimatorTokens / providerCounts[i])
    })

    // Aggregate is the arithmetic mean of the per-workload ratios.
    const expectedAggregate =
      report.workloads.reduce(
        (sum, result) => sum + result.estimatorTokens / result.providerTokens,
        0,
      ) / report.workloads.length
    expect(report.aggregateRatio).toBe(expectedAggregate)
    expect(report.aggregateRatio).toBe(
      aggregateMeasuredRatio(report.workloads.map((result) => result.ratio)),
    )
  })

  test('reports "within tolerance" when the provider matches the estimator (ratio 1.0)', async () => {
    // The provider "agrees" exactly: mock returns the estimator's own count
    // per workload, so every ratio is exactly 1.0.
    const providerCounts = CALIBRATION_WORKLOADS.map((workload) =>
      workload.estimate(),
    )
    const { fetchImpl } = mockFetchWithProviderCounts(providerCounts)

    const report = await runCalibration({ apiKey: 'test-key', fetchImpl })

    for (const result of report.workloads) {
      expect(result.ratio).toBe(1)
    }
    expect(report.aggregateRatio).toBe(1)
    // OPENAI_TOKEN_FUDGE_FACTOR for the openai/gpt-4o estimator is 1.0.
    expect(report.fudgeFactor).toBe(1)
    expect(report.tolerance).toBe(CALIBRATION_TOLERANCE)
    expect(report.verdict).toBe('within tolerance')

    const output = formatCalibrationReport(report)
    expect(output).toContain('within tolerance')
    expect(output).toContain('OPENAI_TOKEN_FUDGE_FACTOR')
    // Anthropic/Gemini deferral note (usage-based calibration).
    expect(output).toContain('Anthropic')
    expect(output).toContain('Gemini')
    expect(output).toContain('usage.input_tokens')
  })

  test('reports "out of tolerance" when the estimator is 2x the provider', async () => {
    // Mock returns half the estimator count per workload, so every ratio is
    // exactly 2.0 (IEEE-exact: n / (n / 2) === 2).
    const providerCounts = CALIBRATION_WORKLOADS.map(
      (workload) => workload.estimate() / 2,
    )
    const { fetchImpl } = mockFetchWithProviderCounts(providerCounts)

    const report = await runCalibration({ apiKey: 'test-key', fetchImpl })

    for (const result of report.workloads) {
      expect(result.ratio).toBe(2)
    }
    expect(report.aggregateRatio).toBe(2)
    expect(report.verdict).toBe('out of tolerance')
    expect(formatCalibrationReport(report)).toContain('out of tolerance')
  })

  test('throws a clear error without OPENAI_API_KEY and never calls fetch', async () => {
    const { fetchImpl, calls } = mockFetchWithProviderCounts([1])

    await expect(
      runCalibration({ apiKey: undefined, fetchImpl }),
    ).rejects.toThrow('OPENAI_API_KEY environment variable is required')
    expect(calls.length).toBe(0)
  })

  describe('pure ratio/verdict helpers', () => {
    test('ratioForWorkload divides estimator by provider', () => {
      expect(ratioForWorkload(50, 100)).toBe(0.5)
      expect(ratioForWorkload(100, 50)).toBe(2)
      expect(ratioForWorkload(100, 100)).toBe(1)
    })

    test('aggregateMeasuredRatio is the arithmetic mean', () => {
      expect(aggregateMeasuredRatio([0.5, 1, 1.5])).toBe(1)
      expect(aggregateMeasuredRatio([0.8, 1.2])).toBeCloseTo(1, 10)
      expect(aggregateMeasuredRatio([2, 2, 2, 2, 2])).toBe(2)
    })

    test('verdictForRatio band is inclusive at |factor - ratio| <= tolerance', () => {
      // Binary-exact values (0.125 = 2^-3) avoid float noise at the band edge.
      expect(verdictForRatio(1, 1, CALIBRATION_TOLERANCE)).toBe(
        'within tolerance',
      )
      expect(verdictForRatio(1.125, 1, 0.125)).toBe('within tolerance')
      expect(verdictForRatio(0.875, 1, 0.125)).toBe('within tolerance')
      expect(verdictForRatio(1.25, 1, 0.125)).toBe('out of tolerance')
      expect(verdictForRatio(0.75, 1, 0.125)).toBe('out of tolerance')
      expect(verdictForRatio(2, 1, CALIBRATION_TOLERANCE)).toBe(
        'out of tolerance',
      )
    })
  })
})
