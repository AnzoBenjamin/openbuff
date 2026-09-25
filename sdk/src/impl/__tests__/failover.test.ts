import { NoOutputGeneratedError } from 'ai'
import {
  createAuthError,
  createForbiddenError,
  createHttpError,
  createNetworkError,
  createProviderContentPolicyError,
  createServerError,
  normalizeProviderContentPolicyError,
} from '../../error-utils'
import {
  FAILOVER_ELIGIBLE_STATUS_CODES,
  isFailoverEligibleError,
  resolveModelsToTry,
} from '../failover'
import type { LoadedProviderConfig } from '../../provider-config'

import { describe, expect, it } from 'bun:test'

/**
 * Minimal LoadedProviderConfig fixture builder for failover tests. Only the
 * `config.failoverModels` field is read by the helpers, so the rest is filled
 * with the empty-config shape to satisfy the type.
 */
function makeLoadedConfig(
  failoverModels?: string[],
): LoadedProviderConfig | undefined {
  if (failoverModels === undefined) return undefined
  return {
    config: {
      providers: {},
      defaultModel: undefined,
      defaultReasoningEffort: undefined,
      modes: {},
      modeReasoningEfforts: {},
      agents: {},
      agentReasoningEfforts: {},
      indexing: {
        enabled: true,
        cacheDir: '.codebuff-index',
        exclude: [],
        semantic: { enabled: false, model: undefined },
      },
      fileChangeHooks: [],
      readableRoots: [],
      failoverModels,
    },
    sourceFilePaths: [],
  }
}

describe('resolveModelsToTry', () => {
  it('returns only the primary when no config is provided', () => {
    expect(resolveModelsToTry('openai/gpt-5.5', undefined)).toEqual([
      'openai/gpt-5.5',
    ])
  })

  it('returns only the primary when config has no failoverModels', () => {
    const config = makeLoadedConfig([])
    expect(resolveModelsToTry('openai/gpt-5.5', config)).toEqual([
      'openai/gpt-5.5',
    ])
  })

  it('prepends the primary and appends configured failover models in order', () => {
    const config = makeLoadedConfig([
      'anthropic/claude-sonnet-4-5',
      'openrouter/anthropic/claude-sonnet-4-5',
    ])
    expect(resolveModelsToTry('openai/gpt-5.5', config)).toEqual([
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4-5',
      'openrouter/anthropic/claude-sonnet-4-5',
    ])
  })

  it('dedupes a failover model that repeats the primary', () => {
    const config = makeLoadedConfig([
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4-5',
    ])
    expect(resolveModelsToTry('openai/gpt-5.5', config)).toEqual([
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4-5',
    ])
  })

  it('returns an empty array when the primary is undefined and no failovers are configured', () => {
    expect(resolveModelsToTry(undefined, undefined)).toEqual([])
  })

  it('returns only failover models when the primary is undefined', () => {
    const config = makeLoadedConfig(['anthropic/claude-sonnet-4-5'])
    expect(resolveModelsToTry(undefined, config)).toEqual([
      'anthropic/claude-sonnet-4-5',
    ])
  })

  it('dedupes duplicates within the failover list (preserves first-seen order)', () => {
    const config = makeLoadedConfig([
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-sonnet-4-5',
    ])
    expect(resolveModelsToTry('openai/gpt-5.5', config)).toEqual([
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4-5',
    ])
  })

  it('dedupes duplicate backups while preserving order of first occurrences', () => {
    const config = makeLoadedConfig([
      'anthropic/claude-sonnet-4-5',
      'openrouter/anthropic/claude-sonnet-4-5',
      'anthropic/claude-sonnet-4-5',
      'openrouter/anthropic/claude-sonnet-4-5',
    ])
    expect(resolveModelsToTry('openai/gpt-5.5', config)).toEqual([
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4-5',
      'openrouter/anthropic/claude-sonnet-4-5',
    ])
  })
})

describe('FAILOVER_ELIGIBLE_STATUS_CODES', () => {
  it('contains auth codes 401 and 403', () => {
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(401)).toBe(true)
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(403)).toBe(true)
  })

  it('contains 5xx server codes 500/502/503/504', () => {
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(500)).toBe(true)
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(502)).toBe(true)
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(503)).toBe(true)
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(504)).toBe(true)
  })

  it('does NOT contain 408 (timeout) or 429 (rate limit) — retry-only', () => {
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(408)).toBe(false)
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(429)).toBe(false)
  })

  it('does NOT contain 400/404/422 (client errors)', () => {
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(400)).toBe(false)
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(404)).toBe(false)
    expect(FAILOVER_ELIGIBLE_STATUS_CODES.has(422)).toBe(false)
  })
})

describe('isFailoverEligibleError', () => {
  it('returns true for 401 auth errors', () => {
    expect(isFailoverEligibleError(createAuthError())).toBe(true)
  })

  it('returns true for 403 forbidden errors', () => {
    expect(isFailoverEligibleError(createForbiddenError())).toBe(true)
  })

  it('returns true for 500 server errors', () => {
    expect(isFailoverEligibleError(createServerError())).toBe(true)
  })

  it('returns false for a content-policy error that preserved a 503 status (M3-T4 contract)', () => {
    // A provider 503 whose body mentions content policy normalizes to a
    // ProviderContentPolicyError carrying the original statusCode; the
    // deterministic refusal must fail fast, never fail over (reliability
    // finding content-policy-status-preserved-through-normalization).
    const raw = new Error('content policy blocked') as Error & {
      statusCode: number
    }
    raw.statusCode = 503
    const normalized = normalizeProviderContentPolicyError(raw)
    expect(normalized).toBeDefined()
    expect(isFailoverEligibleError(normalized)).toBe(false)
  })

  it('returns true for 502 bad gateway', () => {
    expect(isFailoverEligibleError(createHttpError('bad gateway', 502))).toBe(
      true,
    )
  })

  it('returns true for 503 service unavailable (createNetworkError default)', () => {
    expect(isFailoverEligibleError(createNetworkError())).toBe(true)
  })

  it('returns true for 504 gateway timeout', () => {
    expect(
      isFailoverEligibleError(createHttpError('gateway timeout', 504)),
    ).toBe(true)
  })

  it('returns false for an explicitly classified provider content-policy error (fail fast, per the documented contract)', () => {
    // M3-T4: content-policy refusals are deterministic — retrying the same
    // prompt against the next configured model is a contract violation and a
    // policy-evasion path, so they are NOT failover-eligible.
    expect(
      isFailoverEligibleError(
        createProviderContentPolicyError({ statusCode: 400 }),
      ),
    ).toBe(false)
  })

  it('returns false after normalizing an explicit HTTP 400 content-policy response (fail fast)', () => {
    const rawError = Object.assign(new Error('Bad Request'), {
      status: 400,
      responseBody: JSON.stringify({ error: 'content blocked by policy' }),
    })
    const normalized = normalizeProviderContentPolicyError(rawError)

    expect(normalized).toBeDefined()
    expect(isFailoverEligibleError(normalized)).toBe(false)
  })

  it('returns true for the AI SDK NoOutputGeneratedError (empty stream, clean close)', () => {
    // ai@5's DefaultStreamTextResult rejects `finishReason` with
    // NoOutputGeneratedError ("No output generated. Check the stream for
    // errors.") when the provider opens a stream, sends zero chunks (no text,
    // no tool call, no error chunk), and closes cleanly. The primary produced
    // nothing, so a backup model attempt is worthwhile; the failover loop's
    // anyContentYielded guard protects against duplicating output.
    expect(
      isFailoverEligibleError(
        new NoOutputGeneratedError({
          message: 'No output generated. Check the stream for errors.',
        }),
      ),
    ).toBe(true)
  })

  it('returns false for a plain Error sharing the NoOutputGeneratedError message (marker-based classification, not message matching)', () => {
    expect(
      isFailoverEligibleError(
        new Error('No output generated. Check the stream for errors.'),
      ),
    ).toBe(false)
  })

  it('still classifies by status alongside the empty-stream path: content-policy with a failover-eligible status stays NOT eligible, status-carrying errors classify by status', () => {
    // The empty-stream check sits after the content-policy early-return, so a
    // content-policy error carrying an otherwise failover-eligible status must
    // still fail fast, and a plain status-carrying error still classifies by
    // status (502 → eligible, 429 → retry-only).
    expect(
      isFailoverEligibleError(
        createProviderContentPolicyError({ statusCode: 503 }),
      ),
    ).toBe(false)
    expect(isFailoverEligibleError(createHttpError('bad gateway', 502))).toBe(
      true,
    )
    expect(isFailoverEligibleError(createHttpError('rate limited', 429))).toBe(
      false,
    )
  })

  it('returns false for 408 request timeout — retry-only, not failover-eligible', () => {
    expect(isFailoverEligibleError(createHttpError('timeout', 408))).toBe(false)
  })

  it('returns false for 429 rate limit — retry-only, not failover-eligible', () => {
    expect(isFailoverEligibleError(createHttpError('rate limited', 429))).toBe(
      false,
    )
  })

  it('returns false for 400 bad request', () => {
    expect(isFailoverEligibleError(createHttpError('bad request', 400))).toBe(
      false,
    )
  })

  it('returns false for 404 not found', () => {
    expect(isFailoverEligibleError(createHttpError('not found', 404))).toBe(
      false,
    )
  })

  it('returns false for 422 unprocessable entity', () => {
    expect(isFailoverEligibleError(createHttpError('unprocessable', 422))).toBe(
      false,
    )
  })

  it('returns false for a plain Error with no status code', () => {
    expect(isFailoverEligibleError(new Error('network blip'))).toBe(false)
  })

  it('returns false for a non-Error value', () => {
    expect(isFailoverEligibleError('something went wrong')).toBe(false)
    expect(isFailoverEligibleError(undefined)).toBe(false)
    expect(isFailoverEligibleError(null)).toBe(false)
    expect(isFailoverEligibleError({})).toBe(false)
  })

  it('reads the AI SDK APICallError convention (`status` property)', () => {
    const apiCallError = new Error('provider 500') as Error & {
      status: number
    }
    ;(apiCallError as { status: number }).status = 500
    expect(isFailoverEligibleError(apiCallError)).toBe(true)
  })

  it('reads the `statusCode` property (our convention)', () => {
    const error = new Error('auth') as Error & { statusCode: number }
    ;(error as { statusCode: number }).statusCode = 401
    expect(isFailoverEligibleError(error)).toBe(true)
  })

  it('prefers `statusCode` over `status` when both are present (statusCode checked first)', () => {
    const error = new Error('mixed') as Error & {
      statusCode: number
      status: number
    }
    ;(error as { statusCode: number }).statusCode = 401
    ;(error as { status: number }).status = 200
    expect(isFailoverEligibleError(error)).toBe(true)
  })

  it('returns false when statusCode is a non-number string', () => {
    const error = new Error('bad') as Error & { statusCode: unknown }
    ;(error as { statusCode: unknown }).statusCode = '500'
    expect(isFailoverEligibleError(error)).toBe(false)
  })
})
