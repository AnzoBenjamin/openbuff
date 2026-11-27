import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  TOKEN_CALIBRATION_BAND_MAX,
  TOKEN_CALIBRATION_BAND_MIN,
  TOKEN_CALIBRATION_MIN_OBSERVATIONS,
  TOKEN_CALIBRATION_WINDOW,
  calibrationFamilyForModel,
  recordTokenObservation,
  resetTokenCalibrationForTest,
  setTokenCalibrationStorePath,
  tokenCalibrationStatus,
} from '../token-calibration'
import {
  clearExactTokenCountersForTest,
  clearTokenCountCacheForTest,
  countTokens,
  countTokensJson,
  exactFamilyMatcher,
  exactTokenCounterRegistrySizeForTest,
  getTokenizerForModel,
  IncrementalTokenCounter,
  longTokenCountCacheSizeForTest,
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
  test('long input uses a bounded digest cache without retaining text in the ordinary cache', () => {
    // A serialized-history-shaped string far above the 8 KB cacheability
    // bound: counting it repeatedly must never grow the LRU (the audit's
    // unbounded-entry-size finding).
    const oversized = 'x'.repeat(12_000)
    const before = tokenCountCacheSizeForTest()
    const longBefore = longTokenCountCacheSizeForTest()
    const first = countTokensJson(oversized)
    const second = countTokensJson(oversized)
    expect(second).toBe(first)
    expect(tokenCountCacheSizeForTest()).toBe(before)
    expect(longTokenCountCacheSizeForTest()).toBe(longBefore + 1)
    expect(countTokensJson(oversized, 'openai/gpt-4o')).toBeLessThan(first)
  })

  test('moderately sized repeatable inputs are still cached for cost', () => {
    // Under the bound (< MAX_CACHEABLE_INPUT_CHARS, 8 KB), so the string is
    // ordinary-LRU cacheable and a repeat call is a free hit. Clear the
    // module-global LRU first: it is 1000-entry capped, and once earlier
    // suites in this process fill it an insert EVICTS instead of growing
    // (the intended bound), which would make this string's cacheability
    // unobservable as a size delta.
    clearTokenCountCacheForTest()
    const small = 'y'.repeat(5_000)
    const before = tokenCountCacheSizeForTest()
    countTokensJson(small)
    countTokensJson(small)
    countTokensJson(small)
    expect(tokenCountCacheSizeForTest()).toBe(before + 1)
    // Repeatable inputs stay resident (the cost win) rather than being
    // re-encoded: the single entry is reused, not re-added.
    expect(tokenCountCacheSizeForTest()).toBe(1)
  })

  test('the count LRU stays bounded under distinct-input churn (resource safety)', () => {
    // Bounded-resource pass over the collections that feed compaction and
    // eviction decisions: cycling more distinct cacheable inputs than the LRU
    // capacity must EVICT, never grow the map. Capacity is 1000 entries.
    clearTokenCountCacheForTest()
    for (let i = 0; i < 1_050; i++) {
      countTokensJson(`${'q'.repeat(200)} churn ${i}`, 'openai/gpt-4o')
    }
    expect(tokenCountCacheSizeForTest()).toBeLessThanOrEqual(1_000)
    expect(tokenCountCacheSizeForTest()).toBeGreaterThan(0)
    // The digest-keyed long-input cache obeys the same bound.
    expect(longTokenCountCacheSizeForTest()).toBeLessThanOrEqual(1_000)
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
    expect(total).toBe(counter.messageTokens(a) + counter.messageTokens(b))
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

  test('totalTokens returns the message sum plus the system+tools baseline', () => {
    const counter = new IncrementalTokenCounter()
    counter.setSystemAndToolsTokens(42)
    const a = { role: 'user', content: 'abc' }
    // The split stays: messagesTokens prices messages only (the pinned
    // run-agent-step contract); totalTokens is the combined estimate.
    expect(counter.messagesTokens([a])).toBe(counter.messageTokens(a))
    expect(counter.totalTokens([a])).toBe(counter.messagesTokens([a]) + 42)
  })

  test('per-message memo is bounded under message-reference churn (SEC-TC-MEMO-BOUND-1)', () => {
    const counter = new IncrementalTokenCounter('openai/gpt-4o')
    // A long streaming turn rewrites the in-flight message per token, so every
    // rewrite is a FRESH object reference: an uncapped WeakMap would retain
    // one full count per intermediate rewrite until GC.
    for (let i = 0; i < 1_500; i++) {
      counter.messageTokens({
        role: 'assistant',
        content: `streamed chunk ${i}`,
      })
    }
    expect(counter.memoSizeForTest()).toBeLessThanOrEqual(1_000)
    expect(counter.memoSizeForTest()).toBeGreaterThan(0)
    // reset() still clears the accounting so the bound restarts from zero.
    counter.reset()
    expect(counter.memoSizeForTest()).toBe(0)
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

  test('exact provider receives escaped special-token text, never the raw sequence (SEC-TC-EXACT-INPUT-1)', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const model = 'anthropic/claude-opus-4.7'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    // Model-controlled tool-result text carrying a tokenizer special token.
    const text = 'tool result with <|endoftext|> inside'
    // The provider counts the ESCAPED text (one inserted space per '<|'),
    // exactly like the local BPE estimator — never the raw '<|...|>' bytes.
    expect(countTokens(text, model)).toBe(text.length + 1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(text.replace(/<\|/g, '< |'))
    expect(calls[0]).not.toContain('<|')
  })

  test('the oversized exact sample is escaped and size-bounded too (SEC-TC-EXACT-INPUT-1)', () => {
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const model = 'anthropic/claude-opus-4.7'
    const calls: string[] = []
    registerExactTokenCounter(
      exactFamilyMatcher('anthropic'),
      lengthCounter('anthropic', calls),
    )
    const huge = '<|im_start|>' + 'x'.repeat(1_000_000)
    const counted = countTokens(huge, model)
    expect(calls).toHaveLength(1)
    // Only the bounded prefix sample reaches the provider, and it is escaped.
    expect(calls[0].length).toBeLessThan(huge.length)
    expect(calls[0]).not.toContain('<|')
    // Density-1 fake provider: the extrapolation lands on the input length.
    expect(Math.abs(counted - huge.length)).toBeLessThan(20)
  })

  test('a failing provider logs once per model, not per call (SEC-TC-EXACT-INPUT-1)', () => {
    const model = 'anthropic/claude-opus-4.7'
    const otherModel = 'openai/gpt-4o'
    // Distinct inputs so the per-provider result cache can never serve a hit:
    // a per-call diagnostic would emit one line per count on this hot path.
    const inputs = [0, 1, 2, 3, 4].map(
      (i) => `${'failing provider coverage text '.repeat(5)}${i}`,
    )
    delete process.env.OPENBUFF_EXACT_TOKENS
    const expected = inputs.map((text) => countTokens(text, model))

    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '))
    }
    const failing: ExactTokenCounter = {
      family: 'anthropic',
      count: () => {
        throw new SyntaxError('bad <|endoftext|> in <model-authored text>')
      },
    }
    try {
      registerExactTokenCounter(exactFamilyMatcher('anthropic'), failing)
      registerExactTokenCounter(exactFamilyMatcher('openai'), failing)
      // Degrades to the estimator instead of throwing / aborting the step.
      expect(inputs.map((text) => countTokens(text, model))).toEqual(expected)
      // One diagnostic for five failures on the same model.
      expect(errors).toHaveLength(1)
      // Type-only diagnostic: the provider's message naming model content is
      // never echoed (SEC-TC-LOG-ECHO-1).
      expect(errors[0]).toContain('TC_EXACT_ENCODE_FAIL')
      expect(errors[0]).not.toContain('<|endoftext|>')
      // A DIFFERENT model gets its own single diagnostic.
      countTokens(
        'another failing provider input for the openai family',
        otherModel,
      )
      countTokens(
        'yet another failing provider input for openai family',
        otherModel,
      )
      expect(errors).toHaveLength(2)
    } finally {
      console.error = originalError
    }
  })

  test('a non-finite provider count degrades to the estimator (SEC-TC-EXACT-FINITE-1)', () => {
    const model = 'anthropic/claude-opus-4.7'
    // Distinct inputs so the per-provider cache can never serve a hit.
    const inputs = [0, 1, 2].map(
      (i) => `non-finite provider count coverage text ${i}`,
    )
    delete process.env.OPENBUFF_EXACT_TOKENS
    const expected = inputs.map((text) => countTokens(text, model))

    process.env.OPENBUFF_EXACT_TOKENS = '1'
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '))
    }
    const badCounts = [Number.NaN, Number.POSITIVE_INFINITY, -5]
    try {
      for (const badCount of badCounts) {
        registerExactTokenCounter(
          exactFamilyMatcher('anthropic'),
          { family: 'anthropic', count: () => badCount },
        )
      }
      // Every registration matches the same model, so the FIRST one answers:
      // a NaN count must never reach the compaction comparisons (NaN > limit
      // is always false, which would silently disable pruning for the step).
      const counted = countTokens(inputs[0]!, model)
      expect(Number.isFinite(counted)).toBe(true)
      expect(counted).toBeGreaterThan(0)
      // One type-only diagnostic for the model (TC_EXACT_NONFINITE path).
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('TC_EXACT_ENCODE_FAIL')
    } finally {
      console.error = originalError
    }

    // Clearing restores the estimator, so each bad provider class is exercised
    // through the same public path (the count must equal the gate-off
    // estimator's, never the provider's NaN/Infinity/negative value).
    delete process.env.OPENBUFF_EXACT_TOKENS
    const retryTexts = [0, 1, 2].map(
      (i) => `non-finite provider count retry text ${i} ${'x'.repeat(200)}`,
    )
    const estimatorCounts = retryTexts.map((text) => countTokens(text, model))
    process.env.OPENBUFF_EXACT_TOKENS = '1'
    badCounts.forEach((badCount, index) => {
      clearExactTokenCountersForTest()
      registerExactTokenCounter(exactFamilyMatcher('anthropic'), {
        family: 'anthropic',
        count: () => badCount,
      })
      const counted = countTokens(retryTexts[index]!, model)
      expect(Number.isFinite(counted)).toBe(true)
      expect(counted).toBeGreaterThan(0)
      expect(counted).toBe(estimatorCounts[index]!)
    })
    // The estimator path is exactly what the gate-off call would have priced.
    clearExactTokenCountersForTest()
    delete process.env.OPENBUFF_EXACT_TOKENS
    expect(inputs.map((text) => countTokens(text, model))).toEqual(expected)
  })

  test('the exact-provider registry is bounded (SEC-TC-EXACT-REGISTRY-1)', () => {
    for (let i = 0; i < 40; i++) {
      registerExactTokenCounter(
        exactFamilyMatcher('anthropic'),
        lengthCounter('anthropic', []),
      )
    }
    // Registrations are process-global, so the registry obeys the same bounded
    // discipline as every other collection in this module.
    expect(exactTokenCounterRegistrySizeForTest()).toBeLessThanOrEqual(16)
    expect(exactTokenCounterRegistrySizeForTest()).toBeGreaterThan(0)
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

describe('calibration store input boundaries (SEC-TC-CALIBRATION-KEY-1 / SEC-TC-CYCLE-1)', () => {
  /**
   * The calibration store is fed by a project file AND by model strings, so
   * both are untrusted keys into `families`. These cases pin that a
   * `__proto__`-shaped key can neither mutate Object.prototype nor throw
   * through the countTokens path.
   */
  let dir: string | undefined

  afterEach(() => {
    setTokenCalibrationStorePath(undefined)
    resetTokenCalibrationForTest()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  const attachStore = (contents: string): string => {
    dir = mkdtempSync(path.join(tmpdir(), 'token-counter-calib-'))
    const storePath = path.join(dir, 'token-calibration.json')
    writeFileSync(storePath, contents, 'utf8')
    setTokenCalibrationStorePath(storePath)
    return storePath
  }

  test("a crafted '__proto__' family never mutates Object.prototype or throws through countTokens", () => {
    // A crafted store file: JSON.parse defines '__proto__' as an OWN property,
    // so a plain-object store would hand it to the prototype setter on the next
    // spread/computed-key write and re-persist it (SEC-TC-CALIBRATION-KEY-1).
    const storePath = attachStore(
      '{"schemaVersion":1,"families":{' +
        '"__proto__":{"polluted":true},' +
        '"constructor":[{"estimated":100,"actual":200}],' +
        '"prototype":[{"estimated":100,"actual":200}],' +
        '"openai":[{"estimated":100,"actual":200}]}}',
    )
    const prototypeMembersBefore = Object.getOwnPropertyNames(
      Object.prototype,
    ).sort()
    const probe: Record<string, unknown> = {}

    expect(() => {
      // Attacker-shaped MODEL ids: these reach the family key through
      // getTokenizerForModel. They can only ever resolve to the four constant
      // family names, so the observation lands under 'unknown' — never under
      // the raw model string.
      countTokens('calibration input boundary probe', '__proto__')
      countTokensJson({ role: 'user', content: 'probe' }, 'constructor')
      recordTokenObservation('__proto__', 100, 200)
      recordTokenObservation('constructor', 100, 200)
      recordTokenObservation('prototype', 100, 200)
    }).not.toThrow()

    // No process-wide pollution: no new Object.prototype member, and a fresh
    // object's prototype is untouched.
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(
      prototypeMembersBefore,
    )
    expect(probe.polluted).toBeUndefined()
    expect(Object.getPrototypeOf(probe)).toBe(Object.prototype)

    // The crafted file contributes NOTHING to the loaded store. Its proto-ish
    // keys fail the family allow-list, and its `openai` window is dropped too:
    // the single pair 200/100 is outside openai's credibility band
    // (SEC-TC-CALIBRATION-BAND-1), so sanitizeStore discards it rather than
    // keeping a partially-trusted window. The first legitimate observation
    // therefore starts from an EMPTY store and re-persists only itself.
    recordTokenObservation('openai/gpt-4o', 100, 100)
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
      families: Record<string, unknown>
    }
    expect(Object.keys(persisted.families).sort()).toEqual(['openai'])
    expect(
      Object.prototype.hasOwnProperty.call(persisted.families, '__proto__'),
    ).toBe(false)
    // Exactly this write's own observation — no crafted entry round-trips.
    expect(
      (persisted.families.openai as Array<unknown> | undefined)?.length,
    ).toBe(1)
    expect(Object.keys(tokenCalibrationStatus()).sort()).toEqual(['openai'])
  })

  test("a '__proto__' model id is stored under the 'unknown' family", () => {
    // Model strings only ever map onto the four constant family names, so a
    // caller-supplied '__proto__' cannot become a store key at all. The store
    // is attached with a VALID empty payload: an empty file is unparsable, so
    // persistStore would fail-open and leave nothing on disk to assert.
    const storePath = attachStore('{"schemaVersion":1,"families":{}}')

    expect(calibrationFamilyForModel('__proto__')).toBe('unknown')
    // Ratio 1.1 sits inside 'unknown''s correction band (static 1.0 x [0.8,
    // 1.25]), so this pair is CREDIBLE and actually reaches the write path —
    // which is what this case pins (SEC-TC-CALIBRATION-BAND-1 rejects
    // non-credible pairs before they are ever stored).
    recordTokenObservation('__proto__', 100, 110)

    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
      families: Record<string, unknown>
    }
    expect(Object.keys(persisted.families)).toEqual(['unknown'])
    expect(
      Object.prototype.hasOwnProperty.call(persisted.families, '__proto__'),
    ).toBe(false)
    expect(tokenCalibrationStatus()['unknown']!.observations).toBe(1)
  })

  test("an ARRAY-valued crafted '__proto__' family cannot reach the persisted store (SEC-TC-CALIBRATION-ALLOWLIST-1)", () => {
    // The earlier '__proto__' case used a NON-array value, which sanitizeStore
    // dropped before the write — so the serializer's key walk was never
    // exercised with a surviving crafted key. Here the crafted value IS an
    // array, the shape a key-only blocklist lets through to Object.entries and
    // persistStore, plus 8 legitimate 'openai' observations so the store also
    // carries a converged factor that must not be disturbed.
    //
    // The crafted JSON is authored as TEXT on purpose: an object literal
    // `__proto__: [...]` would set/prototype-link instead of creating the OWN
    // data property JSON.parse creates.
    const openaiWindow = Array.from(
      { length: TOKEN_CALIBRATION_MIN_OBSERVATIONS },
      () => ({ estimated: 100, actual: 100 }),
    )
    const storePath = attachStore(
      '{"schemaVersion":1,"families":{' +
        '"__proto__":[{"estimated":1,"actual":1000000}],' +
        `"openai":${JSON.stringify(openaiWindow)}}}`,
    )
    const protoBefore = Object.getOwnPropertyDescriptor(
      Object.prototype,
      '__proto__',
    )

    // The load + re-persist path: one legitimate observation forces the store
    // write the finding's chain needs.
    recordTokenObservation('openai/gpt-4o', 100, 100)

    // (a) Object.prototype.__proto__ stays the inherited ACCESSOR — no own
    // data property introduced, no descriptor swap — and a fresh object's
    // prototype is still the untouched Object.prototype.
    const protoAfter = Object.getOwnPropertyDescriptor(
      Object.prototype,
      '__proto__',
    )
    expect(protoAfter?.get).toBe(protoBefore?.get)
    expect(protoAfter?.set).toBe(protoBefore?.set)
    expect(protoAfter?.value).toBe(protoBefore?.value)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(
      Object.prototype.hasOwnProperty.call({}, '__proto__'),
    ).toBe(false)

    // (b) The re-persisted file carries ONLY the allow-listed family: the
    // write really happened (9 openai observations) and no JSON-authored key
    // round-trips back into the store.
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
      families: Record<string, unknown>
    }
    expect(Object.getOwnPropertyNames(persisted.families)).toEqual(['openai'])
    expect(
      Object.prototype.hasOwnProperty.call(persisted.families, '__proto__'),
    ).toBe(false)
    expect(readFileSync(storePath, 'utf8')).not.toContain('__proto__')
    // Persist now MERGES the on-disk window with our own observation
    // (sec-tc-calibration-non-atomic-persist), so the count is the crafted
    // file's credible entries plus this write's — never the crafted proto-ish
    // key, and never anything above the bounded window.
    const persistedOpenai = persisted.families.openai as Array<unknown>
    expect(persistedOpenai.length).toBeLessThanOrEqual(
      TOKEN_CALIBRATION_WINDOW,
    )
    expect(persistedOpenai.length).toBe(TOKEN_CALIBRATION_MIN_OBSERVATIONS + 1)

    // (c) The crafted 1e6 ratio (which would clamp to the 3.0 ceiling) never
    // reaches the openai family's factor, and the status summary exposes no
    // crafted family key either.
    expect(tokenFudgeFactorForModel('openai/gpt-4o')).toBe(1)
    expect(Object.keys(tokenCalibrationStatus())).toEqual(['openai'])
  })

  test('eight steered observations cannot move the family factor beyond the correction band (SEC-TC-CALIBRATION-BAND-1)', () => {
    // The finding's repro: a model-authored tool result carrying a tokenizer
    // special-token sequence inflates the PROVIDER's inputTokens while the
    // local estimator escapes '<|', so one step records ~30x. Eight such steps
    // in a single turn (no operator confirmation) used to converge the openai
    // family factor to TOKEN_CALIBRATION_MAX_FACTOR (3.0) and persist it —
    // pruning/eviction would then trim at ~1/3 of the real budget for every
    // agent on the family, across runs.
    const model = 'openai/gpt-4o'
    const staticFactor = tokenFudgeFactorForModel(model)
    expect(staticFactor).toBe(1)
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(model, 100, 3000)
    }
    // Non-credible pairs never recorded, so the static factor still stands.
    expect(tokenCalibrationStatus()['openai']).toBeUndefined()
    expect(tokenFudgeFactorForModel(model)).toBe(staticFactor)
    // Even a run of *credible* inflated observations stays inside the band: a
    // converged factor is a correction, never a replacement.
    for (let i = 0; i < TOKEN_CALIBRATION_MIN_OBSERVATIONS; i++) {
      recordTokenObservation(model, 100, 125)
    }
    const converged = tokenFudgeFactorForModel(model)
    expect(converged).toBeGreaterThanOrEqual(
      staticFactor * TOKEN_CALIBRATION_BAND_MIN,
    )
    expect(converged).toBeLessThanOrEqual(staticFactor * TOKEN_CALIBRATION_BAND_MAX)
    expect(converged).toBeLessThan(1.5)
  })

  test('a store whose observations exceed the correction band is untrusted on load (SEC-TC-CALIBRATION-BAND-1)', () => {
    // The persisted side of the attack: a store written by an earlier
    // free-running version (or steered into place) holds 8 observations at
    // ratio 30, which used to converge the openai factor to 3.0 on every
    // subsequent run reading that project file.
    const inflated = Array.from(
      { length: TOKEN_CALIBRATION_MIN_OBSERVATIONS },
      () => ({ estimated: 100, actual: 3000 }),
    )
    const storePath = attachStore(
      `{"schemaVersion":1,"families":{"openai":${JSON.stringify(inflated)}}}`,
    )
    expect(tokenFudgeFactorForModel('openai/gpt-4o')).toBe(1)
    // Dropped on load, so a write does not round-trip them back to the file.
    recordTokenObservation('openai/gpt-4o', 100, 100)
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
      families: Record<string, Array<{ estimated: number; actual: number }>>
    }
    expect(persisted.families.openai).toEqual([{ estimated: 100, actual: 100 }])
    expect(tokenFudgeFactorForModel('openai/gpt-4o')).toBe(1)
  })

  test('a credible store window still converges inside the band on load', () => {
    // A 'anthropic' store from an earlier run must survive when its ratios are
    // explainable by the family gap: the band is a bound, not a reset.
    const window = Array.from(
      { length: TOKEN_CALIBRATION_MIN_OBSERVATIONS },
      () => ({ estimated: 100, actual: 150 }),
    )
    attachStore(
      `{"schemaVersion":1,"families":{"anthropic":${JSON.stringify(window)}}}`,
    )
    expect(tokenFudgeFactorForModel('anthropic/claude-opus-4.7')).toBeCloseTo(
      1.5,
      2,
    )
  })

  test('calibration family rules stay in sync with the tokenizer families (SEC-TC-CYCLE-1)', () => {
    // token-calibration owns its own copy of the family predicate so the
    // module cycle with token-counter stays broken; the copy must keep
    // resolving models exactly like getTokenizerForModel.
    const models = [
      'anthropic/claude-opus-4.7',
      'openai/gpt-4o',
      'google/gemini-2.5-pro',
      'some-unknown-model',
      '__proto__',
      'constructor',
      '',
      undefined,
    ]
    for (const model of models) {
      expect(calibrationFamilyForModel(model)).toBe(getTokenizerForModel(model))
    }
  })
})

describe('IncrementalTokenCounter model threading (audit: fudge factors dead on hot path)', () => {
  // Sized for a fast, deterministic BPE count: >100 chars so it follows the
  // same cacheable path the hot path uses, well under the 8k cache bound.
  const probeText = 'hot path pricing coverage message '.repeat(30)

  test("model 'openai/gpt-4o' yields LOWER counts than the no-model default (factor 1.0 vs 1.35)", () => {
    const noModel = new IncrementalTokenCounter()
    const openai = new IncrementalTokenCounter('openai/gpt-4o')
    const message = { role: 'user', content: probeText }
    const baseline = noModel.messageTokens(message)
    const threaded = openai.messageTokens(message)
    expect(threaded).toBeLessThan(baseline)
    // Exact external contract: each path equals countTokensJson with the
    // corresponding model argument (legacy 1.35 sentinel vs the 1.0 factor).
    expect(baseline).toBe(countTokensJson(message))
    expect(threaded).toBe(countTokensJson(message, 'openai/gpt-4o'))
    // messagesTokens delegates to messageTokens, so the sum prices with the
    // threaded model too.
    expect(openai.messagesTokens([message])).toBe(threaded)
  })

  test("model 'anthropic/claude-...' is identical to the no-model default", () => {
    const noModel = new IncrementalTokenCounter()
    const anthropic = new IncrementalTokenCounter('anthropic/claude-sonnet-4-5')
    const message = { role: 'user', content: probeText }
    // Both resolve to the Anthropic 1.35 factor (the sentinel default), so
    // threading a Claude model must not change any count.
    expect(anthropic.messageTokens(message)).toBe(
      noModel.messageTokens(message),
    )
  })

  test('setModel switches pricing for subsequently-counted NEW messages', () => {
    // WeakMap memoization caveat (documented on setModel): already-counted
    // message objects keep their memoized count after setModel — only NEW
    // message objects are priced with the new model's factor. That is
    // acceptable because counts are comparable-within-iteration estimates;
    // evicting the memo on setModel would change the pinned reset/eviction
    // behavior instead.
    const counter = new IncrementalTokenCounter()
    const beforeMessage = { role: 'user', content: probeText }
    const beforeCount = counter.messageTokens(beforeMessage)
    expect(beforeCount).toBe(countTokensJson(beforeMessage))

    counter.setModel('openai/gpt-4o')

    // The already-counted object keeps its memoized (legacy-default) count.
    expect(counter.messageTokens(beforeMessage)).toBe(beforeCount)
    // A NEW message object is priced with the new model's factor.
    const afterMessage = { role: 'user', content: probeText }
    expect(counter.messageTokens(afterMessage)).toBe(
      countTokensJson(afterMessage, 'openai/gpt-4o'),
    )
    expect(counter.messageTokens(afterMessage)).toBeLessThan(beforeCount)
  })
})
