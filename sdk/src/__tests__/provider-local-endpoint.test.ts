/**
 * N07 local endpoints and N01 OpenRouter cache defaults, at the schema and
 * route-resolution level (no network).
 */
import { describe, expect, test } from 'bun:test'

import {
  OPENBUFF_PROVIDER_PRESETS,
  isLocalHttpUrl,
  providerConfigFileSchema,
  resolveConfiguredProviderModelMetadata,
} from '../provider-config'

const parse = (baseURL: string, type = 'openai-compatible') =>
  providerConfigFileSchema.safeParse({
    defaultModel: 'local/m',
    providers: { local: { type, baseURL, models: ['m'] } },
  })

describe('N07: local http endpoints', () => {
  test('an http://[::1]:11434/v1 provider resolves as local', () => {
    // WHATWG URL keeps the brackets: hostname is "[::1]", never "::1".
    expect(new URL('http://[::1]:11434/v1').hostname).toBe('[::1]')
    expect(isLocalHttpUrl('http://[::1]:11434/v1')).toBe(true)
    const parsed = parse('http://[::1]:11434/v1')
    expect(parsed.success).toBe(true)
    const route = resolveConfiguredProviderModelMetadata({
      model: 'local/m',
      loadedConfig: { sourceFilePaths: [], config: parsed.data! },
    })
    expect(route?.provider).toMatchObject({ baseURL: 'http://[::1]:11434/v1' })
  })

  test('host.docker.internal, localhost and 127.0.0.1 are local; anthropic-compatible too', () => {
    for (const url of ['http://host.docker.internal:11434/v1', 'http://localhost:8080/v1', 'http://127.0.0.1:1234/v1', 'http://LOCALHOST:1/v1']) {
      expect(isLocalHttpUrl(url)).toBe(true)
      expect(parse(url).success).toBe(true)
    }
    expect(parse('http://[::1]:8082', 'anthropic-compatible').success).toBe(true)
  })

  test('other http hosts stay rejected, and keys still require https', () => {
    for (const url of ['http://192.168.1.10:11434/v1', 'http://example.com/v1', 'http://[::ffff:127.0.0.1]/v1', 'http://localhost.evil.com/v1']) {
      expect(isLocalHttpUrl(url)).toBe(false)
      expect(parse(url).success).toBe(false)
    }
    expect(isLocalHttpUrl('https://localhost/v1')).toBe(false)
    const withKey = providerConfigFileSchema.safeParse({
      providers: { local: { type: 'openai-compatible', baseURL: 'http://[::1]:11434/v1', apiKeyEnv: 'LOCAL_KEY', models: ['m'] } },
    })
    expect(withKey.success).toBe(false)
  })
})

describe('N01: OpenRouter prompt-cache default', () => {
  const preset = {
    sourceFilePaths: [],
    config: providerConfigFileSchema.parse(OPENBUFF_PROVIDER_PRESETS.openrouter.config),
  }
  const strip = (model: string) =>
    resolveConfiguredProviderModelMetadata({ model, loadedConfig: preset })?.compatibility.stripCacheControl

  test('anthropic/* models on openrouter.ai send cache markers', () => {
    expect(strip('openrouter/anthropic/claude-sonnet-4.5')).toBe(false)
    expect(strip('openrouter/anthropic/claude-opus-4.1')).toBe(false)
  })

  test('other OpenRouter models and other hosts keep the strict default', () => {
    expect(strip('openrouter/openai/gpt-4.1-mini')).toBe(true)
    const proxy = providerConfigFileSchema.parse({
      providers: { proxy: { type: 'openai-compatible', baseURL: 'https://proxy.example.com/v1', models: ['anthropic/claude-sonnet-4.5'] } },
    })
    expect(
      resolveConfiguredProviderModelMetadata({
        model: 'proxy/anthropic/claude-sonnet-4.5',
        loadedConfig: { sourceFilePaths: [], config: proxy },
      })?.compatibility.stripCacheControl,
    ).toBe(true)
  })
})
