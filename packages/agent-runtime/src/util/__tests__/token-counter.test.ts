import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearExactTokenCountersForTest,
  countTokens,
  countTokensJson,
  exactFamilyMatcher,
  getTokenizerForModel,
  IncrementalTokenCounter,
  registerExactTokenCounter,
  tokenCountCacheSizeForTest,
  tokenFudgeFactorForModel,
  tokenizerFamilyCacheSizeForTest,
} from '../token-counter'

import type { ExactTokenCounter } from '../token-counter'

describe('countTokensJson', () => {
  test('counts model-controlled special-token text as ordinary text (SEC-TC-SPECIAL-1)', () => {
    // Under allowedSpecial:'all' the literal '<|endoftext|>' collapses to ONE
    // special token; the estimator escapes '<|' before encoding so the text
    // is priced like the ordinary characters it contains (and the default
    // encode path, which throws on special tokens, is never reachable). The
    // unescaped-then-escaped difference for this input is several tokens.
    const withSpecial = 'a <|endoftext|> b'
    expect(countTokensJson(withSpecial)).toBeGreaterThan(3)
  })

  test('does not count base64 media payloads as text tokens', () => {
    const withMediaPayload = [
      {
        role: 'tool',
        toolName: 'read_image',
        toolCallId: 'tool-1',
        content: [
          {
            type: 'media',
            mediaType: 'image/png',
            data: 'a'.repeat(3_000_000),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: 'b'.repeat(3_000_000),
          },
          {
            type: 'image',
            mediaType: 'image/jpeg',
            image: 'c'.repeat(3_000_000),
          },
        ],
      },
    ]

    expect(countTokensJson(withMediaPayload)).toBeLessThan(1_000)
  })

  test('degrades to an estimate instead of throwing on malformed objects (SEC-TC-CIRC-1)', () => {
    // Circular reference: plain JSON.stringify throws; the salvage
    // serializer must yield a count instead of aborting the caller.
    const circular: Record<string, unknown> = { role: 'user', content: 'x' }
    circular.self = circular
    expect(() => countTokensJson(circular)).not.toThrow()
    expect(countTokensJson(circular)).toBeGreaterThan(0)
    // BigInt value: the other JSON.stringify throw class the finding names.
    const withBigInt = { role: 'user', content: 'y', count: 9007199254740993n }
    expect(() => countTokensJson(withBigInt)).not.toThrow()
    expect(countTokensJson(withBigInt)).toBeGreaterThan(0)
  })
})

describe('token-count LRU bound (M3-T2)', () => {
  test('oversized transcript-sized input is never cached (cache stays empty)', () => {
    // A serialized-history-shaped string far above the 8 KB cacheability
    // bound: counting it repeatedly must never grow the LRU (the audit's
    // unbounded-entry-size finding).
    const oversized = 'x'.repeat(64_000)
    const before = tokenCountCacheSizeForTest()
    const first = countTokensJson(oversized)
    const second = countTokensJson(oversized)
    expect(second).toBe(first)
    expect(tokenCountCacheSizeForTest()).toBe(before)
  })

  test('moderately sized repeatable inputs are still cached for cost', () => {
    // Under the bound, the same string Hit the cache on a repeat call; the
    // size grows by exactly one entry and stays there on further repeats.
    const small = 'y'.repeat(5_000)
    const before = tokenCountCacheSizeForTest()
    countTokensJson(small)
    countTokensJson(small)
    countTokensJson(small)
    expect(tokenCountCacheSizeForTest()).toBe(before + 1)
  })

  test('a cached entry is model-independent (SEC-TC-CACHE-KEY-1)', () => {
    // The cache stores the RAW BPE count and the per-model fudge factor is
    // applied after the lookup, so counting the same text under two models
    // yields each model's own factored count, never the first model's.
    const small = 'z'.repeat(5_000)
    const anthropicFirst = countTokensJson(small, 'anthropic/claude')
    const openaiSecond = countTokensJson(small, 'openai/gpt-4o')
    expect(openaiSecond).toBeLessThan(anthropicFirst)
    // Repeats stay consistent per model.
    expect(countTokensJson(small, 'anthropic/claude')).toBe(anthropicFirst)
    expect(countTokensJson(small, 'openai/gpt-4o')).toBe(openaiSecond)
  })
})

describe('per-model-family fudge factor (M3-T2)', () => {
  test('selects the documented factor per model family', () => {
    expect(tokenFudgeFactorForModel('anthropic/claude-opus-4.7')).toBe(1.35)
    expect(tokenFudgeFactorForModel('openai/gpt-4o')).toBe(1.0)
    expect(tokenFudgeFactorForModel('google/gemini-2.5-pro')).toBe(1.1)
    expect(tokenFudgeFactorForModel('some-unknown-model')).toBe(1.0)
    expect(tokenFudgeFactorForModel(undefined)).toBe(1.0)
  })

  test('unannotated calls keep the legacy Anthropic 1.35 behavior', () => {
    // The no-model signature is what all existing callers use; pin that it
    // still applies the Anthropic factor (1.35), not the unknown-model 1.0.
    expect(tokenFudgeFactorForModel('anthropic/claude')).toBe(1.35)
  })
})

describe('IncrementalTokenCounter (M3-T2)', () => {
  test('memoizes per-message counts and prices rewrites once', () => {
    const counter = new IncrementalTokenCounter()
    const a = { role: 'user', content: 'hello world' }
    const b = { role: 'assistant', content: 'hi there' }
    const total = counter.messagesTokens([a, b])
    expect(total).toBe(
      counter.messageTokens(a) + counter.messageTokens(b),
    )
    // Repeat call: same total, no additional bencoding of a/b.
    expect(counter.messagesTokens([a, b])).toBe(total)
    // A rewritten message (new reference) is counted once from scratch.
    const b2 = { ...b }
    expect(counter.messagesTokens([a, b2])).toBe(total)
  })

  test('setSystemAndToolsTokens is additive inside messagesTokens callers', () => {
    const counter = new IncrementalTokenCounter()
    counter.setSystemAndToolsTokens(42)
    const a = { role: 'user', content: 'abc' }
    // Only messagesTokens returns a number; system/tools tokens are the
    // caller's additive term (mirrors the run-agent-step pattern).
    expect(counter.messagesTokens([a])).toBe(counter.messageTokens(a))
  })

  test('reset drops memoized counts for a full recount', () => {
    const counter = new IncrementalTokenCounter()
    const a = { role: 'user', content: 'reset me' }
    counter.messagesTokens([a])
    counter.reset()
    // After reset, the count is recomputed (identical value, fresh memo).
    expect(counter.messagesTokens([a])).toBe(counter.messageTokens(a))
  })
})

describe('exact token counter seam (P3-T10)', () => {
  // Save/restore the gate around every test so the per-call env read never
  // leaks state across cases (or into other suites in this process).
  const ORIGINAL_EXACT_TOKENS_ENV = process.env.OPENBUFF_EXACT_TOKENS

  afterEach(() => {
    if (ORIGINAL_EXACT_TOKENS_ENV === undefined) {
      delete process.env.OPENBUFF_EXACT_TOKENS
    } else {
      process.env.OPENBUFF_EXACT_TOKENS = ORIGINAL_EXACT_TOKENS_ENV
    }
    clearExactTokenCountersForTest()
  })

  /** Deterministic fake provider: 1 token per char, records every input. */
  const lengthCounter = (
    family: string,
    calls: string[],
  ): ExactTokenCounter => ({
    family,
    count: (text: string) => {
      calls.push(text)
      return text.length
    },
  })

  test('flag OFF keeps the estimator even when a provider matches', () => {
    delete process.env.OPENBUFF_EXACT_TOKENS
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    const text = 'exact seam flag-off coverage text'
    const counted = countTokens(text, 'anthropic/claude-opus-4.7')
    // The provider was never consulted and the result is the legacy fudged
    // estimate (identical to the unannotated Anthropic-default call).
    expect(calls).toHaveLength(0)
    expect(counted).not.toBe(text.length)
    expect(counted).toBe(countTokens(text))
  })

  test('flag ON + matching provider returns the exact count, no fudge', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    const text = 'exact seam flag-on coverage text'
    // The estimator would have applied the Anthropic 1.35 factor to the BPE
    // count; the exact path returns the provider count verbatim instead.
    expect(countTokens(text, 'anthropic/claude-opus-4.7')).toBe(text.length)
    expect(calls).toEqual([text])
  })

  test('flag ON bypasses the 100k BPE cap (full exact count, no fudge)', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('openai'),
      lengthCounter('openai', calls),
    )
    // Above MAX_BPE_ENCODE_CHARS: the estimator would encode a 20k prefix
    // sample and extrapolate; the exact path counts the whole input once.
    const text = 'w'.repeat(200_000)
    expect(countTokens(text, 'openai/gpt-4o')).toBe(200_000)
    expect(calls).toEqual([text])
  })

  test('flag ON with no matching provider falls back to the estimator', () => {
    const model = 'openai/gpt-4o'
    const text = 'provider-miss fallback coverage text'
    delete process.env.OPENBUFF_EXACT_TOKENS
    const expected = countTokens(text, model)
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    // No registrations at all -> estimator.
    expect(countTokens(text, model)).toBe(expected)
    // A registered provider whose matcher rejects the model -> estimator.
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    expect(countTokens(text, model)).toBe(expected)
    expect(calls).toHaveLength(0)
  })

  test('exact path still bounds pathological oversized input', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    // 2M chars > MAX_EXACT_ENCODE_CHARS: the provider must receive only a
    // bounded prefix, with the total extrapolated by length ratio — never an
    // unbounded exact encode.
    const text = 'x'.repeat(2_000_000)
    const counted = countTokens(text, 'anthropic/claude-opus-4.7')
    expect(calls).toHaveLength(1)
    expect(calls[0].length).toBeLessThan(text.length)
    // Density-1 fake: sampleTokens/sampleLength == 1, so the extrapolated
    // total is exactly the input length.
    expect(counted).toBe(text.length)
  })

  test('provider cache honors MAX_CACHEABLE_INPUT_CHARS', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const model = 'anthropic/claude-opus-4.7'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    // Cacheable band (>100 chars, <=8k): counted once, then cache-served.
    const small = 'y'.repeat(5_000)
    expect(countTokens(small, model)).toBe(5_000)
    expect(countTokens(small, model)).toBe(5_000)
    expect(calls).toHaveLength(1)
    // Above the 8k cacheability bound: re-counted every call, never cached.
    const large = 'z'.repeat(64_000)
    expect(countTokens(large, model)).toBe(64_000)
    expect(countTokens(large, model)).toBe(64_000)
    expect(calls).toHaveLength(3)
    // <=100 chars: also never cached (the BPE LRU's same lower edge).
    const tiny = 'q'.repeat(50)
    countTokens(tiny, model)
    countTokens(tiny, model)
    expect(calls).toHaveLength(5)
  })

  test('register/clear lifecycle: clearing restores the estimator', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const model = 'anthropic/claude-opus-4.7'
    const text = 'register-clear lifecycle coverage text'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    expect(countTokens(text, model)).toBe(text.length)
    expect(calls).toHaveLength(1)
    clearExactTokenCountersForTest()
    delete process.env.OPENBUFF_EXACT_TOKENS
    const expected = countTokens(text, model)
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    expect(countTokens(text, model)).toBe(expected)
    expect(calls).toHaveLength(1)
  })

  test('unannotated no-model callers keep the estimator even with the gate on', () => {
    const text = 'unannotated caller gate coverage text'
    delete process.env.OPENBUFF_EXACT_TOKENS
    const expected = countTokens(text)
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    // The legacy Anthropic sentinel must NOT route to the provider.
    expect(countTokens(text)).toBe(expected)
    expect(countTokensJson(text)).toBe(expected)
    expect(calls).toHaveLength(0)
  })

  test('env gate follows the shared truthy-set pattern', () => {
    const model = 'anthropic/claude-opus-4.7'
    const text = 'truthy-set gate coverage text'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    for (const offValue of ['0', 'false', 'no', 'off', '']) {
      process.env.OPENBUFF_EXACT_TOKENS = offValue
      countTokens(text, model)
    }
    expect(calls).toHaveLength(0)
    for (const onValue of ['1', 'true', 'YES', 'On']) {
      process.env.OPENBUFF_EXACT_TOKENS = onValue
      expect(countTokens(text, model)).toBe(text.length)
    }
    expect(calls.length).toBeGreaterThan(0)
  })

  test('getTokenizerForModel resolves families and stays bounded', () => {
    expect(getTokenizerForModel('anthropic/claude-opus-4.7')).toBe('anthropic')
    expect(getTokenizerForModel('openai/gpt-4o')).toBe('openai')
    expect(getTokenizerForModel('google/gemini-2.5-pro')).toBe('gemini')
    expect(getTokenizerForModel('some-unknown-model')).toBe('unknown')
    expect(getTokenizerForModel(undefined)).toBe('unknown')
    // Bounded: cycling far past the 1000-entry capacity cannot grow the map.
    for (let i = 0; i < 1_500; i++) {
      getTokenizerForModel(`cycle-model-${i}`)
    }
    expect(tokenizerFamilyCacheSizeForTest()).toBeLessThanOrEqual(1_000)
    expect(getTokenizerForModel('anthropic/claude-opus-4.7')).toBe('anthropic')
  })
})
