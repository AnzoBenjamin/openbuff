/**
 * Retry Configuration Constants
 *
 * This module defines constants for retry behavior and exponential backoff.
 * Used by the CLI to automatically retry failed messages after reconnection.
 *
 * @example
 * ```typescript
 * import { MAX_RETRIES_PER_MESSAGE, RETRY_BACKOFF_BASE_DELAY_MS } from '@openbuff/sdk'
 *
 * let retryCount = 0
 * let backoffDelay = RETRY_BACKOFF_BASE_DELAY_MS
 *
 * while (retryCount < MAX_RETRIES_PER_MESSAGE) {
 *   await new Promise(resolve => setTimeout(resolve, backoffDelay))
 *   // ... retry logic
 *   backoffDelay = Math.min(backoffDelay * 2, RETRY_BACKOFF_MAX_DELAY_MS)
 *   retryCount++
 * }
 * ```
 */

import {
  getErrorStatusCode,
  isProviderContentPolicyError,
  isRetryableStatusCode,
} from './error-utils'

/**
 * Maximum number of retry attempts per message
 * After this many attempts, the message is marked as permanently failed
 */
export const MAX_RETRIES_PER_MESSAGE = 3

/**
 * Base delay in milliseconds for exponential backoff
 * First retry: 1s, Second: 2s, Third: 4s, Fourth: 8s (capped)
 */
export const RETRY_BACKOFF_BASE_DELAY_MS = 1000

/**
 * Maximum delay in milliseconds for exponential backoff
 * Prevents backoff from growing indefinitely
 */
export const RETRY_BACKOFF_MAX_DELAY_MS = 8000

/**
 * Jitter multiplier range applied to backoff delays (±20%).
 *
 * Each computed delay is multiplied by a random factor in
 * `[1 - JITTER_FRACTION, 1 + JITTER_FRACTION]` to prevent thundering-herd
 * retries when many clients retry simultaneously after a transient outage.
 * Matches the jitter strategy in `common/src/util/promise.ts`.
 */
export const RETRY_BACKOFF_JITTER_FRACTION = 0.2

/**
 * Compute the delay in milliseconds for retry attempt `attempt` (0-based)
 * using exponential backoff capped at `RETRY_BACKOFF_MAX_DELAY_MS`, with
 * optional jitter (±`RETRY_BACKOFF_JITTER_FRACTION`).
 *
 * @param attempt - 0-based attempt index (0 = first retry, 1 = second, ...)
 * @param baseDelayMs - base delay for the first attempt; defaults to
 *   `RETRY_BACKOFF_BASE_DELAY_MS`.
 * @param jitter - when true (default), apply ±20% jitter to the computed
 *   delay. Pass `false` only for tests that need deterministic timing.
 * @returns the delay in milliseconds (rounded to the nearest integer, clamped
 *   to `RETRY_BACKOFF_MAX_DELAY_MS`).
 */
export function computeBackoffDelayMs(params: {
  attempt: number
  baseDelayMs?: number
  jitter?: boolean
}): number {
  const {
    attempt,
    baseDelayMs = RETRY_BACKOFF_BASE_DELAY_MS,
    jitter = true,
  } = params

  const exponent = attempt < 0 ? 0 : attempt
  const base = Math.min(
    baseDelayMs * Math.pow(2, exponent),
    RETRY_BACKOFF_MAX_DELAY_MS,
  )

  if (!jitter) {
    return Math.round(base)
  }

  const lo = 1 - RETRY_BACKOFF_JITTER_FRACTION
  const span = 2 * RETRY_BACKOFF_JITTER_FRACTION
  const multiplier = lo + Math.random() * span
  const jittered = Math.min(base * multiplier, RETRY_BACKOFF_MAX_DELAY_MS)
  return Math.round(jittered)
}

function getAbortReasonError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  if (typeof signal.reason === 'string') {
    return new Error(signal.reason)
  }
  return new Error('Retry delay aborted')
}

/**
 * Wait for a retry backoff delay, rejecting promptly if the caller aborts.
 */
export function waitForBackoffDelay(params: {
  delayMs: number
  signal?: AbortSignal
}): Promise<void> {
  const { delayMs, signal } = params

  if (signal?.aborted) {
    return Promise.reject(getAbortReasonError(signal))
  }
  if (delayMs <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined

    const cleanup = () => {
      if (timeout !== undefined) {
        globalThis.clearTimeout(timeout)
        timeout = undefined
      }
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      reject(getAbortReasonError(signal!))
    }

    timeout = globalThis.setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

/**
 * Duration in milliseconds to show the reconnection message
 * After this time, the message auto-hides
 */
export const RECONNECTION_MESSAGE_DURATION_MS = 2000

/**
 * Delay in milliseconds before retrying messages after reconnection
 * Gives the connection time to stabilize before attempting retries
 */
export const RECONNECTION_RETRY_DELAY_MS = 500

// ============================================================================
// Shared retry policy (M3-T4)
//
// The streaming path (promptAiSdkStream) and the non-streaming paths
// (promptAiSdk / promptAiSdkStructured) must apply the SAME attempt budget
// and the SAME backoff curve. The policy object below is that single source
// of truth; `runWithRetryPolicy` executes it over any async operation.
// ============================================================================

/**
 * The canonical retry policy for LLM requests, streaming and non-streaming
 * alike: `MAX_RETRIES_PER_MESSAGE` retries on top of the initial attempt,
 * jittered exponential backoff starting at `RETRY_BACKOFF_BASE_DELAY_MS` and
 * capped at `RETRY_BACKOFF_MAX_DELAY_MS`.
 */
export const RETRY_POLICY = {
  maxRetries: MAX_RETRIES_PER_MESSAGE,
  baseDelayMs: RETRY_BACKOFF_BASE_DELAY_MS,
  maxDelayMs: RETRY_BACKOFF_MAX_DELAY_MS,
  jitterFraction: RETRY_BACKOFF_JITTER_FRACTION,
} as const

export type RetryPolicy = typeof RETRY_POLICY

/**
 * Check if an error is a transient network error that should be retried.
 * Handles socket disconnections, connection resets, timeouts, and other
 * temporary network failures that can occur during LLM calls.
 *
 * Moved here from `impl/llm.ts` (M3-T4) so the shared retry policy and the
 * error-class matrix can be unit-tested without importing the LLM module.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const err = error as {
    name?: string
    message?: string
    cause?: unknown
  }
  const message = (err.message ?? '').toLowerCase()

  // Check error names that indicate transient network issues.
  // TypeError is only treated as transient when the message also
  // indicates a network/fetch failure, to avoid retrying programming errors.
  const transientErrorNames = ['TimeoutError', 'FetchError']
  if (err.name && transientErrorNames.some((n) => err.name === n)) {
    return true
  }

  // AbortError from the underlying fetch (not our user cancellation)
  if (err.name === 'AbortError' && !message.includes('user cancelled')) {
    return true
  }

  // TypeError from Node fetch for network failures
  if (err.name === 'TypeError' && message.includes('fetch')) {
    return true
  }

  // Check common transient network error patterns in message
  const transientPatterns = [
    'socket',
    'connection was closed',
    'connection reset',
    'econnreset',
    'etimedout',
    'fetch failed',
    'network error',
    'unexpectedly closed',
    'broken pipe',
    'timeout',
    'econnrefused',
    'econnaborted',
    'enetunreach',
    'eai_again',
  ]

  for (const pattern of transientPatterns) {
    if (message.includes(pattern)) return true
  }

  // Check if AbortError by message (but not from our own signal.aborted)
  if (message.includes('abort') && !message.includes('user cancelled')) {
    return true
  }

  // Check cause chain for error codes and messages (walk recursively through causes)
  const seen = new Set<unknown>()
  let currentCause: unknown = err.cause
  while (currentCause && typeof currentCause === 'object') {
    if (seen.has(currentCause)) break // Guard against cyclic cause chains
    seen.add(currentCause)

    const causeObj = currentCause as {
      code?: string
      message?: string
      name?: string
      cause?: unknown
    }

    // Check nested cause codes (normalized to uppercase)
    if (causeObj.code) {
      const codeUpper = causeObj.code.toUpperCase()
      const transientCodes = [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'ECONNABORTED',
        'ENETUNREACH',
        'EAI_AGAIN',
        'UND_ERR_SOCKET',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_ABORTED',
        'EPIPE',
        'ENOTFOUND',
        'ENETDOWN',
      ]
      if (transientCodes.some((c) => codeUpper === c)) return true
    }

    // Check nested cause messages for transient patterns
    if (causeObj.message) {
      const causeMessage = causeObj.message.toLowerCase()
      for (const pattern of transientPatterns) {
        if (causeMessage.includes(pattern)) return true
      }
      if (
        causeMessage.includes('abort') &&
        !causeMessage.includes('user cancelled')
      ) {
        return true
      }
    }

    // Check nested cause names
    if (causeObj.name) {
      if (
        causeObj.name === 'TimeoutError' ||
        causeObj.name === 'FetchError' ||
        (causeObj.name === 'AbortError' &&
          !(causeObj.message ?? '').toLowerCase().includes('user cancelled'))
      ) {
        return true
      }
    }

    currentCause = causeObj.cause
  }

  return false
}

/**
 * The retry decision for one caught error, produced by
 * {@link classifyRetryableError} and consumed by {@link runWithRetryPolicy}.
 *
 * - `retryable: false` — the error class cannot be fixed by retrying
 *   (content-policy refusals, 4xx client errors such as 400/401/402/403/404,
 *   programming errors, user aborts). The original error is rethrown
 *   immediately.
 * - `retryable: true` with `delayMs` — the error is transient/retryable
 *   (429/408/5xx, socket and timeout errors); wait `delayMs` (0 when the
 *   server sent a retryable-hint that is unusable — never negative) and
 *   retry while attempts remain.
 */
export type RetryDecision = {
  retryable: boolean
  /** Parsed Retry-After delay in ms, when a valid header was present. */
  delayMs?: number
}

/**
 * Parse a `Retry-After` header value into a delay in milliseconds.
 *
 * Accepts the two RFC 7231 forms:
 * - delta-seconds: a non-negative integer number of seconds
 * - HTTP-date: an absolute date; the delay is `date - now`
 *
 * Returns `undefined` (fail closed) for anything else — missing header,
 * negative/NaN/fractional seconds, dates in the past, or unparseable values —
 * so callers fall back to the default exponential backoff rather than
 * trusting a hostile or malformed hint (M3-T4 risk note).
 */
export function parseRetryAfterMs(params: {
  header: string | undefined | null
  now?: number
}): number | undefined {
  const { header, now = Date.now() } = params
  if (typeof header !== 'string') return undefined
  const trimmed = header.trim()
  if (trimmed.length === 0) return undefined

  // Delta-seconds form: strictly a non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(seconds) || seconds < 0) return undefined
    // Cap at the policy max so a hostile 1-year Retry-After cannot stall a run.
    return Math.min(seconds * 1000, RETRY_BACKOFF_MAX_DELAY_MS)
  }

  // HTTP-date form.
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  const delayMs = dateMs - now
  if (delayMs <= 0) return undefined
  return Math.min(delayMs, RETRY_BACKOFF_MAX_DELAY_MS)
}

/**
 * Extract a `Retry-After` header value from an error when one is present.
 *
 * The AI SDK surfaces provider errors with a `responseHeaders` record (and
 * some wrappers expose `headers`); only string values from those shapes are
 * trusted, and everything else yields `undefined` so parsing fails closed.
 */
function getRetryAfterHeader(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as {
    responseHeaders?: unknown
    headers?: unknown
  }
  for (const candidate of [record.responseHeaders, record.headers]) {
    if (!candidate || typeof candidate !== 'object') continue
    const headers = candidate as Record<string, unknown>
    const value =
      headers['retry-after'] ?? headers['Retry-After'] ?? headers.RETRY_AFTER
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Error-class gate for the shared retry policy (the retry matrix):
 *
 * | Error class                                 | Retry? |
 * |---------------------------------------------|--------|
 * | provider content-policy (code classifier)   | no     |
 * | HTTP 4xx other than 408/429 (client error)  | no     |
 * | HTTP 408/429 or 5xx (retryable status)      | yes    |
 * | transient network/timeout/socket errors     | yes    |
 * | anything else (programming errors, aborts)  | no     |
 *
 * A valid `Retry-After` header on a retryable error overrides the exponential
 * backoff for that attempt; a missing/invalid one is ignored (fail closed) and
 * the caller's default backoff applies.
 */
export function classifyRetryableError(error: unknown): RetryDecision {
  // Content-policy refusals are deterministic provider decisions: retrying
  // the same prompt cannot fix them (M3-T4).
  if (isProviderContentPolicyError(error)) return { retryable: false }

  const statusCode = getErrorStatusCode(error)
  if (isRetryableStatusCode(statusCode)) {
    const header = getRetryAfterHeader(error)
    if (header !== undefined) {
      const delayMs = parseRetryAfterMs({ header })
      if (delayMs !== undefined) return { retryable: true, delayMs }
    }
    return { retryable: true }
  }

  // A non-retryable explicit status (e.g. 400/401/404) is a client error:
  // no transient-message pattern can rescue it.
  if (statusCode !== undefined) return { retryable: false }

  if (isTransientNetworkError(error)) return { retryable: true }

  return { retryable: false }
}

/**
 * Execute `operation` under the shared retry policy: up to
 * `policy.maxRetries` retries after the initial attempt, retrying only when
 * {@link classifyRetryableError} marks the error retryable, waiting
 * `waitForBackoffDelay` between attempts (the `Retry-After` hint when the
 * provider sent a valid one, otherwise jittered exponential backoff via
 * {@link computeBackoffDelayMs}).
 *
 * This is the SAME policy object and backoff helpers the streaming loop in
 * `impl/llm.ts` uses — factored out (M3-T4) so non-streaming
 * `generateText`/`generateObject` paths retry transient failures exactly like
 * the streaming path does.
 *
 * @param operation - retried async operation. Receives the 0-based attempt
 *   index so callers can thread attempt counts into telemetry.
 * @param params.signal - aborts the backoff wait promptly (never converts an
 *   abort into a retry).
 * @param params.sleep - injectable delay fn (tests must not really sleep).
 *   Receives the caller's `signal` as its second argument so an injected
 *   sleep can honor aborts mid-backoff, matching the
 *   `(ms, signal?)` shape `promptFlashWithFallbacks` uses.
 * @param params.onRetry - observational callback before each backoff wait; a
 *   throwing consumer is the caller's problem (it propagates).
 */
export async function runWithRetryPolicy<T>(params: {
  operation: (attempt: number) => Promise<T>
  policy?: RetryPolicy
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  onRetry?: (info: {
    error: unknown
    attempt: number
    nextAttemptIn: number
    delayMs: number
  }) => void
}): Promise<T> {
  const {
    operation,
    policy = RETRY_POLICY,
    signal,
    sleep = (ms: number) => waitForBackoffDelay({ delayMs: ms, signal }),
    onRetry,
  } = params

  let lastError: unknown
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      // Never retry user-cancelled requests: honor the abort immediately
      // (same semantics as the streaming loop's params.signal.aborted check).
      // Throw the abort reason (an abort-class error), never the raw
      // provider error — callers classify via isAbortError, and rethrowing
      // a retryable 5xx observed aborted during the request would
      // misclassify user cancellation as a provider failure (reliability
      // finding retrypolicy-abort-window-throws-provider-error); mirrors
      // the post-backoff gate below.
      if (signal?.aborted) throw getAbortReasonError(signal)
      const decision = classifyRetryableError(error)
      if (!decision.retryable) throw error
      if (attempt >= policy.maxRetries) throw error

      const delayMs =
        decision.delayMs ??
        computeBackoffDelayMs({
          attempt,
          baseDelayMs: policy.baseDelayMs,
        })
      onRetry?.({ error, attempt, nextAttemptIn: attempt + 2, delayMs })
      await sleep(delayMs, signal)
      // Abort-during-backoff gate (reliability finding
      // runwithretrypolicy-injected-sleep-uninterruptible): an injected
      // sleep that does not itself reject on abort must not cost one more
      // full request — re-check the signal after the wait and surface the
      // abort before the next attempt is dispatched. Throw the abort reason
      // (an abort-class error), never the last transient provider error:
      // callers classify via isAbortError, and rethrowing the retryable 5xx
      // would misclassify user cancellation as a provider failure
      // (reliability finding
      // runwithretrypolicy-post-backoff-throws-transient-error).
      if (signal?.aborted) throw getAbortReasonError(signal)
    }
  }
  // Unreachable: every loop iteration either returns, throws, or sleeps and
  // continues; the final iteration throws above.
  throw lastError
}
