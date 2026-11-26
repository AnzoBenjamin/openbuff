import { describe, expect, test } from 'bun:test'
import {
  computeCostCentsFromUsage,
  calculateProviderCostCents,
  providerCostDollars,
} from '../cost-accounting'
const pricing = {
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
  currency: 'USD',
}
describe('B09 cost precision and unknown data', () => {
  test('preserves sub-cent configured prices without per-request rounding', () => {
    expect(
      computeCostCentsFromUsage({
        usage: { inputTokens: 1, outputTokens: 1 },
        pricing,
      }),
    ).toBeCloseTo(0.0018, 12)
  })
  test('missing or malformed counts never become a zero-cost completed request', () => {
    for (const usage of [
      {},
      { inputTokens: 3 },
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: NaN, outputTokens: 0 },
      { inputTokens: 1, outputTokens: 0, cachedInputTokens: 2 },
    ])
      expect(computeCostCentsFromUsage({ usage, pricing })).toBeUndefined()
  })
  test('provider metadata preserves exact zero and fractional cost but never converts absent/null/invalid into zero', () => {
    expect(calculateProviderCostCents(0.000018)).toBeCloseTo(0.0018, 12)
    expect(calculateProviderCostCents(0)).toBe(0)
    for (const metadata of [
      undefined,
      {},
      { codebuff: { usage: {} } },
      { codebuff: { usage: { cost: null } } },
      { codebuff: { usage: { cost: -1 } } },
      { codebuff: { usage: { cost: '0' } } },
    ])
      expect(providerCostDollars(metadata)).toBeUndefined()
    expect(providerCostDollars({ codebuff: { usage: { cost: 0 } } })).toBe(0)
    expect(
      providerCostDollars({ codebuff: { usage: { cost: 0.000018 } } }),
    ).toBe(0.000018)
  })
  test('positive unpriced components and non-USD currency do not fabricate USD totals', () => {
    expect(
      computeCostCentsFromUsage({
        usage: { inputTokens: 1, outputTokens: 1 },
        pricing: { inputPerMillionTokens: 3 },
      }),
    ).toBeUndefined()
    expect(
      computeCostCentsFromUsage({
        usage: { inputTokens: 1, outputTokens: 0 },
        pricing: { inputPerMillionTokens: 3 },
      }),
    ).toBeUndefined()
    expect(
      computeCostCentsFromUsage({
        usage: { inputTokens: 1, outputTokens: 0 },
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 15,
        },
      }),
    ).toBeUndefined()
    expect(
      computeCostCentsFromUsage({
        usage: { inputTokens: 1, outputTokens: 0 },
        pricing: { ...pricing, currency: 'EUR' },
      }),
    ).toBeUndefined()
    expect(
      computeCostCentsFromUsage({
        usage: { inputTokens: 0, outputTokens: 0 },
        pricing: {
          inputPerMillionTokens: 0,
          outputPerMillionTokens: 0,
          currency: 'USD',
        },
      }),
    ).toBe(0)
  })
})
