import { describe, expect, test } from 'bun:test'

import {
  classifyRetryableError,
  computeBackoffDelayMs,
  isTransientNetworkError,
  MAX_RETRIES_PER_MESSAGE,
  parseRetryAfterMs,
  RETRY_BACKOFF_BASE_DELAY_MS,
  RETRY_BACKOFF_MAX_DELAY_MS,
  RETRY_BACKOFF_JITTER_FRACTION,
  RETRY_POLICY,
  runWithRetryPolicy,
  waitForBackoffDelay,
} from '../retry-config'
import {
  createHttpError,
  createProviderContentPolicyError,
} from '../error-utils'

describe('retry-config constants', () => {
  test('exposes the canonical retry constants', () => {
    expect(MAX_RETRIES_PER_MESSAGE).toBe(3)
    expect(RETRY_BACKOFF_BASE_DELAY_MS).toBe(1000)
    expect(RETRY_BACKOFF_MAX_DELAY_MS).toBe(8000)
    expect(RETRY_BACKOFF_JITTER_FRACTION).toBe(0.2)
  })
})

describe('waitForBackoffDelay', () => {
  test('rejects immediately when already aborted', async () => {
    const abortController = new AbortController()
    abortController.abort(new Error('user cancelled'))

    await expect(
      waitForBackoffDelay({
        delayMs: RETRY_BACKOFF_BASE_DELAY_MS,
        signal: abortController.signal,
      }),
    ).rejects.toThrow('user cancelled')
  })

  test('rejects promptly when aborted during the delay', async () => {
    const abortController = new AbortController()
    const delayPromise = waitForBackoffDelay({
      delayMs: RETRY_BACKOFF_MAX_DELAY_MS,
      signal: abortController.signal,
    })

    abortController.abort('retry cancelled')

    await expect(delayPromise).rejects.toThrow('retry cancelled')
  })

  test('rejects when aborted after timer creation but before listener registration', async () => {
    const abortController = new AbortController()
    const originalSetTimeout = globalThis.setTimeout

    try {
      globalThis.setTimeout = ((
        ...args: Parameters<typeof globalThis.setTimeout>
      ) => {
        const timeoutId = originalSetTimeout(...args)
        abortController.abort('setup race cancelled')
        return timeoutId
      }) as typeof globalThis.setTimeout

      await expect(
        waitForBackoffDelay({
          delayMs: RETRY_BACKOFF_MAX_DELAY_MS,
          signal: abortController.signal,
        }),
      ).rejects.toThrow('setup race cancelled')
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('resolves normally when the delay elapses', async () => {
    await expect(waitForBackoffDelay({ delayMs: 1 })).resolves.toBeUndefined()
  })
})

describe('computeBackoffDelayMs', () => {
  test('exponential growth without jitter (deterministic)', () => {
    // attempt 0 -> base * 2^0 = 1000
    expect(computeBackoffDelayMs({ attempt: 0, jitter: false })).toBe(1000)
    // attempt 1 -> base * 2^1 = 2000
    expect(computeBackoffDelayMs({ attempt: 1, jitter: false })).toBe(2000)
    // attempt 2 -> base * 2^2 = 4000
    expect(computeBackoffDelayMs({ attempt: 2, jitter: false })).toBe(4000)
    // attempt 3 -> base * 2^3 = 8000 (at cap)
    expect(computeBackoffDelayMs({ attempt: 3, jitter: false })).toBe(8000)
  })

  test('caps at RETRY_BACKOFF_MAX_DELAY_MS without jitter', () => {
    expect(computeBackoffDelayMs({ attempt: 4, jitter: false })).toBe(
      RETRY_BACKOFF_MAX_DELAY_MS,
    )
    expect(computeBackoffDelayMs({ attempt: 10, jitter: false })).toBe(
      RETRY_BACKOFF_MAX_DELAY_MS,
    )
    expect(computeBackoffDelayMs({ attempt: 100, jitter: false })).toBe(
      RETRY_BACKOFF_MAX_DELAY_MS,
    )
  })

  test('honors a custom baseDelayMs', () => {
    expect(
      computeBackoffDelayMs({ attempt: 0, baseDelayMs: 500, jitter: false }),
    ).toBe(500)
    expect(
      computeBackoffDelayMs({ attempt: 2, baseDelayMs: 500, jitter: false }),
    ).toBe(2000)
    // custom base still capped at the global max
    expect(
      computeBackoffDelayMs({ attempt: 5, baseDelayMs: 500, jitter: false }),
    ).toBe(RETRY_BACKOFF_MAX_DELAY_MS)
  })

  test('treats negative attempt as 0', () => {
    expect(computeBackoffDelayMs({ attempt: -1, jitter: false })).toBe(
      RETRY_BACKOFF_BASE_DELAY_MS,
    )
    expect(computeBackoffDelayMs({ attempt: -100, jitter: false })).toBe(
      RETRY_BACKOFF_BASE_DELAY_MS,
    )
  })

  test('applies jitter within ±JITTER_FRACTION bounds', () => {
    // With jitter on, the result must stay within
    // [base * (1 - frac), base * (1 + frac)] (rounded), and never exceed the cap.
    const attempt = 1 // base = 2000
    const lo = Math.round(2000 * (1 - RETRY_BACKOFF_JITTER_FRACTION))
    const hi = Math.round(2000 * (1 + RETRY_BACKOFF_JITTER_FRACTION))
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelayMs({ attempt })
      expect(delay).toBeGreaterThanOrEqual(lo)
      expect(delay).toBeLessThanOrEqual(hi)
    }
  })

  test('jitter never exceeds the max cap', () => {
    // At the cap (attempt 3+), jitter must not push past MAX_DELAY_MS.
    for (let i = 0; i < 50; i++) {
      expect(computeBackoffDelayMs({ attempt: 3 })).toBeLessThanOrEqual(
        RETRY_BACKOFF_MAX_DELAY_MS,
      )
      expect(computeBackoffDelayMs({ attempt: 10 })).toBeLessThanOrEqual(
        RETRY_BACKOFF_MAX_DELAY_MS,
      )
    }
  })

  test('jitter defaults to true', () => {
    // Without an explicit jitter flag, the function should still produce
    // in-bounds jittered values (i.e. not the exact deterministic value across
    // many calls, and within the jitter band).
    const attempt = 2 // base = 4000
    const lo = Math.round(4000 * (1 - RETRY_BACKOFF_JITTER_FRACTION))
    const hi = Math.round(4000 * (1 + RETRY_BACKOFF_JITTER_FRACTION))
    const values = new Set<number>()
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelayMs({ attempt })
      values.add(delay)
      expect(delay).toBeGreaterThanOrEqual(lo)
      expect(delay).toBeLessThanOrEqual(hi)
    }
    // With ±20% jitter over 50 samples, we expect at least some variation.
    expect(values.size).toBeGreaterThan(1)
  })

  test('returns an integer', () => {
    expect(
      Number.isInteger(computeBackoffDelayMs({ attempt: 0, jitter: false })),
    ).toBe(true)
    expect(
      Number.isInteger(computeBackoffDelayMs({ attempt: 1, jitter: false })),
    ).toBe(true)
    // jittered results should also be integers (Math.round)
    for (let i = 0; i < 20; i++) {
      expect(Number.isInteger(computeBackoffDelayMs({ attempt: i }))).toBe(true)
    }
  })
})

describe('RETRY_POLICY (M3-T4 shared policy object)', () => {
  test('is the canonical policy: same budget and backoff curve as the streaming loop', () => {
    expect(RETRY_POLICY.maxRetries).toBe(MAX_RETRIES_PER_MESSAGE)
    expect(RETRY_POLICY.baseDelayMs).toBe(RETRY_BACKOFF_BASE_DELAY_MS)
    expect(RETRY_POLICY.maxDelayMs).toBe(RETRY_BACKOFF_MAX_DELAY_MS)
    expect(RETRY_POLICY.jitterFraction).toBe(RETRY_BACKOFF_JITTER_FRACTION)
  })
})

describe('retry matrix: error class × retry decision', () => {
  test('content-policy errors are NOT retryable', () => {
    expect(
      classifyRetryableError(createProviderContentPolicyError({ statusCode: 400 })),
    ).toEqual({ retryable: false })
  })

  test('non-retryable 4xx client errors are NOT retryable', () => {
    for (const statusCode of [400, 401, 402, 403, 404, 422]) {
      expect(classifyRetryableError(createHttpError('client error', statusCode))).toEqual({
        retryable: false,
      })
    }
  })

  test('retryable statuses (408/429/5xx) ARE retryable without a Retry-After header', () => {
    for (const statusCode of [408, 429, 500, 502, 503, 504]) {
      expect(classifyRetryableError(createHttpError('server error', statusCode))).toEqual({
        retryable: true,
      })
    }
  })

  test('a valid Retry-After delta-seconds header overrides the default backoff (capped)', () => {
    const error = createHttpError('rate limited', 429)
    ;(error as unknown as { responseHeaders: Record<string, string> }).responseHeaders = {
      'retry-after': '30',
    }
    // 30s exceeds the policy cap, so the parsed delay is capped at
    // RETRY_BACKOFF_MAX_DELAY_MS (same fail-closed cap as the oversized hint).
    expect(classifyRetryableError(error)).toEqual({
      retryable: true,
      delayMs: RETRY_BACKOFF_MAX_DELAY_MS,
    })
  })

  test('an oversized Retry-After hint is capped at RETRY_BACKOFF_MAX_DELAY_MS', () => {
    const error = createHttpError('rate limited', 429)
    ;(error as unknown as { responseHeaders: Record<string, string> }).responseHeaders = {
      'retry-after': '31536000', // one year
    }
    expect(classifyRetryableError(error)).toEqual({
      retryable: true,
      delayMs: RETRY_BACKOFF_MAX_DELAY_MS,
    })
  })

  test('missing/invalid Retry-After headers fail closed to the default backoff', () => {
    for (const header of [undefined, '', '  ', '-5', '3.5', 'soon', 'not-a-date']) {
      expect(parseRetryAfterMs({ header })).toBeUndefined()
    }
  })

  test('a valid HTTP-date Retry-After in the future is honored; past dates fail closed', () => {
    const now = 1_700_000_000_000
    expect(
      parseRetryAfterMs({ header: new Date(now + 5_000).toUTCString(), now }),
    ).toBe(5_000)
    expect(
      parseRetryAfterMs({ header: new Date(now - 5_000).toUTCString(), now }),
    ).toBeUndefined()
  })

  test('transient network errors without a status ARE retryable', () => {
    const error = new Error('fetch failed: ECONNRESET')
    expect(isTransientNetworkError(error)).toBe(true)
    expect(classifyRetryableError(error)).toEqual({ retryable: true })
  })

  test('programming errors and aborts are NOT retryable', () => {
    expect(classifyRetryableError(new Error('Cannot read properties of undefined'))).toEqual({
      retryable: false,
    })
    const abort = new Error('user cancelled')
    abort.name = 'AbortError'
    expect(classifyRetryableError(abort)).toEqual({ retryable: false })
  })
})

describe('runWithRetryPolicy', () => {
  test('retries transient errors with the shared policy budget and backoff curve', async () => {
    const delays: number[] = []
    let attempts = 0
    const result = await runWithRetryPolicy({
      operation: async () => {
        attempts++
        if (attempts < 3) throw createHttpError('server error', 503)
        return 'ok'
      },
      sleep: async (ms) => {
        delays.push(ms)
      },
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    // Backoff curve matches computeBackoffDelayMs with the policy's jitter
    // applied (same policy object drives both): attempt 0 -> base ±20%,
    // attempt 1 -> base * 2 ±20%, and the curve still grows (the jitter bands
    // of consecutive attempts do not overlap).
    const lo = (baseMs: number) =>
      Math.round(baseMs * (1 - RETRY_BACKOFF_JITTER_FRACTION))
    const hi = (baseMs: number) =>
      Math.round(baseMs * (1 + RETRY_BACKOFF_JITTER_FRACTION))
    expect(delays).toHaveLength(2)
    expect(delays[0]).toBeGreaterThanOrEqual(lo(RETRY_BACKOFF_BASE_DELAY_MS))
    expect(delays[0]).toBeLessThanOrEqual(hi(RETRY_BACKOFF_BASE_DELAY_MS))
    expect(delays[1]).toBeGreaterThanOrEqual(
      lo(RETRY_BACKOFF_BASE_DELAY_MS * 2),
    )
    expect(delays[1]).toBeLessThanOrEqual(
      hi(RETRY_BACKOFF_BASE_DELAY_MS * 2),
    )
    expect(delays[1]).toBeGreaterThan(delays[0])
  })

  test('does NOT retry content-policy or 4xx errors (fails fast on attempt 1)', async () => {
    for (const error of [
      createProviderContentPolicyError({ statusCode: 400 }),
      createHttpError('bad request', 400),
    ]) {
      let attempts = 0
      await expect(
        runWithRetryPolicy({
          operation: async () => {
            attempts++
            throw error
          },
          sleep: async () => {
            throw new Error('test bug: must never sleep for a non-retryable error')
          },
        }),
      ).rejects.toThrow()
      expect(attempts).toBe(1)
    }
  })

  test('exhausts the shared budget (maxRetries + 1 attempts) then throws the last error', async () => {
    let attempts = 0
    await expect(
      runWithRetryPolicy({
        operation: async () => {
          attempts++
          throw createHttpError('still unavailable', 503)
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow('still unavailable')
    expect(attempts).toBe(RETRY_POLICY.maxRetries + 1)
  })

  test('honors a valid Retry-After hint instead of the exponential curve', async () => {
    const delays: number[] = []
    let attempts = 0
    await expect(
      runWithRetryPolicy({
        operation: async () => {
          attempts++
          const error = createHttpError('rate limited', 429)
          ;(error as unknown as { responseHeaders: Record<string, string> }).responseHeaders = {
            'retry-after': '7',
          }
          throw error
        },
        sleep: async (ms) => {
          delays.push(ms)
        },
      }),
    ).rejects.toThrow()
    expect(attempts).toBe(RETRY_POLICY.maxRetries + 1)
    // Sleeps happen between attempts only: maxRetries sleeps for
    // maxRetries + 1 total attempts (the final attempt throws without sleeping).
    expect(delays).toEqual([7_000, 7_000, 7_000])
  })

  test('never retries after the caller aborts', async () => {
    const controller = new AbortController()
    let attempts = 0
    await expect(
      runWithRetryPolicy({
        signal: controller.signal,
        operation: async () => {
          attempts++
          controller.abort()
          throw createHttpError('server error', 503)
        },
        sleep: async () => {
          throw new Error('test bug: must never sleep after an abort')
        },
      }),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  test('retries 429 rate limits even without a Retry-After header (pin: nonretryable-429-fail-fast)', () => {
    // A provider rate limit with no parseable Retry-After header must fall
    // back to the default exponential backoff, never fail the message fast —
    // the retry matrix pins 'HTTP 408/429 or 5xx (retryable status) | yes'.
    expect(classifyRetryableError(createHttpError('rate limited', 429))).toEqual(
      { retryable: true },
    )
  })

  test('threads the caller signal into the injected sleep', async () => {
    const controller = new AbortController()
    const seenSignals: (AbortSignal | undefined)[] = []
    let attempts = 0
    // Succeed on the second attempt so the bounded default policy sleeps
    // exactly once and the assertion below pins the signal threading of
    // that one backoff wait deterministically.
    const result = await runWithRetryPolicy({
      signal: controller.signal,
      operation: async () => {
        attempts++
        if (attempts === 1) throw createHttpError('server error', 503)
        return 'ok'
      },
      sleep: async (_ms, signal) => {
        seenSignals.push(signal)
      },
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(2)
    expect(seenSignals).toHaveLength(1)
    expect(seenSignals[0]).toBe(controller.signal)
  })

  test('an abort during the injected sleep costs no extra attempt (non-abort-aware sleep)', async () => {
    const controller = new AbortController()
    let attempts = 0
    await expect(
      runWithRetryPolicy({
        signal: controller.signal,
        operation: async () => {
          attempts++
          throw createHttpError('server error', 503)
        },
        // Non-abort-aware injected sleep: it aborts the caller's signal but
        // resolves normally. The retry loop must re-check the signal after
        // the wait instead of dispatching another full request.
        sleep: async () => {
          controller.abort()
        },
      }),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  test('an abort during the injected sleep surfaces the abort reason, not the transient error', async () => {
    const controller = new AbortController()
    const abortError = new Error('user cancelled')
    let caught: unknown
    try {
      await runWithRetryPolicy({
        signal: controller.signal,
        operation: async () => {
          throw createHttpError('server error', 503)
        },
        // Non-abort-aware injected sleep: it aborts the caller's signal but
        // resolves normally, so the post-backoff gate must supply the
        // abort-class error itself.
        sleep: async () => {
          controller.abort(abortError)
        },
      })
    } catch (error) {
      caught = error
    }
    // Callers classify via isAbortError: the thrown error must be the abort
    // reason, never the retryable 503 (reliability finding
    // runwithretrypolicy-post-backoff-throws-transient-error).
    expect(caught).toBe(abortError)
  })
})
