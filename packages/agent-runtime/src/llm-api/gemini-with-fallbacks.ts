import { openaiModels, openrouterModels } from '@codebuff/common/old-constants'
import {
  AbortError,
  isAbortError,
  unwrapPromptResult,
} from '@codebuff/common/util/error'

import type { FinetunedVertexModel } from '@codebuff/common/old-constants'
import type { PromptAiSdkFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

// ---------------------------------------------------------------------------
// Error-class gating (M3-T4)
//
// The runtime module cannot import the SDK's `error-utils` (the SDK depends on
// the runtime, never the reverse), so the small status/code classifiers the
// gating needs are mirrored here from `sdk/src/error-utils.ts` and kept
// shape-compatible with it: `statusCode` (our convention) and `status` (AI SDK
// APICallError convention) both read; content-policy errors carry the same
// `code` literal the SDK classifies.
// ---------------------------------------------------------------------------

/** Retryable HTTP statuses: 408/429 plus the 5xx family. */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

const PROVIDER_CONTENT_POLICY_ERROR_CODE = 'provider_content_policy'

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as { statusCode?: unknown; status?: unknown }
  if (typeof record.statusCode === 'number') return record.statusCode
  if (typeof record.status === 'number') return record.status
  return undefined
}

function isProviderContentPolicyError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code ===
      PROVIDER_CONTENT_POLICY_ERROR_CODE
  )
}

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) into a
 * delay in milliseconds. Fail-closed: anything missing, malformed, negative,
 * or in the past yields `undefined` so the caller falls back to the default
 * exponential backoff instead of trusting a hostile hint. Delays are capped
 * at {@link MAX_BACKOFF_DELAY_MS}.
 */
export function parseRetryAfterMs(params: {
  header: string | undefined | null
  now?: number
}): number | undefined {
  const { header, now = Date.now() } = params
  if (typeof header !== 'string') return undefined
  const trimmed = header.trim()
  if (trimmed.length === 0) return undefined

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(seconds) || seconds < 0) return undefined
    return Math.min(seconds * 1000, MAX_BACKOFF_DELAY_MS)
  }

  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  const delayMs = dateMs - now
  if (delayMs <= 0) return undefined
  return Math.min(delayMs, MAX_BACKOFF_DELAY_MS)
}

function getRetryAfterHeader(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as { responseHeaders?: unknown; headers?: unknown }
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
 * True when the error class is one that retrying (or another provider) can
 * plausibly fix: retryable HTTP statuses (408/429/5xx), or an unknown error
 * with no explicit client-error status. Content-policy refusals and explicit
 * non-retryable 4xx statuses (400/401/403/404/422, ...) are NOT — retrying or
 * escalating those is the blanket-escalation defect this gate replaces.
 */
function isRetryOrEscalationEligible(error: unknown): boolean {
  if (isProviderContentPolicyError(error)) return false
  const statusCode = getErrorStatusCode(error)
  if (statusCode === undefined) return true
  if (RETRYABLE_STATUS_CODES.has(statusCode)) return true
  return false
}

/** Attempts per fallback leg (initial try + one bounded retry). */
const MAX_ATTEMPTS_PER_LEG = 2
const BASE_BACKOFF_DELAY_MS = 500
const MAX_BACKOFF_DELAY_MS = 8_000

// Abort-aware default backoff sleep: rejects promptly with an AbortError
// when `signal` aborts during (or before) the wait, so an aborted request
// surfaces the abort instead of waiting out the full backoff window. The
// rejection is caught by the retry loop's `isAbortError` gate, which rethrows
// it without retrying or falling back.
const defaultSleep = async (
  ms: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) {
    throw new AbortError()
  }
  await new Promise<void>((resolve, reject) => {
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
      reject(new AbortError())
    }
    timeout = globalThis.setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const sleepFor = async (params: {
  error: unknown
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}): Promise<void> => {
  const header = getRetryAfterHeader(params.error)
  const retryAfterMs =
    header !== undefined ? parseRetryAfterMs({ header }) : undefined
  const delayMs =
    retryAfterMs ??
    Math.min(BASE_BACKOFF_DELAY_MS * 2, MAX_BACKOFF_DELAY_MS)
  await params.sleep(delayMs, params.signal)
}

/**
 * One ordered leg of the documented fallback chain. `kind` names the leg so
 * routing is observable in tests/telemetry; `model` is the model string the
 * leg dispatches with.
 */
export type FallbackLeg = {
  kind: 'primary' | 'vertex' | 'fallback'
  model: string
}

/**
 * Build the documented fallback chain for a Gemini flash request, oldest
 * first: the primary Gemini model, then the Vertex AI Gemini endpoint (when a
 * `vertexModel` is provided), then GPT-4o (when `useGPT4oInsteadOfClaude`) or
 * the costMode-routed Claude model. When `model` is omitted the primary leg
 * is skipped (fail-closed: no leg is dispatched without a model string).
 * Pure; exported for observability/tests.
 */
export function buildFallbackChain(params: {
  model: string | undefined
  costMode?: string
  useGPT4oInsteadOfClaude?: boolean
  vertexModel?: string
}): FallbackLeg[] {
  const chain: FallbackLeg[] = []
  if (params.model !== undefined) {
    chain.push({ kind: 'primary', model: params.model })
  }
  if (params.vertexModel) {
    chain.push({ kind: 'vertex', model: params.vertexModel })
  }
  const fallbackModel = params.useGPT4oInsteadOfClaude
    ? openaiModels.gpt4o
    : params.costMode === 'max'
      ? openrouterModels.openrouter_claude_sonnet_4_5
      : openrouterModels.openrouter_claude_3_5_haiku
  chain.push({ kind: 'fallback', model: fallbackModel })
  return chain
}


/**
 * Prompts a Gemini model with fallback logic.
 *
 * The documented fallback chain is: the specified Gemini model via the
 * standard Gemini API, then (when `vertexModel` is provided) the Vertex AI
 * Gemini endpoint, then GPT-4o (if `useGPT4oInsteadOfClaude` is true) or a
 * Claude model (Sonnet for 'max' costMode, Haiku otherwise).
 *
 * Escalation is error-class gated (M3-T4): content-policy refusals and other
 * 4xx-class client errors fail fast — no retry and no escalation to another
 * provider, because retrying cannot fix them. Retryable/transient errors
 * (408/429/5xx, network blips) are retried within the leg with bounded
 * exponential backoff, honoring a valid `Retry-After` header (missing or
 * invalid headers fail closed to the default backoff) before the leg
 * escalates to the next one.
 *
 * This function handles non-streaming requests and returns the complete
 * response string.
 *
 * @param messages - The array of messages forming the conversation history.
 * @param system - An optional system prompt string or array of text blocks.
 * @param options - Configuration options for the API call.
 * @param options.clientSessionId - Unique ID for the client session.
 * @param options.fingerprintId - Unique ID for the user's device/fingerprint.
 * @param options.userInputId - Unique ID for the specific user input triggering this call.
 * @param options.model - The primary Gemini model to attempt.
 * @param options.userId - The ID of the user making the request.
 * @param options.maxTokens - Optional maximum number of tokens for the response.
 * @param options.temperature - Optional temperature setting for generation (0-1).
 * @param options.costMode - Optional cost mode ('free', 'normal', 'max') influencing fallback model choice.
 * @param options.useGPT4oInsteadOfClaude - Optional flag to use GPT-4o instead of Claude as the final fallback.
 * @param options.vertexModel - Optional Vertex AI Gemini endpoint model to
 *   attempt after the primary Gemini leg fails (the documented second leg).
 * @param options.sleep - Injectable delay fn for retry backoff (tests must
 *   not really sleep). The default sleep is abort-aware: it rejects promptly
 *   with an AbortError when the caller's signal aborts during the wait, so an
 *   aborted request never waits out the full backoff window.
 * @returns A promise that resolves to the complete response string from the successful API call.
 * @throws {Error} If all API calls (primary and fallbacks) fail.
 * @throws {Error} When the request is aborted by user. Check with `isAbortError()`. Aborts are not retried.
 */
export async function promptFlashWithFallbacks(
  params: {
    messages: Message[]
    costMode?: string
    useGPT4oInsteadOfClaude?: boolean
    thinkingBudget?: number
    useFinetunedModel?: FinetunedVertexModel | undefined
    vertexModel?: string | undefined
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    promptAiSdk: PromptAiSdkFn
    logger: Logger
  } & ParamsExcluding<PromptAiSdkFn, 'messages'>,
): Promise<string> {
  const {
    messages,
    costMode,
    useGPT4oInsteadOfClaude,
    useFinetunedModel,
    vertexModel,
    sleep = defaultSleep,
    promptAiSdk,
    logger,
    signal,
  } = params

  // Try finetuned model first if enabled. Same attempt budget as the
  // documented fallback legs below (MAX_ATTEMPTS_PER_LEG): a transient
  // 503/429 on the finetuned endpoint retries once with backoff before
  // escalating (reliability finding finetuned-leg-no-retry-budget).
  if (useFinetunedModel) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_LEG; attempt++) {
      // Loop-level abort gate (reliability finding
      // finetuned-leg-missing-abort-gate): once an abort has been observed —
      // including one that landed during a previous failed attempt or during
      // backoff with an injected sleep that is not itself abort-aware — no
      // further attempt is dispatched, neither a retry here nor an escalation
      // to the fallback chain below.
      if (signal?.aborted) {
        throw new AbortError()
      }
      try {
        return unwrapPromptResult(
          await promptAiSdk({
            ...params,
            messages,
            model: useFinetunedModel,
          }),
        )
      } catch (error) {
        // Don't fall back on user-initiated aborts - propagate immediately
        if (isAbortError(error)) {
          throw error
        }
        // Abort gate (reliability finding finetuned-leg-missing-abort-gate):
        // an abort observed during this failed attempt must not escalate to
        // the fallback chain — surface the abort instead, mirroring the
        // loop-level gate the fallback-chain legs have.
        if (signal?.aborted) {
          throw new AbortError()
        }
        // Error-class gate (M3-T4): the finetuned leg is part of the same
        // documented fallback chain, so content-policy refusals and other
        // non-retryable 4xx-class client errors fail fast here too — no retry
        // and no escalation to the Gemini/Claude fallback legs.
        if (!isRetryOrEscalationEligible(error)) {
          logger.warn(
            { error, leg: 'finetuned', model: useFinetunedModel },
            'Non-retryable finetuned model error; failing without escalation',
          )
          throw error
        }
        if (attempt < MAX_ATTEMPTS_PER_LEG - 1) {
          logger.warn(
            { error, leg: 'finetuned', model: useFinetunedModel, attempt: attempt + 1 },
            'Retryable finetuned model error; retrying with backoff',
          )
          await sleepFor({ error, sleep, signal })
          continue
        }
        logger.warn(
          { error },
          'Error calling finetuned model, falling back to Gemini API',
        )
      }
    }
  }

  const chain = buildFallbackChain({
    model: params.model,
    costMode,
    useGPT4oInsteadOfClaude,
    vertexModel,
  })

  let lastError: unknown
  // Records the most recent successful response so it can never be discarded
  // by the trailing `throw lastError` (reliability finding
  // gemini-fallback-success-swallowed-by-loop): if a later attempt in the
  // same leg or a subsequent leg throws after a success was already
  // obtained, the recorded success is returned instead.
  let success: string | undefined
  for (let legIndex = 0; legIndex < chain.length; legIndex++) {
    const leg = chain[legIndex]
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_LEG; attempt++) {
      // Loop-level abort gate (reliability finding
      // gemini-chain-legs-missing-post-backoff-abort-gate): once an abort has
      // been observed — including one that landed during a previous failed
      // attempt or during backoff with an injected sleep that is not itself
      // abort-aware — no further attempt is dispatched, neither a retry here
      // nor an escalation to the next leg.
      if (signal?.aborted) {
        throw new AbortError()
      }
      try {
        success = unwrapPromptResult(
          await promptAiSdk({ ...params, messages, model: leg.model }),
        )
        return success
      } catch (error) {
        // Don't fall back on user-initiated aborts - propagate immediately
        if (isAbortError(error)) {
          throw error
        }
        // Abort-aware backoff gate (reliability finding
        // gemini-backoff-sleep-ignores-abort): if the caller's signal aborted
        // during (or before) the failed attempt, surface the abort instead of
        // retrying or falling back — even when an injected sleep is not
        // itself abort-aware. No further attempt is dispatched after an
        // observed abort.
        if (signal?.aborted) {
          throw new AbortError()
        }
        lastError = error

        // Error-class gate: content-policy/4xx-class errors cannot be fixed
        // by retrying — fail fast instead of escalating (M3-T4).
        if (!isRetryOrEscalationEligible(error)) {
          logger.warn(
            { error, leg: leg.kind, model: leg.model },
            `Non-retryable ${leg.kind} model error; failing without escalation`,
          )
          throw error
        }

        if (attempt < MAX_ATTEMPTS_PER_LEG - 1) {
          logger.warn(
            { error, leg: leg.kind, model: leg.model, attempt: attempt + 1 },
            `Retryable ${leg.kind} model error; retrying with backoff`,
          )
          await sleepFor({ error, sleep, signal })
          continue
        }

        const nextLeg = chain[legIndex + 1]
        if (nextLeg) {
          logger.warn(
            { error, leg: leg.kind, model: leg.model },
            `Error calling ${leg.kind} model, falling back to ${nextLeg.kind}`,
          )
        }
      }
    }
  }

  // A response obtained earlier in the loop must win over the last recorded
  // error (reliability finding gemini-fallback-success-swallowed-by-loop):
  // never discard a successful response just because a later attempt threw.
  if (success !== undefined) return success
  throw lastError
}
