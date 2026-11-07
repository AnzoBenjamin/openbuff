import { describe, expect, test } from 'bun:test'

import { MAX_TRANSPORT_SAFE_PAYLOAD_BYTES } from '@codebuff/common/actions'

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  getMaxOutputBytesForModel,
} from '../provider-config'
import type { ProviderConfig } from '../provider-config'

// Minimal structural fixture: only the capability fields the band resolver
// reads (and the models list, for alias-key tests) are varied; the remaining
// output-typed fields are irrelevant here.
const provider = (capabilities: {
  defaultMaxOutputBytes?: number
  modelMaxOutputBytes?: Record<string, number>
  /** Overrides the models list so provider-mapped alias keys can be exercised. */
  models?: string[] | Record<string, string>
}): ProviderConfig =>
  ({
    type: 'openai-compatible',
    baseURL: 'https://band.test/v1',
    models:
      capabilities.models ??
      Object.keys(capabilities.modelMaxOutputBytes ?? { m1: 0 }),
    supportsStructuredOutputs: false,
    compatibility: {
      stripCacheControl: true,
      stringifyTextContent: true,
      supportsTools: true,
      supportsRequiredToolChoice: true,
      supportsStopSequences: false,
      stripProviderMetadata: true,
    },
    ...(capabilities.defaultMaxOutputBytes !== undefined
      ? {
          defaultCapabilities: {
            maxOutputBytes: capabilities.defaultMaxOutputBytes,
          },
        }
      : {}),
    ...(capabilities.modelMaxOutputBytes !== undefined
      ? {
          modelCapabilities: Object.fromEntries(
            Object.entries(capabilities.modelMaxOutputBytes).map(
              ([model, maxOutputBytes]) => [model, { maxOutputBytes }],
            ),
          ),
        }
      : {}),
  }) as unknown as ProviderConfig

describe('transport band config contract', () => {
  test('DEFAULT_MAX_OUTPUT_BYTES is the common transport band, not a copy', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(MAX_TRANSPORT_SAFE_PAYLOAD_BYTES)
  })

  test('per-model override wins over defaultCapabilities', () => {
    const providerConfig = provider({
      defaultMaxOutputBytes: 123,
      modelMaxOutputBytes: { 'm-override': 456 },
    })
    expect(getMaxOutputBytesForModel(providerConfig, 'm-override')).toBe(456)
  })

  test('defaultCapabilities.maxOutputBytes is the fallback', () => {
    const providerConfig = provider({ defaultMaxOutputBytes: 123 })
    expect(getMaxOutputBytesForModel(providerConfig, 'm-other')).toBe(123)
  })

  test('defaultCapabilities.maxOutputBytes stays the fallback when providerId finds no per-model override', () => {
    // With providerId the resolver walks the capability-key candidates
    // (mapped, provider-qualified mapped, unprefixed, raw). When none of them
    // carries a maxOutputBytes override, the provider-level default must still
    // apply — passing providerId must not fall through to the common band.
    const providerConfig = provider({
      defaultMaxOutputBytes: 123,
      models: { 'm-alias': 'mapped-no-override' },
    })
    expect(getMaxOutputBytesForModel(providerConfig, 'm-alias', 'prov')).toBe(
      123,
    )
  })

  test('the common band is the final fallback', () => {
    const providerConfig = provider({})
    expect(getMaxOutputBytesForModel(providerConfig, 'm1')).toBe(
      MAX_TRANSPORT_SAFE_PAYLOAD_BYTES,
    )
  })

  test('providerId resolves a provider-mapped alias key like resolveModelCapabilities', () => {
    const providerConfig = provider({
      modelMaxOutputBytes: { 'mapped-override': 789 },
      models: { 'm-alias': 'mapped-override' },
    })
    expect(getMaxOutputBytesForModel(providerConfig, 'm-alias', 'prov')).toBe(
      789,
    )
  })

  test('omitting providerId keeps the exact single-key lookup on model', () => {
    const providerConfig = provider({
      defaultMaxOutputBytes: 123,
      modelMaxOutputBytes: { 'mapped-override': 789 },
      models: { 'm-alias': 'mapped-override' },
    })
    expect(getMaxOutputBytesForModel(providerConfig, 'm-alias')).toBe(123)
  })

  test('a later candidate key wins, matching mergeModelCapabilities order', () => {
    const providerConfig = provider({
      modelMaxOutputBytes: { 'mapped-late': 222, 'm-raw': 111 },
      models: { 'm-raw': 'mapped-late' },
    })
    // Candidate order is [mapped, provider-qualified mapped, raw requested];
    // the raw requested id is the last candidate, so its override wins.
    expect(getMaxOutputBytesForModel(providerConfig, 'm-raw', 'prov')).toBe(111)
  })

  test('a provider-qualified request honors an override keyed by the unprefixed id', () => {
    const providerConfig = provider({
      defaultMaxOutputBytes: 123,
      modelMaxOutputBytes: { 'm-unprefixed': 456 },
      models: { 'm-unprefixed': 'm-unprefixed' },
    })
    // Requesting `prov/m-unprefixed` strips the provider prefix, so the
    // unprefixed candidate key resolves and its per-model override wins over
    // defaultCapabilities.
    expect(
      getMaxOutputBytesForModel(providerConfig, 'prov/m-unprefixed', 'prov'),
    ).toBe(456)
  })

  test('a provider-qualified request honors an override keyed by the qualified mapped id', () => {
    const providerConfig = provider({
      defaultMaxOutputBytes: 123,
      modelMaxOutputBytes: { 'prov/m-unprefixed': 456 },
      models: { 'm-unprefixed': 'm-unprefixed' },
    })
    // The provider-qualified mapped key is the second candidate, so an
    // override stored under `prov/<mapped>` is also honored for the same
    // provider-qualified request.
    expect(
      getMaxOutputBytesForModel(providerConfig, 'prov/m-unprefixed', 'prov'),
    ).toBe(456)
  })
})
