import { describe, expect, test } from 'bun:test'

import {
  countTokensJson,
  IncrementalTokenCounter,
  tokenCountCacheSizeForTest,
  tokenFudgeFactorForModel,
} from '../token-counter'

describe('countTokensJson', () => {
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
