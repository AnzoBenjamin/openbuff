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

import { NoOutputGeneratedError } from 'ai'

import {
  getErrorStatusCode,
  isProviderAbortError,
  providerErrorChain,
  normalizeProviderContentPolicyError,
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
 * Maximum server-requested wait (`Retry-After`) honoured for one retry.
 * Tier-limited Anthropic and OpenAI keys commonly ask for 30–60 s; retrying
 * after the 8 s backoff cap only burns attempts. Longer hints are clamped to
 * this value. The wait is aborted by the run signal, so it never outlives the
 * run deadline.
 */
export const RETRY_AFTER_MAX_DELAY_MS = 120_000

/**
 * Total backoff wait allowed for one request across all its retries and
 * failover routes. Bounds a chain of long `Retry-After` waits.
 */
export const RETRY_MAX_TOTAL_DELAY_MS = 180_000

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
  maxDelayMs?: number
  jitterFraction?: number
}): number {
  const {
    attempt,
    baseDelayMs = RETRY_BACKOFF_BASE_DELAY_MS,
    jitter = true,
    maxDelayMs = RETRY_BACKOFF_MAX_DELAY_MS,
    jitterFraction = RETRY_BACKOFF_JITTER_FRACTION,
  } = params

  const exponent = attempt < 0 ? 0 : attempt
  const base = Math.min(baseDelayMs * Math.pow(2, exponent), maxDelayMs)

  if (!jitter) {
    return Math.round(base)
  }

  const lo = 1 - jitterFraction
  const span = 2 * jitterFraction
  const multiplier = lo + Math.random() * span
  const jittered = Math.min(base * multiplier, maxDelayMs)
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
  retryAfterMaxDelayMs: RETRY_AFTER_MAX_DELAY_MS,
  maxTotalDelayMs: RETRY_MAX_TOTAL_DELAY_MS,
} as const

export type RetryPolicy = {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitterFraction: number
  backupMaxRetries?: number
  maxTotalAttempts?: number
  retryAfterMaxDelayMs?: number
  maxTotalDelayMs?: number
  /** Clock for HTTP-date `Retry-After` values. Defaults to `Date.now`. */
  now?: () => number
}

/** Internal execution seam shared by streaming and nonstreaming requests. */
export type RetryExecutionOptions = {
  retryPolicy?: RetryPolicy
  retrySleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** One request ledger, retained across context repair and OAuth recovery. */
export type RequestRetryBudget = {
  attempts: number
  waitMs: number
  maxAttempts: number
  maxWaitMs: number
  primaryModel: string
  routeAttempts: Map<string, number>
  lastError?: unknown
  exhausted?: boolean
}

export function createRequestRetryBudget(
  policy: RetryPolicy,
  primaryModel: string,
  routeCount: number,
): RequestRetryBudget {
  const maxAttempts =
    policy.maxTotalAttempts ??
    policy.maxRetries +
      1 +
      Math.max(0, routeCount - 1) *
        ((policy.backupMaxRetries ?? policy.maxRetries) + 1)
  const maxWaitMs =
    policy.maxTotalDelayMs ??
    maxAttempts *
      Math.max(
        policy.maxDelayMs,
        policy.retryAfterMaxDelayMs ?? policy.maxDelayMs,
      )
  for (const value of [
    policy.maxRetries,
    policy.backupMaxRetries ?? policy.maxRetries,
    maxAttempts - 1,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(
        'Retry attempt limits must be finite nonnegative integers',
      )
  }
  for (const value of [
    policy.baseDelayMs,
    policy.maxDelayMs,
    policy.retryAfterMaxDelayMs ?? policy.maxDelayMs,
    maxWaitMs,
  ]) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error('Retry delay limits must be finite nonnegative numbers')
  }
  if (
    !Number.isFinite(policy.jitterFraction) ||
    policy.jitterFraction < 0 ||
    policy.jitterFraction > 1
  ) {
    throw new Error('Retry jitter must be between zero and one')
  }
  return {
    attempts: 0,
    waitMs: 0,
    maxAttempts,
    maxWaitMs,
    primaryModel,
    routeAttempts: new Map(),
  }
}

export function getRouteAttemptLimit(
  policy: RetryPolicy,
  budget: RequestRetryBudget,
  model: string,
): number {
  return (
    (model === budget.primaryModel
      ? policy.maxRetries
      : (policy.backupMaxRetries ?? policy.maxRetries)) + 1
  )
}

export function canAdmitRequestAttempt(
  policy: RetryPolicy,
  budget: RequestRetryBudget,
  model: string,
): boolean {
  return (
    !budget.exhausted &&
    budget.attempts < budget.maxAttempts &&
    (budget.routeAttempts.get(model) ?? 0) <
      getRouteAttemptLimit(policy, budget, model)
  )
}

export function admitRequestAttempt(
  policy: RetryPolicy,
  budget: RequestRetryBudget,
  model: string,
): void {
  if (!canAdmitRequestAttempt(policy, budget, model)) {
    throw (
      budget.lastError ??
      new Error('Provider retry attempt allowance exhausted')
    )
  }
  budget.attempts++
  budget.routeAttempts.set(model, (budget.routeAttempts.get(model) ?? 0) + 1)
}

export function getRetryDelayMs(
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
): number {
  return (
    classifyRetryableError(error, policy).delayMs ??
    computeBackoffDelayMs({
      attempt,
      baseDelayMs: policy.baseDelayMs,
      maxDelayMs: policy.maxDelayMs,
      jitterFraction: policy.jitterFraction,
      jitter: policy.jitterFraction > 0,
    })
  )
}

/**
 * Check if an error is a transient network error that should be retried.
 * Handles socket disconnections, connection resets, timeouts, and other
 * temporary network failures that can occur during LLM calls.
 *
 * Moved here from `impl/llm.ts` (M3-T4) so the shared retry policy and the
 * error-class matrix can be unit-tested without importing the LLM module.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (isProviderAbortError(error)) return false
  const transientCodes = new Set([
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
    'EPIPE',
    'ENOTFOUND',
    'ENETDOWN',
  ])
  const patterns = [
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
  for (const value of providerErrorChain(error)) {
    if (value.name === 'TimeoutError' || value.name === 'FetchError')
      return true
    if (
      typeof value.code === 'string' &&
      transientCodes.has(value.code.toUpperCase())
    )
      return true
    if (typeof value.message !== 'string') continue
    const message = value.message.toLowerCase()
    if (value.name === 'TypeError' && message.includes('fetch')) return true
    if (patterns.some((pattern) => message.includes(pattern))) return true
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
  maxDelayMs?: number
}): number | undefined {
  const {
    header,
    now = Date.now(),
    maxDelayMs = RETRY_BACKOFF_MAX_DELAY_MS,
  } = params
  if (typeof header !== 'string') return undefined
  const trimmed = header.trim()
  if (trimmed.length === 0) return undefined

  // Delta-seconds form: strictly a non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(seconds) || seconds < 0) return undefined
    // Cap at the policy max so a hostile 1-year Retry-After cannot stall a run.
    return Math.min(seconds * 1000, maxDelayMs)
  }

  // HTTP-date form.
  // Date.parse also accepts malformed numeric values such as "3.5" or "-5".
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      trimmed,
    )
  )
    return undefined
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  const delayMs = dateMs - now
  if (delayMs <= 0) return undefined
  return Math.min(delayMs, maxDelayMs)
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
  for (const record of providerErrorChain(error)) {
    for (const candidate of [record.responseHeaders, record.headers]) {
      if (!candidate || typeof candidate !== 'object') continue
      if (candidate instanceof Headers) {
        const value = candidate.get('retry-after')
        if (value !== null) return value
        continue
      }
      for (const [name, value] of Object.entries(candidate)) {
        if (
          (name.toLowerCase() === 'retry-after' || name === 'RETRY_AFTER') &&
          typeof value === 'string'
        )
          return value
      }
    }
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
export function classifyRetryableError(
  error: unknown,
  policy: RetryPolicy = RETRY_POLICY,
): RetryDecision {
  // Content-policy refusals are deterministic provider decisions: retrying
  // the same prompt cannot fix them (M3-T4).
  if (isProviderAbortError(error) || normalizeProviderContentPolicyError(error))
    return { retryable: false }
  if (
    [...providerErrorChain(error)].some(
      (value) =>
        value.code === 'provider_configuration' ||
        value.code === 'provider_route_excluded',
    )
  )
    return { retryable: false }

  const statusCode = getErrorStatusCode(error)
  if (isRetryableStatusCode(statusCode)) {
    const header = getRetryAfterHeader(error)
    if (header !== undefined) {
      const delayMs = parseRetryAfterMs({
        header,
        now: policy.now?.(),
        maxDelayMs: policy.retryAfterMaxDelayMs ?? policy.maxDelayMs,
      })
      if (delayMs !== undefined) return { retryable: true, delayMs }
    }
    return { retryable: true }
  }

  // A non-retryable explicit status (e.g. 400/401/404) is a client error:
  // no transient-message pattern can rescue it.
  if (statusCode !== undefined) return { retryable: false }

  if (NoOutputGeneratedError.isInstance(error)) return { retryable: true }
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
  const budget = createRequestRetryBudget(policy, 'request', 1)
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      if (signal?.aborted) throw getAbortReasonError(signal)
      admitRequestAttempt(policy, budget, 'request')
      const result = await operation(attempt)
      if (signal?.aborted) throw getAbortReasonError(signal)
      return result
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
      const decision = classifyRetryableError(error, policy)
      if (!decision.retryable) throw error
      if (attempt >= policy.maxRetries) throw error

      const delayMs = getRetryDelayMs(error, attempt, policy)
      if (
        !canAdmitRequestAttempt(policy, budget, 'request') ||
        budget.waitMs + delayMs > budget.maxWaitMs
      )
        throw error
      budget.waitMs += delayMs
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
