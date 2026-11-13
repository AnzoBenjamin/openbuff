import { afterEach, describe, expect, test } from 'bun:test'

import { get_encoding } from 'tiktoken'

import {
  clearExactTokenCountersForTest,
  countTokens,
  registerExactTokenCounter,
} from '../token-counter'
import {
  bundledExactTokenProviderRegistrationsForTest,
  registerBundledExactTokenProviders,
  resetBundledExactTokenProvidersForTest,
} from '../exact-token-providers'

import type { ExactTokenCounter } from '../token-counter'

describe('bundled exact token providers (P3-T10)', () => {
  // Save/restore the gate around every test so the per-call env read never
  // leaks state across cases (or into other suites in this process) — the
  // same hygiene as token-counter.test.ts.
  const ORIGINAL_EXACT_TOKENS_ENV = process.env.OPENBUFF_EXACT_TOKENS

  afterEach(() => {
    if (ORIGINAL_EXACT_TOKENS_ENV === undefined) {
      delete process.env.OPENBUFF_EXACT_TOKENS
    } else {
      process.env.OPENBUFF_EXACT_TOKENS = ORIGINAL_EXACT_TOKENS_ENV
    }
    clearExactTokenCountersForTest()
    resetBundledExactTokenProvidersForTest()
  })

  // Assembled from pieces on purpose: the full special-token literal is a
  // transport-level control token that gets stripped from source files, so
  // writing it inline would silently leave the special-token tests below
  // asserting nothing. The token must be a REAL special token in the bundled
  // encodings' special sets: empirically (probe, tiktoken 1.0.22) `<|im_end|`
  // is NOT one — both cl100k_base and o200k_base count it as ordinary text
  // even under the DEFAULT encode — while `<|endoftext|>` IS special in BOTH
  // encodings and tiktoken's DEFAULT encode (disallowed_special='all')
  // rejects it, which is the contrast the assertion below needs.
  const SPECIAL_TOKEN = '<' + '|endoftext|' + '>'

  test('registration is idempotent (call twice, one provider set)', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    expect(bundledExactTokenProviderRegistrationsForTest()).toBe(0)
    registerBundledExactTokenProviders()
    expect(bundledExactTokenProviderRegistrationsForTest()).toBe(1)
    registerBundledExactTokenProviders()
    // The second call is a no-op: still exactly one registered provider set,
    // and that one set routes both bundled encodings correctly.
    expect(bundledExactTokenProviderRegistrationsForTest()).toBe(1)
    expect(countTokens('hello world', 'openai/gpt-3.5-turbo')).toBe(2)
    expect(countTokens('hello world', 'openai/gpt-4o')).toBe(2)
  })

  test('routes gpt-3.5/gpt-4-turbo to cl100k, the rest to o200k', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    registerBundledExactTokenProviders()
    const cl100k = get_encoding('cl100k_base')
    const o200k = get_encoding('o200k_base')
    // Structurally diverse samples — prose, code, CJK, emoji, and a long
    // separator-free run — so the routing assertions exercise inputs where
    // the two encodings genuinely differ.
    const samples = [
      'The tool result contains the following diff for src/run.ts:',
      'function resolveTokenizerFamily(model: string): TokenizerFamily {',
      '你好，世界！这是一个分词器测试。',
      '🚀 emoji runs compress differently across encodings',
      'a'.repeat(64),
    ]
    // Precondition (non-vacuity): cl100k and o200k really do diverge across
    // this sample set, so matching the RIGHT encoding is meaningful. If this
    // ever fails, the samples no longer discriminate and must be replaced.
    const cl100kTotal = samples.reduce(
      (sum, sample) => sum + cl100k.encode(sample, [], []).length,
      0,
    )
    const o200kTotal = samples.reduce(
      (sum, sample) => sum + o200k.encode(sample, [], []).length,
      0,
    )
    expect(cl100kTotal).not.toBe(o200kTotal)
    for (const sample of samples) {
      expect(countTokens(sample, 'openai/gpt-3.5-turbo')).toBe(
        cl100k.encode(sample, [], []).length,
      )
      expect(countTokens(sample, 'openai/gpt-4-turbo')).toBe(
        cl100k.encode(sample, [], []).length,
      )
      expect(countTokens(sample, 'openai/gpt-4o')).toBe(
        o200k.encode(sample, [], []).length,
      )
    }
  })

  test("'hello world' is exactly 2 tokens under both encodings", () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    registerBundledExactTokenProviders()
    expect(countTokens('hello world', 'openai/gpt-3.5-turbo')).toBe(2)
    expect(countTokens('hello world', 'openai/gpt-4o')).toBe(2)
  })

  test('counts special-token text as ordinary tokens and never throws', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    registerBundledExactTokenProviders()
    const withSpecial = `a ${SPECIAL_TOKEN} b`
    // The provider must never throw on model-controlled special-token text,
    // and must price it as the ordinary characters it contains instead of
    // collapsing it to a single special token.
    expect(() => countTokens(withSpecial, 'openai/gpt-4o')).not.toThrow()
    const o200k = get_encoding('o200k_base')
    expect(countTokens(withSpecial, 'openai/gpt-4o')).toBe(
      o200k.encode(withSpecial, [], []).length,
    )
    expect(countTokens(withSpecial, 'openai/gpt-4o')).toBeGreaterThan(3)
    // The contrast that makes the (text, [], []) arguments load-bearing:
    // tiktoken's DEFAULT encode rejects the exact same input.
    expect(() => o200k.encode(withSpecial)).toThrow()
  })

  test('registration eagerly validates the bundled encodings', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    // Registration itself constructs BOTH encodings, so an unusable tiktoken
    // install would have thrown ABOVE (at the seam) rather than silently
    // degrading the first count. The externally visible contract: the very
    // first count after registration returns each encoding's exact count.
    registerBundledExactTokenProviders()
    expect(bundledExactTokenProviderRegistrationsForTest()).toBe(1)
    const text = 'lazy first count coverage text'
    const cl100k = get_encoding('cl100k_base')
    const o200k = get_encoding('o200k_base')
    expect(countTokens(text, 'openai/gpt-3.5-turbo')).toBe(
      cl100k.encode(text, [], []).length,
    )
    expect(countTokens(text, 'openai/gpt-4o')).toBe(
      o200k.encode(text, [], []).length,
    )
  })

  test('a failed eager validation registers nothing and stays retryable', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    // Pinned through the module's injectable getEncoding seam instead of
    // mock.module('tiktoken'): bun's module mocks are process-global and
    // would leak into token-counter.test.ts and every other suite that
    // imports tiktoken, while this seam only affects this one call.
    const sentinelCalls: string[] = []
    registerExactTokenCounter(
      (model: string) => model.toLowerCase().includes('gpt-4o'),
      {
        family: 'openai',
        count: (text: string) => {
          sentinelCalls.push(text)
          return text.length
        },
      },
    )
    let getEncodingCalls = 0
    expect(() =>
      registerBundledExactTokenProviders({
        getEncoding: () => {
          getEncodingCalls += 1
          throw new Error('Missing tiktoken_bg.wasm')
        },
      }),
    ).toThrow('Missing tiktoken_bg.wasm')
    // The failure surfaced at REGISTRATION time (the first eager encoding), and
    // the registration was atomic: no counter went live, the idempotence
    // counter stayed at 0, and the caller-registered sentinel still owns
    // gpt-4o (the bundled family matcher never registered).
    expect(getEncodingCalls).toBe(1)
    expect(bundledExactTokenProviderRegistrationsForTest()).toBe(0)
    const text = 'failed eager validation coverage text'
    expect(countTokens(text, 'openai/gpt-4o')).toBe(text.length)
    expect(sentinelCalls).toEqual([text])
    // Retryable: the guard was restored to false, so the next call really
    // registers — the sentinel keeps gpt-4o (first-match-wins) while the
    // bundled cl100k matcher now owns the gpt-3.5 lineage.
    registerBundledExactTokenProviders()
    expect(bundledExactTokenProviderRegistrationsForTest()).toBe(1)
    expect(countTokens(text, 'openai/gpt-4o')).toBe(text.length)
    expect(countTokens('hello world', 'openai/gpt-3.5-turbo')).toBe(2)
  })

  test('flag OFF keeps the estimator value even after registration', () => {
    delete process.env.OPENBUFF_EXACT_TOKENS
    const text = 'flag off estimator identity coverage text'
    // Baseline from a genuinely provider-free state: the gpt-tokenizer
    // estimate for this model.
    const estimatorOnly = countTokens(text, 'openai/gpt-4o')
    expect(estimatorOnly).toBeGreaterThan(0)
    // Registration is the state change under test: with the gate still
    // unset, the bundled provider set must be inert, so the re-measure of
    // the same input is identical. (No exact-vs-estimator divergence is
    // assumed here — under o200k-family BPE the escaped and literal forms of
    // special-token text can tokenize to the same length, so a divergence
    // precondition would be flaky rather than load-bearing.)
    registerBundledExactTokenProviders()
    expect(countTokens(text, 'openai/gpt-4o')).toBe(estimatorOnly)
    // Flipping the gate on for the SAME registration confirms the set was
    // genuinely live and routes to tiktoken's own o200k count (the gate-on
    // path is covered in depth by the tests above).
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    expect(countTokens(text, 'openai/gpt-4o')).toBe(
      get_encoding('o200k_base').encode(text, [], []).length,
    )
  })

  test('o200k exact count stays within ±10% of the estimator', () => {
    registerBundledExactTokenProviders()
    // Representative serialized prose+code sample.
    const sample = [
      'The tool result contains the following diff:',
      'function resolveTokenizerFamily(model: string): TokenizerFamily {',
      '  const normalized = model.toLowerCase()',
      "  if (normalized.includes('gpt-')) return 'openai'",
      '  return "unknown"',
      '}',
    ].join('\n')
    // Estimator: gate OFF, so the registered set is inert and the count is
    // the gpt-tokenizer gpt-4o BPE estimate (factor 1.0 for the openai
    // family).
    delete process.env.OPENBUFF_EXACT_TOKENS
    const estimatorCount = countTokens(sample, 'openai/gpt-4o')
    // Exact: gate ON, o200k via the family matcher.
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const exactCount = countTokens(sample, 'openai/gpt-4o')
    expect(estimatorCount).toBeGreaterThan(0)
    expect(exactCount).toBeGreaterThan(0)
    // Same BPE family, so the counts should be near-equal; the band catches
    // only genuine divergence (a wrong encoding or a stray fudge factor).
    const ratio = exactCount / estimatorCount
    expect(ratio).toBeGreaterThan(0.9)
    expect(ratio).toBeLessThan(1.1)
  })

  test('a caller-registered provider wins over the bundled set', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    // The seam dispatches first-registered-match-wins, so a provider
    // registered BEFORE the bundled set still owns the models it matches.
    const calls: string[] = []
    const sentinel: ExactTokenCounter = {
      family: 'openai',
      count: (text: string) => {
        calls.push(text)
        return text.length
      },
    }
    registerExactTokenCounter(
      (model: string) => model.toLowerCase().includes('gpt-4o'),
      sentinel,
    )
    registerBundledExactTokenProviders()
    const text = 'first match wins coverage text'
    expect(countTokens(text, 'openai/gpt-4o')).toBe(text.length)
    expect(calls).toEqual([text])
  })
})
