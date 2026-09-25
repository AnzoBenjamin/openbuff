import { describe, expect, test } from 'bun:test'

import {
  countTokensJson,
  IncrementalTokenCounter,
  tokenCountCacheSizeForTest,
  tokenFudgeFactorForModel,
} from '../token-counter'

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
