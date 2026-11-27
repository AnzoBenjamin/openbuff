import { expect, test } from 'bun:test'
import {
  computeCostCentsFromUsage,
  normalizeProviderUsage,
} from '../cost-accounting'

const completeAnthropicMetadata = {
  anthropic: {
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    },
    cacheCreationInputTokens: 200,
  },
}

test('Anthropic raw input excludes cache reads and writes while compatible input already includes cache', () => {
  const usage = normalizeProviderUsage(
    { inputTokens: 100, outputTokens: 20, cachedInputTokens: 1000 },
    completeAnthropicMetadata,
    'anthropic',
  )
  expect(usage).toMatchObject({
    inputTokens: 1300,
    outputTokens: 20,
    cachedInputTokens: 1000,
    cacheWriteInputTokens: 200,
    totalTokens: 1320,
    accountingComplete: true,
  })
  expect(
    computeCostCentsFromUsage({
      usage,
      pricing: {
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        cachedInputPerMillionTokens: 0.3,
        cacheWriteInputPerMillionTokens: 3.75,
        currency: 'USD',
      },
    }),
  ).toBeCloseTo(0.165, 12)
  expect(
    normalizeProviderUsage(
      {
        inputTokens: 1300,
        outputTokens: 20,
        cachedInputTokens: 1000,
        totalTokens: 1320,
      },
      undefined,
      'compatible',
    ),
  ).toMatchObject({
    inputTokens: 1300,
    cachedInputTokens: 1000,
    accountingComplete: true,
  })
})

test('compatible totals must agree with the canonical input plus output sum', () => {
  const usage = normalizeProviderUsage(
    {
      inputTokens: 20_000,
      outputTokens: 10_000,
      totalTokens: 1,
    },
    undefined,
    'compatible',
  )
  expect(usage).toMatchObject({
    inputTokens: 20_000,
    outputTokens: 10_000,
    accountingComplete: false,
  })
  expect(
    computeCostCentsFromUsage({
      usage,
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    }),
  ).toBeUndefined()
})

test('missing, contradictory, overflowing, or impossible cache counts stay unknown', () => {
  for (const raw of [
    { input_tokens: 100, output_tokens: 20 },
    {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: -1,
      cache_creation_input_tokens: 0,
    },
    {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
  ]) {
    const usage = normalizeProviderUsage(
      { inputTokens: 100, outputTokens: 20 },
      { anthropic: { usage: raw } },
      'anthropic',
    )
    expect(usage.accountingComplete).toBe(false)
    expect(
      computeCostCentsFromUsage({
        usage,
        pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
      }),
    ).toBeUndefined()
  }

  const overflow = normalizeProviderUsage(
    {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
    },
    undefined,
  )
  expect(overflow).toMatchObject({
    totalTokens: undefined,
    accountingComplete: false,
  })
  expect(
    computeCostCentsFromUsage({
      usage: overflow,
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    }),
  ).toBeUndefined()
  expect(
    computeCostCentsFromUsage({
      usage: {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
      },
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    }),
  ).toBeUndefined()
  expect(
    computeCostCentsFromUsage({
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 11 },
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    }),
  ).toBeUndefined()

  const contradictory = normalizeProviderUsage(
    { inputTokens: 100, outputTokens: 20 },
    {
      anthropic: {
        ...completeAnthropicMetadata.anthropic,
        cacheCreationInputTokens: 201,
      },
    },
    'anthropic',
  )
  expect(contradictory).toMatchObject({
    inputTokens: undefined,
    accountingComplete: false,
  })

  const impossibleCompatible = normalizeProviderUsage(
    {
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 30,
    },
    undefined,
  )
  expect(impossibleCompatible.accountingComplete).toBe(false)
  expect(
    computeCostCentsFromUsage({
      usage: impossibleCompatible,
      pricing: {
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        cachedInputPerMillionTokens: 0.3,
        cacheWriteInputPerMillionTokens: 3.75,
      },
    }),
  ).toBeUndefined()
})

test('positive cache writes require a price, while an all-write request can use a cache-write-only rate', () => {
  const usage = {
    inputTokens: 200,
    outputTokens: 0,
    cacheWriteInputTokens: 200,
  }
  expect(
    computeCostCentsFromUsage({
      usage,
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    }),
  ).toBeUndefined()
  expect(
    computeCostCentsFromUsage({
      usage,
      pricing: {
        cacheWriteInputPerMillionTokens: 3.75,
        currency: 'USD',
      },
    }),
  ).toBeCloseTo(0.075, 12)
})
