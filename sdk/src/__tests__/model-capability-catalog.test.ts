import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { MODELS_DEV_CAPABILITY_CATALOG } from '../generated/models-dev-capabilities.generated'
import {
  MODELS_DEV_CATALOG_PROVENANCE,
  MODELS_DEV_UPSTREAM_LICENSE_NOTICE,
  resolveModelsDevModelCapabilities,
  shouldDefaultIncludeUsage,
} from '../model-capability-catalog'
import {
  providerConfigFileSchema,
  resolveModelCapabilities,
} from '../provider-config'

import type {
  LoadedProviderConfig,
  ProviderConfigFileInput,
} from '../provider-config'

const loaded = (input: ProviderConfigFileInput): LoadedProviderConfig =>
  ({
    config: providerConfigFileSchema.parse(input),
    sourceFilePaths: [],
  }) as LoadedProviderConfig

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

describe('models.dev capability catalog', () => {
  test('pins the observed upstream revision, payload, artifact, and MIT license', () => {
    expect(MODELS_DEV_CATALOG_PROVENANCE).toMatchObject({
      schemaVersion: 1,
      sourceUrl: 'https://models.dev/api.json',
      sourceRepository: 'https://github.com/anomalyco/models.dev',
      sourceRevision: 'c2b10ec21b6ac2c856b74a08d872af5a54833954',
      sourcePayloadSha256:
        '0e9a324d88b32ad6e14075997b9f1a0f71e367be0bebfb25b8404701ca03bd1f',
      generatedAt: '2026-11-25T22:30:58.000Z',
      catalogSha256:
        '504abb06a14a15a129e0d6ed4a710d15e44bfda95b3e519208a78bfc6661c5dd',
      license: 'MIT',
      licenseUrl:
        'https://github.com/anomalyco/models.dev/blob/c2b10ec21b6ac2c856b74a08d872af5a54833954/LICENSE',
    })
    expect(MODELS_DEV_UPSTREAM_LICENSE_NOTICE).toContain(
      'Copyright (c) 2025 models.dev',
    )
    expect(MODELS_DEV_UPSTREAM_LICENSE_NOTICE).toContain(
      'The above copyright notice and this permission notice shall be included',
    )
    expect(MODELS_DEV_CATALOG_PROVENANCE.catalogSha256).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(MODELS_DEV_CATALOG_PROVENANCE.sourceRevisionAttestedByApi).toBe(
      false,
    )
    expect(Object.keys(MODELS_DEV_CAPABILITY_CATALOG)).toEqual([
      'anthropic',
      'openai',
      'openrouter',
    ])
    expect(Object.keys(MODELS_DEV_CAPABILITY_CATALOG.anthropic)).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-sonnet-5-5',
    ])
    expect(Object.keys(MODELS_DEV_CAPABILITY_CATALOG.openai)).toEqual([
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.5',
      'gpt-6.2-sol',
    ])
    expect(Object.keys(MODELS_DEV_CAPABILITY_CATALOG.openrouter)).toEqual([
      'anthropic/claude-opus-4.1',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-sonnet-5.5',
      'openai/gpt-4.1-mini',
      'openai/gpt-6.2-sol',
    ])
    expect(
      createHash('sha256')
        .update(JSON.stringify(canonicalize(MODELS_DEV_CAPABILITY_CATALOG)))
        .digest('hex'),
    ).toBe(MODELS_DEV_CATALOG_PROVENANCE.catalogSha256)
  })

  test('maps exact canonical OpenAI, Anthropic, and OpenRouter records', () => {
    expect(
      resolveModelsDevModelCapabilities({
        providerType: 'openai-compatible',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      }),
    ).toEqual({
      context: { windowTokens: 400_000, outputTokens: 128_000 },
      reasoning: { supported: true },
      pricing: {
        inputPerMillionTokens: 0.75,
        outputPerMillionTokens: 4.5,
        cachedInputPerMillionTokens: 0.075,
        currency: 'USD',
      },
    })

    expect(
      resolveModelsDevModelCapabilities({
        providerType: 'anthropic-compatible',
        baseURL: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
      }),
    ).toEqual({
      context: { windowTokens: 200_000, outputTokens: 64_000 },
      reasoning: { supported: true },
      pricing: {
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        cachedInputPerMillionTokens: 0.3,
        cacheWriteInputPerMillionTokens: 3.75,
        currency: 'USD',
      },
    })

    expect(
      resolveModelsDevModelCapabilities({
        providerType: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-5.5',
      }),
    ).toEqual({
      context: { windowTokens: 1_000_000, outputTokens: 128_000 },
      reasoning: { supported: true },
      pricing: {
        inputPerMillionTokens: 2,
        outputPerMillionTokens: 10,
        cachedInputPerMillionTokens: 0.1,
        cacheWriteInputPerMillionTokens: 2.5,
        currency: 'USD',
      },
    })
  })

  test('retains limits but omits a conditionally tiered pricing schedule', () => {
    expect(
      resolveModelsDevModelCapabilities({
        providerType: 'openai-compatible',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-5.5',
      }),
    ).toEqual({
      context: { windowTokens: 1_050_000, outputTokens: 128_000 },
      reasoning: { supported: true },
    })
  })

  test('does not guess across endpoints, provider routes, punctuation, dates, or unknown ids', () => {
    for (const request of [
      {
        providerType: 'openai-compatible' as const,
        baseURL: 'https://gateway.example.com/v1',
        model: 'gpt-5.4-mini',
      },
      {
        providerType: 'openai-compatible' as const,
        baseURL: 'https://api.openai.com/v1/proxy',
        model: 'gpt-5.4-mini',
      },
      {
        providerType: 'openai-compatible' as const,
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'claude-sonnet-5-5',
      },
      {
        providerType: 'anthropic-compatible' as const,
        baseURL: 'https://api.anthropic.com',
        model: 'claude-sonnet-5.5',
      },
      {
        providerType: 'openai-compatible' as const,
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini-latest',
      },
      {
        providerType: 'chatgpt-oauth' as const,
        baseURL: undefined,
        model: 'gpt-5.4-mini',
      },
    ]) {
      expect(resolveModelsDevModelCapabilities(request)).toBeUndefined()
    }
  })

  test('uses an explicit model map but never overrides or completes explicit pricing', () => {
    const config = loaded({
      providers: {
        privateName: {
          type: 'openai-compatible',
          baseURL: 'https://api.openai.com/v1',
          models: { 'privateName/coder': 'gpt-5.4-mini' },
          defaultCapabilities: {
            context: { windowTokens: 123_456 },
            pricing: { inputPerMillionTokens: 99 },
          },
        },
      },
    })
    expect(
      resolveModelCapabilities({
        providerId: 'privateName',
        model: 'privateName/coder',
        loadedConfig: config,
      }),
    ).toEqual({
      context: { windowTokens: 123_456, outputTokens: 128_000 },
      reasoning: { supported: true },
      pricing: { inputPerMillionTokens: 99 },
    })
  })

  test('replaces explicit pricing layers atomically across conflicting currencies', () => {
    const config = loaded({
      providers: {
        openai: {
          type: 'openai-compatible',
          baseURL: 'https://api.openai.com/v1',
          models: ['gpt-5.4-mini'],
          defaultCapabilities: {
            pricing: {
              inputPerMillionTokens: 1,
              outputPerMillionTokens: 15,
              currency: 'USD',
            },
          },
          modelCapabilities: {
            'gpt-5.4-mini': {
              pricing: { inputPerMillionTokens: 2, currency: 'EUR' },
            },
          },
        },
      },
    })
    expect(
      resolveModelCapabilities({
        providerId: 'openai',
        model: 'openai/gpt-5.4-mini',
        loadedConfig: config,
      }).pricing,
    ).toEqual({ inputPerMillionTokens: 2, currency: 'EUR' })
  })

  test('defaults late stream usage only for exact canonical OpenAI and OpenRouter endpoints', () => {
    expect(
      shouldDefaultIncludeUsage({
        providerType: 'openai-compatible',
        baseURL: 'https://api.openai.com/v1',
      }),
    ).toBe(true)
    expect(
      shouldDefaultIncludeUsage({
        providerType: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1/',
      }),
    ).toBe(true)
    expect(
      shouldDefaultIncludeUsage({
        providerType: 'openai-compatible',
        baseURL: 'https://gateway.example.com/v1',
      }),
    ).toBe(false)
    expect(
      shouldDefaultIncludeUsage({
        providerType: 'anthropic-compatible',
        baseURL: 'https://api.anthropic.com',
      }),
    ).toBe(false)
  })
})
