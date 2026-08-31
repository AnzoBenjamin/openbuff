import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { models } from '@codebuff/common/old-constants'
import { buildArray } from '@codebuff/common/util/array'
import { normalizeProviderRequestBodyForCacheDebug } from '@codebuff/common/util/cache-debug'
import {
  getErrorObject,
  promptAborted,
  promptSuccess,
} from '@codebuff/common/util/error'
import { convertCbToModelMessages } from '@codebuff/common/util/messages'
import { isExplicitlyDefinedModel } from '@codebuff/common/util/model-utils'
import { StopSequenceHandler } from '@codebuff/common/util/stop-sequence'
import {
  asSchema,
  streamText,
  generateText,
  generateObject,
  NoSuchToolError,
  APICallError,
  ToolCallRepairError,
  InvalidToolInputError,
  TypeValidationError,
} from 'ai'

import {
  getModelForRequest,
  markChatGptOAuthRateLimited,
  resolveModelContextWindow,
} from './model-provider'
import { resolveModelsToTry, isFailoverEligibleError } from './failover'
import { buildSpawnAgentsInputForDirectAgentCall } from './direct-agent-tool-repair'
import {
  loadProviderConfigSync,
  resolveConfiguredAgentModelConfig,
} from '../provider-config'
import { refreshChatGptOAuthToken } from '../credentials'
import {
  getProviderContentPolicyFinishError,
  getErrorStatusCode,
  isRetryableStatusCode,
  normalizeProviderContentPolicyError,
} from '../error-utils'
import {
  MAX_RETRIES_PER_MESSAGE,
  RETRY_BACKOFF_BASE_DELAY_MS,
  computeBackoffDelayMs,
  waitForBackoffDelay,
} from '../retry-config'

import type { ModelRequestParams } from './model-provider'
import type { OpenRouterProviderRoutingOptions } from '@codebuff/common/types/agent-template'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredInput,
  PromptAiSdkStructuredOutput,
} from '@codebuff/common/types/contracts/llm'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { JSONObject } from '@codebuff/common/types/json'
import type { OpenRouterProviderOptions } from '@codebuff/internal/openrouter-ai-sdk'
import type { GenerateObjectResult, LanguageModel } from 'ai'
import type z from 'zod/v4'
import { trimMessagesToFitTokenLimit } from '@codebuff/agent-runtime/util/messages'
import { getModelContextMessageLimit } from '@codebuff/agent-runtime/util/context-pruning'
import { countTokensJson } from '@codebuff/agent-runtime/util/token-counter'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

// Provider routing documentation: https://openrouter.ai/docs/features/provider-routing
const providerOrder = {
  [models.openrouter_claude_sonnet_4]: [
    'Google',
    'Anthropic',
    'Amazon Bedrock',
  ],
  [models.openrouter_claude_sonnet_4_5]: [
    'Google',
    'Anthropic',
    'Amazon Bedrock',
  ],
  [models.openrouter_claude_opus_4]: ['Google', 'Anthropic'],
}

function isImageMediaType(mediaType: unknown): boolean {
  return (
    typeof mediaType === 'string' &&
    mediaType.toLowerCase().startsWith('image/')
  )
}

function valueContainsImageInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(valueContainsImageInput)
  }
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  if (record.type === 'image') {
    return true
  }
  if (
    (record.type === 'file' || record.type === 'media') &&
    isImageMediaType(record.mediaType)
  ) {
    return true
  }
  return valueContainsImageInput(record.content)
}

function calculateProviderCostCents(params: { costDollars: number }): number {
  const { costDollars } = params

  return Math.round(costDollars * 100)
}

/**
 * Configured per-million-token pricing for a model (from openbuff.json
 * `modelCapabilities.pricing`). Used to compute BYOK cost when the provider
 * does not return OpenRouter-style cost metadata.
 */
export interface ModelPricing {
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  cachedInputPerMillionTokens?: number
}

/**
 * Token usage reported by the AI SDK for a completed request.
 * `cachedInputTokens` is the cache-hit portion of `inputTokens` and is billed
 * at the (usually discounted) `cachedInputPerMillionTokens` rate when present.
 */
export interface UsageTokenCounts {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}

/**
 * Compute cost in cents for a BYOK request from token usage and the
 * configured `modelCapabilities.pricing` capability. Returns `undefined` when
 * pricing is unavailable or insufficient (no input/output rates) so callers
 * can fall back to provider-reported cost or skip cost tracking.
 *
 * `cachedInputTokens` is charged at `cachedInputPerMillionTokens` when that
 * rate is configured, otherwise at the regular `inputPerMillionTokens` rate.
 * Only non-negative token counts contribute; NaN/undefined contribute 0.
 */
export function computeCostCentsFromUsage(params: {
  usage: UsageTokenCounts
  pricing: ModelPricing | undefined
}): number | undefined {
  const { usage, pricing } = params
  if (!pricing) return undefined

  const inputRate = pricing.inputPerMillionTokens
  const outputRate = pricing.outputPerMillionTokens
  if (inputRate === undefined && outputRate === undefined) {
    return undefined
  }

  const safeNonNeg = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

  const rawInputTokens = safeNonNeg(usage.inputTokens)
  const cachedInputTokens = safeNonNeg(usage.cachedInputTokens)
  const chargeableInputTokens = Math.max(0, rawInputTokens - cachedInputTokens)
  const outputTokens = safeNonNeg(usage.outputTokens)

  const effectiveInputRate = inputRate !== undefined ? inputRate : 0
  const cachedInputRate =
    pricing.cachedInputPerMillionTokens !== undefined
      ? pricing.cachedInputPerMillionTokens
      : effectiveInputRate
  const effectiveOutputRate = outputRate !== undefined ? outputRate : 0

  const inputCostDollars =
    (chargeableInputTokens * effectiveInputRate +
      cachedInputTokens * cachedInputRate) /
    1_000_000
  const outputCostDollars = (outputTokens * effectiveOutputRate) / 1_000_000

  const totalCents = Math.round((inputCostDollars + outputCostDollars) * 100)
  return totalCents > 0 ? totalCents : 0
}

export function getProviderOptions(params: {
  model?: string
  runId: string
  clientSessionId: string
  providerOptions?: Record<string, JSONObject>
  agentProviderOptions?: OpenRouterProviderRoutingOptions
  n?: number
  costMode?: string
  cacheDebugCorrelation?: string
  extraCodebuffMetadata?: Record<string, string>
}): { openbuff: JSONObject } {
  const {
    model = '',
    runId,
    clientSessionId,
    providerOptions,
    agentProviderOptions,
    n,
    costMode,
    cacheDebugCorrelation,
    extraCodebuffMetadata,
  } = params

  let providerConfig: Record<string, any>

  // Use agent's provider options if provided, otherwise use defaults
  if (agentProviderOptions) {
    providerConfig = agentProviderOptions
  } else {
    // Set allow_fallbacks based on whether model is explicitly defined
    const isExplicitlyDefined = isExplicitlyDefinedModel(model)

    providerConfig = {
      order: providerOrder[model as keyof typeof providerOrder],
      allow_fallbacks: !isExplicitlyDefined,
    }
  }

  return {
    ...providerOptions,
    // Use openbuff key for provider metadata (formerly "codebuff").
    // Provider metadata is stripped by BYOK compatibility layers that don't
    // support it, so this is harmless for third-party providers.
    openbuff: {
      ...(providerOptions as any)?.codebuff,
      ...(providerOptions as any)?.openbuff,
      codebuff_metadata: {
        // Caller-supplied keys go first so they can't override reserved
        // identifiers like run_id/client_id/cost_mode that the server trusts.
        ...(extraCodebuffMetadata ?? {}),
        run_id: runId,
        client_id: clientSessionId,
        ...(n && { n }),
        ...(costMode && { cost_mode: costMode }),
        ...(cacheDebugCorrelation && {
          cache_debug_correlation: cacheDebugCorrelation,
        }),
      },
      provider: providerConfig,
    },
  }
}

// Provider usage accounting type for OpenRouter-compatible responses.
// Forked from https://github.com/OpenRouterTeam/ai-sdk-provider/
type OpenRouterUsageAccounting = {
  cost: number | null
  costDetails: {
    upstreamInferenceCost: number | null
  }
}

/**
 * Check if an error is an OAuth rate limit error that should trigger fallback.
 */
function isOAuthRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  // Check status code (handles both 'status' from AI SDK and 'statusCode' from our errors)
  const statusCode = getErrorStatusCode(error)
  if (statusCode === 429) return true

  // Check error message for rate limit indicators
  const err = error as {
    message?: string
    responseBody?: string
  }
  const message = (err.message || '').toLowerCase()
  const responseBody = (err.responseBody || '').toLowerCase()

  if (message.includes('rate_limit') || message.includes('rate limit'))
    return true
  if (
    responseBody.includes('rate_limit') ||
    responseBody.includes('rate limit')
  )
    return true

  return false
}

/**
 * Check if an error is an OAuth authentication error (expired/invalid token).
 * This indicates we should try refreshing the token.
 */
function isOAuthAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  // Check status code (handles both 'status' from AI SDK and 'statusCode' from our errors)
  const statusCode = getErrorStatusCode(error)
  if (statusCode === 401 || statusCode === 403) return true

  // Check error message for auth indicators
  const err = error as {
    message?: string
    responseBody?: string
  }
  const message = (err.message || '').toLowerCase()
  const responseBody = (err.responseBody || '').toLowerCase()

  if (message.includes('unauthorized') || message.includes('invalid_token'))
    return true
  if (message.includes('authentication') || message.includes('expired'))
    return true
  if (
    responseBody.includes('unauthorized') ||
    responseBody.includes('invalid_token')
  )
    return true
  if (
    responseBody.includes('authentication') ||
    responseBody.includes('expired')
  )
    return true

  return false
}

function getModelProvider(model: LanguageModel): string {
  if (typeof model === 'string') return model
  return model.provider
}

function emitCacheDebugProviderRequest(params: {
  callback?: (params: {
    provider: string
    rawBody: unknown
    normalizedBody?: unknown
  }) => void
  provider: string
  rawBody: unknown
}) {
  if (!params.callback) return

  const normalized = normalizeProviderRequestBodyForCacheDebug({
    provider: params.provider,
    body: params.rawBody,
  })

  params.callback({
    provider: params.provider,
    rawBody: params.rawBody,
    normalizedBody: normalized,
  })
}

function emitCacheDebugUsage(params: {
  callback?: (usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    totalTokens: number
  }) => void
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
  }
}) {
  if (!params.callback) return

  params.callback({
    inputTokens: params.usage.inputTokens ?? 0,
    outputTokens: params.usage.outputTokens ?? 0,
    cachedInputTokens: params.usage.cachedInputTokens ?? 0,
    totalTokens: params.usage.totalTokens ?? 0,
  })
}

const POST_STREAM_METADATA_TIMEOUT_MS = 500

/**
 * Depth cap for the JSON-safety probe below. Real JSON Schemas nest far
 * shallower than this, and the cap also bounds the walk on a self-referential
 * object instead of recursing forever.
 */
const MAX_TOOL_SCHEMA_PROBE_DEPTH = 12

/**
 * Floor for the per-tool reservation of an `inputSchema` that is a
 * validation-library schema instance (`tool({ inputSchema: z.object({...}) })`
 * — the canonical form the published `promptAiSdkStream`/`promptAiSdk` param
 * types accept) rather than a plain JSON Schema. Such objects are not JSON
 * data: they carry functions and self-references, so serializing them either
 * throws on a cycle or emits library internals whose size bears no relation to
 * the schema the provider actually receives. The schema is therefore converted
 * to a real JSON Schema and counted from that projection (see
 * {@link countOpaqueToolSchemaTokens}); this floor is what a tool reserves when
 * the conversion is impossible or yields something smaller, so a failed
 * conversion never reserves less than the previous flat estimate did.
 */
const OPAQUE_TOOL_SCHEMA_FALLBACK_TOKENS = 120

/**
 * Per-tool ceiling on the converted schema count above. Counting the real JSON
 * Schema keeps a large tool surface from being materially under-reserved, but
 * `getMessagesForModelContext` subtracts this overhead from the message budget
 * one-for-one, so a single absurd schema must not be able to collapse that
 * budget to nothing.
 */
const MAX_COUNTED_TOOL_SCHEMA_TOKENS = 8_000

/**
 * True when `value` is plain JSON data that `JSON.stringify` reproduces
 * faithfully: primitives, arrays, and plain objects only. Class instances
 * (Zod and other Standard Schema objects), functions, and anything nested
 * deeper than {@link MAX_TOOL_SCHEMA_PROBE_DEPTH} — which includes every
 * self-referential structure — are rejected.
 */
function isJsonData(value: unknown, depth = 0): boolean {
  if (value === null) return true
  const valueType = typeof value
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean'
  ) {
    return true
  }
  if (valueType !== 'object') return false
  if (depth >= MAX_TOOL_SCHEMA_PROBE_DEPTH) return false
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonData(entry, depth + 1))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value as Record<string, unknown>).every(
    (entry) => entry === undefined || isJsonData(entry, depth + 1),
  )
}

/**
 * The plain JSON Schema for a tool's `inputSchema` when one is directly
 * available — either the AI-SDK `jsonSchema()` wrapper's own `jsonSchema`
 * property or a bare JSON Schema object. Returns `undefined` for an opaque
 * validation-library schema, which is then estimated rather than serialized.
 */
function getPlainToolInputSchema(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== 'object') return undefined
  const record = inputSchema as Record<string, unknown>
  if (isJsonData(record.jsonSchema)) return record.jsonSchema
  if (isJsonData(record)) return record
  return undefined
}

/**
 * Size-aware token reservation for a tool whose `inputSchema` is an opaque
 * validation-library schema instance. The instance itself is never
 * `JSON.stringify`-ed: it is converted to a real JSON Schema with the AI SDK's
 * `asSchema` helper, validated with {@link isJsonData}, counted from that
 * projection, and clamped into
 * `[OPAQUE_TOOL_SCHEMA_FALLBACK_TOKENS, MAX_COUNTED_TOOL_SCHEMA_TOKENS]`.
 *
 * Conversion is best-effort and can never propagate a failure out of
 * {@link countRequestOverheadTokens}: a non-schema or self-referential object
 * makes `asSchema` (or reading its `jsonSchema` property) throw, and any result
 * that is not plain JSON data — a `Promise`, a wrapper, an absent property — is
 * treated as a failed conversion. Both cases fall back to the floor instead of
 * charging library internals against the message budget.
 */
function countOpaqueToolSchemaTokens(inputSchema: unknown): number {
  let counted = 0
  try {
    const { jsonSchema } = asSchema(
      inputSchema as Parameters<typeof asSchema>[0],
    ) as { jsonSchema?: unknown }
    if (isJsonData(jsonSchema)) {
      // `isJsonData` returns a plain boolean rather than a type predicate, so
      // narrow explicitly. It has already proven this is JSON data, and only a
      // non-null object or primitive reaches `countTokensJson`.
      counted = countTokensJson(jsonSchema as string | object)
    }
  } catch {
    // Any conversion failure (non-schema input, cycle, throwing getter) leaves
    // `counted` at 0 so the clamp below reserves the flat floor.
  }
  return Math.max(
    OPAQUE_TOOL_SCHEMA_FALLBACK_TOKENS,
    Math.min(MAX_COUNTED_TOOL_SCHEMA_TOKENS, counted),
  )
}

/**
 * Token cost of the tool surface of a request, counted from a JSON-safe
 * projection of the caller-supplied `tools` rather than from the object
 * itself. The projection mirrors the Anthropic-shaped `toolsForTokenCount`
 * list the runtime counts for pruning, so both budgets measure the same
 * surface.
 */
function countToolSurfaceTokens(tools: unknown): number {
  if (!tools || typeof tools !== 'object') return 0

  let total = 0
  for (const [name, tool] of Object.entries(tools as Record<string, unknown>)) {
    const definition =
      tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : {}
    const description =
      typeof definition.description === 'string'
        ? definition.description
        : undefined
    const inputSchema = getPlainToolInputSchema(definition.inputSchema)

    total += countTokensJson({
      name,
      ...(description !== undefined && { description }),
      ...(inputSchema !== undefined && { input_schema: inputSchema }),
    })
    if (inputSchema === undefined && definition.inputSchema !== undefined) {
      total += countOpaqueToolSchemaTokens(definition.inputSchema)
    }
  }
  return total
}

/**
 * Token cost of the non-message request surface (system prompt + tool schemas)
 * that the request-time trim must subtract from the model's message budget so
 * the SDK brake reserves the same kind of overhead the runtime's
 * `maybePruneContext` reserves. The two numbers are not required to be equal:
 * this count is derived from the request's own tool objects (see the
 * compatibility contract below), not from the runtime's serialized tool
 * definitions, so for the same model the two projections can diverge.
 *
 * Compatibility contract for the exported request paths: the caller-supplied
 * `tools` object is never serialized directly, because the published param
 * types accept AI-SDK tools whose `inputSchema` is a Zod (or other Standard
 * Schema) instance. Counting those by `JSON.stringify` would throw on a
 * self-reference and, when it did not throw, would charge library internals
 * against the message budget and collapse it. Names, descriptions, and plain
 * JSON Schemas are counted exactly; an opaque schema instance is instead
 * converted to a real JSON Schema with the AI SDK's `asSchema` helper and
 * counted from that projection, clamped into
 * `[OPAQUE_TOOL_SCHEMA_FALLBACK_TOKENS, MAX_COUNTED_TOOL_SCHEMA_TOKENS]` so the
 * reservation is size-aware without being pathological. That conversion never
 * throws out of this function: a non-schema or self-referential `inputSchema`
 * falls back to the floor. Absent fields count 0 rather than counting
 * `undefined` — a tool with no `inputSchema` at all reserves nothing for a
 * schema — and `includeTools` is false when the provider-compatibility layer
 * strips tools from the request.
 */
export function countRequestOverheadTokens(params: {
  system?: unknown
  tools?: unknown
  includeTools: boolean
}): number {
  const { system } = params
  const systemTokens =
    typeof system === 'string'
      ? countTokensJson(system)
      : typeof system === 'object' && system !== null && isJsonData(system)
        ? countTokensJson(system)
        : 0

  return (
    systemTokens +
    (params.includeTools ? countToolSurfaceTokens(params.tools) : 0)
  )
}

/**
 * Request-time emergency-brake trim (M4.3, SPEC R4/AC4).
 *
 * The resolved message limit comes from `getModelContextMessageLimit` applied
 * to the active model's context window (falling back to the flat
 * `DEFAULT_MAX_CONTEXT_TOKENS` when the window is unknown). `systemTokens` —
 * the token cost of the system prompt plus the tool schemas actually sent with
 * the request — is subtracted from that limit, so the effective message budget
 * reserves request overhead the way the runtime's `maybePruneContext` does.
 * The two budgets are parallel brakes, not mirrored ones: each side counts its
 * own projection of the tool surface, and the runtime's limit may additionally
 * be capped by a provider `maxContextLength`, so the resulting message budgets
 * can differ substantially for the same model. Omitting `systemTokens` (or
 * passing 0) reproduces the previous, more permissive behavior in which the
 * whole message limit was available to messages alone.
 *
 * This is the *last line of defense*: the runtime `maybePruneContext` and the
 * LLM-based context-pruner agent are expected to keep the conversation under
 * the unified threshold in steady state. When this function actually has to
 * drop messages, it emits a `CACHE_EMERGENCY_TRIM` telemetry event so any
 * threshold regression is directly observable. That payload separates the two
 * budgets explicitly: `maxTotalTokens` is the resolved request budget,
 * `systemTokens` the counted overhead, and `effectiveMessageBudgetTokens` the
 * message-only budget actually applied. `triggerBudgetTokens`/
 * `targetBudgetTokens` report that same message-only budget, because they are
 * the fields consumers compare against message token counts.
 */
export function getMessagesForModelContext(params: {
  messages: Message[]
  contextWindowTokens?: number
  maxTotalTokensOverride?: number
  /**
   * Tokens consumed by the system prompt + tool schemas of this request.
   * Subtracted from the resolved message limit; defaults to 0.
   */
  systemTokens?: number
  logger: ParamsOf<PromptAiSdkStreamFn>['logger']
  trackEvent?: ParamsOf<PromptAiSdkStreamFn>['trackEvent']
  userId?: string
  userInputId?: string
  model?: string
}): Message[] {
  const resolvedMessageLimit = getModelContextMessageLimit(
    params.contextWindowTokens,
  )
  const maxTotalTokens =
    params.maxTotalTokensOverride === undefined
      ? resolvedMessageLimit
      : Math.max(
          1,
          Math.min(
            resolvedMessageLimit,
            Math.floor(params.maxTotalTokensOverride),
          ),
        )
  // Same numeric sanitation as maxTotalTokensOverride above (non-finite or
  // negative coerces to 0, value is floored), plus a floor on the resulting
  // message budget: trimMessagesToFitTokenLimit derives
  // `maxMessageTokens = maxTotalTokens - systemTokens`, so an oversized system
  // surface must not yield a zero/negative budget.
  const requestedSystemTokens =
    params.systemTokens === undefined ||
    !Number.isFinite(params.systemTokens) ||
    params.systemTokens < 0
      ? 0
      : Math.floor(params.systemTokens)
  const systemTokens = Math.min(
    requestedSystemTokens,
    Math.max(0, maxTotalTokens - 1),
  )
  const effectiveMessageBudgetTokens = maxTotalTokens - systemTokens
  const trimmed = trimMessagesToFitTokenLimit({
    messages: params.messages,
    systemTokens,
    maxTotalTokens,
    logger: params.logger,
  })

  // Emergency-brake telemetry: only emit when the request-time trim actually
  // dropped messages (trimMessagesToFitTokenLimit returns the same ref when
  // under the limit). A non-zero count here means the unified threshold was
  // exceeded downstream and the SDK fallback caught it.
  if (trimmed !== params.messages) {
    const inputTokens = countTokensJson(params.messages)
    const outputTokens = countTokensJson(trimmed)
    const telemetryProperties = {
      contextWindowTokens: params.contextWindowTokens,
      // `maxTotalTokens` keeps its existing meaning (the resolved request
      // budget). The message-only budget after subtracting the system + tool
      // surface is reported separately so neither field is ambiguous.
      maxTotalTokens,
      systemTokens,
      effectiveMessageBudgetTokens,
      // `triggerBudgetTokens`/`targetBudgetTokens` are the pair consumers
      // compare against message token counts, so they report the threshold
      // actually applied to messages — the message-only budget — rather than
      // the pre-subtraction request budget. With no system surface (or
      // `systemTokens: 0`) both still equal `maxTotalTokens`, so the previous
      // values are unchanged for callers that pass no overhead.
      triggerBudgetTokens: effectiveMessageBudgetTokens,
      targetBudgetTokens: effectiveMessageBudgetTokens,
      reason:
        'Messages exceeded the provider-safe request budget at dispatch time.',
      inputTokens,
      outputTokens,
      tokensDropped: Math.max(0, inputTokens - outputTokens),
      inputMessageCount: params.messages.length,
      outputMessageCount: trimmed.length,
      userInputId: params.userInputId,
      model: params.model,
    }

    params.logger.warn(
      {
        eventId: AnalyticsEvent.CACHE_EMERGENCY_TRIM,
        ...telemetryProperties,
      },
      'Emergency request-time context trim fired (cache_emergency_trim). ' +
        `Resolved window=${params.contextWindowTokens ?? 'unknown'}, ` +
        `trigger=${effectiveMessageBudgetTokens}, target=${effectiveMessageBudgetTokens}, ` +
        `systemTokens=${systemTokens}, ` +
        `messageBudget=${effectiveMessageBudgetTokens}. ` +
        'This indicates the provider-safe request budget was exceeded before ' +
        'the SDK fallback; expected ~0 in steady state.',
    )

    params.trackEvent?.({
      event: AnalyticsEvent.CACHE_EMERGENCY_TRIM,
      userId: params.userId ?? '',
      properties: telemetryProperties,
      logger: params.logger,
    })
  }

  return trimmed
}

export function getProviderContextLimitFromError(
  error: unknown,
): number | undefined {
  const texts: string[] = []
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 5 || value == null) return
    if (typeof value === 'string') {
      texts.push(value)
      return
    }
    if (value instanceof Error) texts.push(value.message)
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    for (const key of ['message', 'responseBody', 'body', 'cause']) {
      if (key in record) visit(record[key], depth + 1)
    }
  }
  visit(error)
  const text = texts.join('\n')
  const patterns = [
    /tokens?\s*>\s*([\d,]+)\s+maximum/i,
    /maximum context length(?:\s+is|:)\s*([\d,]+)\s*tokens?/i,
    /context(?:_|\s)length(?:\s+is|:)\s*([\d,]+)\s*tokens?/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const parsed = match?.[1]
      ? Number.parseInt(match[1].replace(/,/g, ''), 10)
      : Number.NaN
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

async function awaitOptionalPostStreamMetadata<T>(params: {
  promise: PromiseLike<T>
  label: string
  logger: ParamsOf<PromptAiSdkStreamFn>['logger']
  timeoutMs?: number
}): Promise<T | undefined> {
  const {
    promise,
    label,
    logger,
    timeoutMs = POST_STREAM_METADATA_TIMEOUT_MS,
  } = params

  let timeout: number | undefined
  const guardedPromise = Promise.resolve(promise).catch((error) => {
    logger.warn(
      { error: getErrorObject(error) },
      `Ignoring ${label} error after stream completed`,
    )
    return undefined
  })
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = globalThis.setTimeout(resolve, timeoutMs)
  })

  const value = await Promise.race([guardedPromise, timeoutPromise])
  if (timeout) globalThis.clearTimeout(timeout)
  if (value === undefined) {
    logger.debug(
      { timeoutMs },
      `Skipping ${label}; provider did not settle it after stream completion`,
    )
  }
  return value
}

export type ChatGptOAuthStreamErrorPolicy =
  | 'fallback-rate-limit'
  | 'fail-auth-reconnect'
  | 'fail-fast'
  | 'ignore'

function withConfiguredReasoningEffort(
  providerOptions: Record<string, JSONObject> | undefined,
  reasoningEffort: string | undefined,
): Record<string, JSONObject> | undefined {
  if (!reasoningEffort) return providerOptions

  return {
    ...(providerOptions ?? {}),
    openaiCompatible: {
      ...((providerOptions?.openaiCompatible as JSONObject | undefined) ?? {}),
      reasoningEffort,
    },
    openai: {
      ...((providerOptions?.openai as JSONObject | undefined) ?? {}),
      reasoningEffort,
    },
  }
}

function hasProviderOptions(
  providerOptions: Record<string, JSONObject> | undefined,
): providerOptions is Record<string, JSONObject> {
  return Object.keys(providerOptions ?? {}).length > 0
}

export function classifyChatGptOAuthStreamError(params: {
  isChatGptOAuth: boolean
  skipChatGptOAuth?: boolean
  hasYieldedContent: boolean
  error: unknown
}): ChatGptOAuthStreamErrorPolicy {
  const { isChatGptOAuth, skipChatGptOAuth, hasYieldedContent, error } = params

  if (!isChatGptOAuth || skipChatGptOAuth || hasYieldedContent) {
    return 'ignore'
  }

  if (isOAuthRateLimitError(error)) {
    return 'fallback-rate-limit'
  }

  if (isOAuthAuthError(error)) {
    return 'fail-auth-reconnect'
  }

  return 'fail-fast'
}

/**
 * Check if an error is a transient network error that should be retried.
 * Handles socket disconnections, connection resets, timeouts, and other
 * temporary network failures that can occur during LLM streaming.
 */
function isTransientNetworkError(error: unknown): boolean {
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

export async function* promptAiSdkStream(
  params: ParamsOf<PromptAiSdkStreamFn> & {
    skipChatGptOAuth?: boolean
    chatGptOAuthRetried?: boolean
  },
): ReturnType<PromptAiSdkStreamFn> {
  const { providerOptions: originalProviderOptions, ...streamParams } = params

  const {
    logger,
    trackEvent,
    userId,
    userInputId,
    model: requestedModel,
  } = params
  const agentChunkMetadata =
    params.agentId != null ? { agentId: params.agentId } : undefined

  if (params.signal.aborted) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
      },
      'Skipping stream due to canceled user input',
    )
    return promptAborted('User cancelled input')
  }

  // Track if we've yielded ANY content to the caller across ALL retry attempts.
  // If content was yielded, we cannot safely retry without duplicating output.
  let anyContentYielded = false
  let lastError: unknown
  const emitProviderStatus = (chunk: {
    status: 'retrying' | 'failover' | 'recovered'
    model?: string
    nextModel?: string
    attempt?: number
    maxAttempts?: number
    delayMs?: number
    statusCode?: number
  }) => {
    params.sendAction({
      action: {
        type: 'response-chunk',
        userInputId,
        chunk: { type: 'provider_status', ...chunk },
      },
    })
  }

  const loadedConfig = loadProviderConfigSync()
  // When the caller's `model` is undefined (e.g. bundled agents whose model
  // is intentionally deferred to openbuff.json routing), resolve the effective
  // primary model from the agentId now so the failover loop below has at least
  // one model to try. Without this, resolveModelsToTry(undefined, ...) returns
  // [] and the loop never executes, leaving lastError as undefined and
  // surfacing as "Agent run error: undefined" at the post-loop `throw lastError`.
  // getModelForRequest performs the same resolution inside the loop, but only
  // after resolveModelsToTry gates entry — so we must resolve up front.
  const effectiveRequestedModel =
    params.model ||
    (params.agentId
      ? resolveConfiguredAgentModelConfig({
          agentId: params.agentId,
          loadedConfig,
        }).model
      : undefined)
  const modelsToTry = resolveModelsToTry(effectiveRequestedModel, loadedConfig)
  const routeContextWindowTokens = resolveModelContextWindow({
    agentId: params.agentId,
    model: effectiveRequestedModel,
  })
  params.onModelContextResolved?.(routeContextWindowTokens)

  for (
    let failoverIndex = 0;
    failoverIndex < modelsToTry.length;
    failoverIndex++
  ) {
    const failoverModel = modelsToTry[failoverIndex]
    let promptTooLongRetried = false
    let providerMessageLimitOverride: number | undefined
    try {
      for (let attempt = 0; attempt <= MAX_RETRIES_PER_MESSAGE; attempt++) {
        // Track if we've yielded content in THIS attempt (for ChatGPT OAuth fallback)
        let hasYieldedContent = false
        let response: ReturnType<typeof streamText>
        let aiSDKModel: LanguageModel
        let isChatGptOAuth: boolean
        let compatibility: {
          supportsTools: boolean
          stripProviderMetadata: boolean
          stripCacheControl: boolean
        }

        try {
          const modelParams: ModelRequestParams = {
            apiKey: params.apiKey,
            model: failoverModel,
            agentId: params.agentId,
            skipChatGptOAuth: params.skipChatGptOAuth,
            costMode: params.costMode,
            requiresVision: valueContainsImageInput(params.messages),
            // Failover attempts (failoverIndex > 0) must honor the explicit
            // failoverModel over openbuff.json mode/agent/defaultModel routing;
            // otherwise every backup model would silently re-resolve to the same
            // primary and failover would be a no-op (M8.1).
            preferModelParam: failoverIndex > 0,
          }
          const modelResult = await getModelForRequest(modelParams)
          aiSDKModel = modelResult.model
          isChatGptOAuth = modelResult.isChatGptOAuth
          compatibility = modelResult.compatibility
          const {
            reasoningEffort,
            effectiveModel,
            contextWindowTokens,
            pricing,
          } = modelResult
          const safeContextWindowTokens =
            routeContextWindowTokens === undefined
              ? contextWindowTokens
              : contextWindowTokens === undefined
                ? routeContextWindowTokens
                : Math.min(routeContextWindowTokens, contextWindowTokens)
          params.onModelContextResolved?.(safeContextWindowTokens)

          if (isChatGptOAuth && failoverIndex === 0 && attempt === 0) {
            trackEvent({
              event: AnalyticsEvent.CHATGPT_OAUTH_REQUEST,
              userId: userId ?? '',
              properties: {
                model: requestedModel,
                userInputId,
              },
              logger,
            })
          }

          const providerOptionsWithReasoning = withConfiguredReasoningEffort(
            originalProviderOptions as Record<string, JSONObject> | undefined,
            reasoningEffort,
          )
          const requestProviderOptions =
            isChatGptOAuth || compatibility.stripProviderMetadata
              ? providerOptionsWithReasoning
              : getProviderOptions({
                  ...params,
                  // Use the resolved effective model (post-openbuff.json routing) so
                  // provider ordering and allow_fallbacks are based on the actual
                  // model being used, not the optional requested template field.
                  model: effectiveModel,
                  providerOptions: providerOptionsWithReasoning,
                  agentProviderOptions: params.agentProviderOptions,
                })

          // Computed inside the attempt loop rather than hoisted: failover
          // and retries can resolve a different model whose compatibility
          // layer strips `tools` from the request, and the emergency brake
          // must subtract the overhead of the request actually sent.
          const requestOverheadTokens = countRequestOverheadTokens({
            system: streamParams.system,
            tools: streamParams.tools,
            includeTools: compatibility.supportsTools !== false,
          })

          response = streamText({
            ...streamParams,
            ...(compatibility.supportsTools === false
              ? { tools: undefined, toolChoice: undefined }
              : {}),
            prompt: undefined,
            model: aiSDKModel,
            messages: convertCbToModelMessages({
              ...params,
              messages: getMessagesForModelContext({
                messages: params.messages,
                contextWindowTokens: contextWindowTokens ?? undefined,
                maxTotalTokensOverride: providerMessageLimitOverride,
                systemTokens: requestOverheadTokens,
                logger,
                trackEvent,
                userId,
                userInputId,
                model: effectiveModel,
              }),
              includeCacheControl:
                isChatGptOAuth && compatibility.stripCacheControl === false,
            }),
            ...(isChatGptOAuth && { maxRetries: 0 }),
            ...(hasProviderOptions(requestProviderOptions)
              ? { providerOptions: requestProviderOptions }
              : {}),
            // Handle tool call errors gracefully by passing them through to our validation layer
            // instead of throwing (which would halt the agent). The only special case is when
            // the tool name matches a spawnable agent - transform those to spawn_agents calls.
            experimental_repairToolCall: async ({ toolCall, tools, error }) => {
              const { spawnableAgents = [], localAgentTemplates = {} } = params
              const toolName = toolCall.toolName

              // Check if this is a NoSuchToolError for a spawnable agent
              // If so, transform to spawn_agents call
              if (
                NoSuchToolError.isInstance(error) &&
                'spawn_agents' in tools
              ) {
                // Also check for underscore variant (e.g., "file_picker" -> "file-picker")
                const toolNameWithHyphens = toolName.replace(/_/g, '-')

                const matchingAgentId = spawnableAgents.find((agentId) => {
                  const withoutVersion = agentId.split('@')[0]
                  const parts = withoutVersion.split('/')
                  const agentName = parts[parts.length - 1]
                  return (
                    agentName === toolName ||
                    agentName === toolNameWithHyphens ||
                    agentId === toolName
                  )
                })
                const isSpawnableAgent = matchingAgentId !== undefined
                const isLocalAgent =
                  toolName in localAgentTemplates ||
                  toolNameWithHyphens in localAgentTemplates

                if (isSpawnableAgent || isLocalAgent) {
                  // Use the matching agent ID or corrected name with hyphens
                  const correctedAgentType =
                    matchingAgentId ??
                    (toolNameWithHyphens in localAgentTemplates
                      ? toolNameWithHyphens
                      : toolName)

                  const spawnAgentsInput =
                    buildSpawnAgentsInputForDirectAgentCall({
                      agentType: correctedAgentType,
                      input: toolCall.input,
                    })
                  if (!spawnAgentsInput) {
                    logger.warn(
                      { originalToolName: toolName },
                      'Could not safely parse direct agent tool input; leaving the original call for normal validation',
                    )
                    return toolCall
                  }

                  logger.info(
                    {
                      originalToolName: toolName,
                      transformedInput: spawnAgentsInput,
                    },
                    'Transformed agent tool call to spawn_agents',
                  )

                  return {
                    ...toolCall,
                    toolName: 'spawn_agents',
                    input: JSON.stringify(spawnAgentsInput),
                  }
                }
              }

              // For all other cases (invalid args, unknown tools, etc.), pass through
              // the original tool call.
              logger.info(
                {
                  toolName,
                  errorType: error.name,
                  error: error.message,
                },
                'Tool error - passing through for graceful error handling',
              )
              return toolCall
            },
          })

          const stopSequenceHandler = new StopSequenceHandler(
            params.stopSequences,
          )

          for await (const chunkValue of response.fullStream) {
            if (chunkValue.type !== 'text-delta') {
              const flushed = stopSequenceHandler.flush()
              if (flushed) {
                hasYieldedContent = true
                anyContentYielded = true
                yield {
                  type: 'text',
                  text: flushed,
                  ...(agentChunkMetadata ?? {}),
                }
              }
            }
            if (chunkValue.type === 'error') {
              // Error chunks from fullStream are non-network errors (tool failures, model issues, rate limits, etc.)
              // Network errors which cannot be recovered from are thrown, not yielded as chunks.

              const errorBody = APICallError.isInstance(chunkValue.error)
                ? chunkValue.error.responseBody
                : undefined
              const mainErrorMessage =
                chunkValue.error instanceof Error
                  ? chunkValue.error.message
                  : typeof chunkValue.error === 'string'
                    ? chunkValue.error
                    : JSON.stringify(chunkValue.error)
              const errorMessage = buildArray([
                mainErrorMessage,
                errorBody,
              ]).join('\n')

              // Pass these errors back to the agent so it can see what went wrong and retry.
              // Note: If you find any other error types that should be passed through to the agent, add them here!
              if (
                NoSuchToolError.isInstance(chunkValue.error) ||
                InvalidToolInputError.isInstance(chunkValue.error) ||
                ToolCallRepairError.isInstance(chunkValue.error) ||
                TypeValidationError.isInstance(chunkValue.error)
              ) {
                logger.warn(
                  {
                    chunk: { ...chunkValue, error: undefined },
                    error: getErrorObject(chunkValue.error),
                    model: params.model,
                  },
                  'Tool call error in AI SDK stream - passing through to agent to retry',
                )
                hasYieldedContent = true
                anyContentYielded = true
                yield {
                  type: 'error',
                  message: errorMessage,
                }
                continue
              }

              const chatGptErrorPolicy = classifyChatGptOAuthStreamError({
                isChatGptOAuth,
                skipChatGptOAuth: params.skipChatGptOAuth,
                hasYieldedContent,
                error: chunkValue.error,
              })

              if (chatGptErrorPolicy === 'fallback-rate-limit') {
                const rateLimitErrorDetails =
                  chunkValue.error instanceof Error
                    ? chunkValue.error.message
                    : String(chunkValue.error)
                logger.warn(
                  { error: getErrorObject(chunkValue.error) },
                  'ChatGPT OAuth rate limited during stream',
                )

                trackEvent({
                  event: AnalyticsEvent.CHATGPT_OAUTH_RATE_LIMITED,
                  userId: userId ?? '',
                  properties: {
                    model: requestedModel,
                    userInputId,
                  },
                  logger,
                })

                markChatGptOAuthRateLimited()

                // ChatGPT OAuth is rate-limited: re-resolve the model through the
                // configured openbuff.json providers instead.
                // Prevent parent retry while delegating to child stream
                anyContentYielded = true
                const fallbackResult = yield* promptAiSdkStream({
                  ...params,
                  skipChatGptOAuth: true,
                })
                return fallbackResult
              }

              if (chatGptErrorPolicy === 'fail-auth-reconnect') {
                logger.info(
                  { error: getErrorObject(chunkValue.error) },
                  'ChatGPT OAuth auth error during stream, attempting token refresh',
                )

                trackEvent({
                  event: AnalyticsEvent.CHATGPT_OAUTH_AUTH_ERROR,
                  userId: userId ?? '',
                  properties: {
                    model: requestedModel,
                    userInputId,
                  },
                  logger,
                })

                // Try refreshing the token and retrying once before failing/falling back
                if (!params.chatGptOAuthRetried) {
                  const refreshed = await refreshChatGptOAuthToken()
                  if (refreshed) {
                    logger.info(
                      { model: requestedModel },
                      'ChatGPT OAuth token refreshed, retrying request',
                    )
                    // Prevent parent retry while delegating to child stream
                    anyContentYielded = true
                    const retryResult = yield* promptAiSdkStream({
                      ...params,
                      chatGptOAuthRetried: true,
                    })
                    return retryResult
                  }
                  logger.warn(
                    { model: requestedModel },
                    'ChatGPT OAuth token refresh failed, unable to recover',
                  )
                }

                // Refresh failed or already retried: re-resolve the model through
                // the configured openbuff.json providers instead.
                // Prevent parent retry while delegating to child stream
                anyContentYielded = true
                const fallbackResult = yield* promptAiSdkStream({
                  ...params,
                  skipChatGptOAuth: true,
                })
                return fallbackResult
              }

              logger.error(
                {
                  chunk: { ...chunkValue, error: undefined },
                  error: getErrorObject(chunkValue.error),
                  model: params.model,
                },
                'Error in AI SDK stream',
              )

              // For all other errors, throw them -- they are fatal.
              throw chunkValue.error
            }
            if (chunkValue.type === 'reasoning-delta') {
              const reasoningExcluded = (
                ['openrouter', 'codebuff'] as const
              ).some(
                (p) =>
                  (
                    params.providerOptions?.[p] as
                      | OpenRouterProviderOptions
                      | undefined
                  )?.reasoning?.exclude,
              )
              if (!reasoningExcluded) {
                hasYieldedContent = true
                anyContentYielded = true
                yield {
                  type: 'reasoning',
                  text: chunkValue.text,
                }
              }
            }
            if (chunkValue.type === 'text-delta') {
              if (!params.stopSequences) {
                if (chunkValue.text) {
                  hasYieldedContent = true
                  anyContentYielded = true
                  yield {
                    type: 'text',
                    text: chunkValue.text,
                    ...(agentChunkMetadata ?? {}),
                  }
                }
                continue
              }

              const stopSequenceResult = stopSequenceHandler.process(
                chunkValue.text,
              )
              if (stopSequenceResult.text) {
                hasYieldedContent = true
                anyContentYielded = true
                yield {
                  type: 'text',
                  text: stopSequenceResult.text,
                  ...(agentChunkMetadata ?? {}),
                }
              }
              if (stopSequenceResult.endOfStream) {
                break
              }
            }
            if (chunkValue.type === 'tool-call') {
              hasYieldedContent = true
              anyContentYielded = true
              const { providerMetadata, ...toolCall } = chunkValue
              yield {
                ...toolCall,
                ...(providerMetadata
                  ? { providerOptions: providerMetadata }
                  : {}),
              }
            }
          }
          const flushed = stopSequenceHandler.flush()
          if (flushed) {
            anyContentYielded = true
            yield {
              type: 'text',
              text: flushed,
              ...(agentChunkMetadata ?? {}),
            }
          }

          const finishReason = await response.finishReason
          const contentPolicyError = getProviderContentPolicyFinishError({
            finishReason,
            model: failoverModel,
          })
          if (contentPolicyError) throw contentPolicyError

          // Stream completed successfully — collect post-stream metadata
          const responseValue = await awaitOptionalPostStreamMetadata({
            promise: response.response,
            label: 'provider response metadata',
            logger,
          })
          const messageId =
            responseValue && typeof responseValue.id === 'string'
              ? responseValue.id
              : null

          if (params.onCacheDebugProviderRequestBuilt) {
            const requestMetadata = await awaitOptionalPostStreamMetadata({
              promise: response.request,
              label: 'provider request metadata',
              logger,
            })
            if (requestMetadata) {
              emitCacheDebugProviderRequest({
                callback: params.onCacheDebugProviderRequestBuilt,
                provider: getModelProvider(aiSDKModel),
                rawBody: requestMetadata.body,
              })
            }
          }

          if (params.onCacheDebugUsageReceived) {
            const usageResult = await awaitOptionalPostStreamMetadata({
              promise: response.usage,
              label: 'provider usage metadata',
              logger,
            })
            if (usageResult) {
              emitCacheDebugUsage({
                callback: params.onCacheDebugUsageReceived,
                usage: usageResult,
              })
            }
          }

          // Skip provider-cost tracking for ChatGPT OAuth because the request runs
          // under the user's provider-owned ChatGPT/Codex subscription.
          if (!isChatGptOAuth && !compatibility.stripProviderMetadata) {
            const providerMetadataResult =
              await awaitOptionalPostStreamMetadata({
                promise: response.providerMetadata,
                label: 'provider usage metadata',
                logger,
              })
            const providerMetadata = providerMetadataResult ?? {}

            let costOverrideDollars: number | undefined
            if (providerMetadata.codebuff) {
              if (providerMetadata.codebuff.usage) {
                const openrouterUsage = providerMetadata.codebuff
                  .usage as OpenRouterUsageAccounting

                costOverrideDollars =
                  (openrouterUsage.cost ?? 0) +
                  (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
              }
            }

            // Fallback (M8.2): when the provider does not return OpenRouter-style
            // cost metadata, compute cost from token usage × the configured
            // `modelCapabilities.pricing` capability so BYOK providers get cost
            // tracking too.
            if (costOverrideDollars === undefined && pricing) {
              const usageResult = await awaitOptionalPostStreamMetadata({
                promise: response.usage,
                label: 'provider usage metadata for cost',
                logger,
              })
              if (usageResult) {
                const fallbackCents = computeCostCentsFromUsage({
                  usage: usageResult,
                  pricing,
                })
                if (fallbackCents !== undefined && params.onCostCalculated) {
                  await params.onCostCalculated(fallbackCents)
                }
              }
            } else if (params.onCostCalculated && costOverrideDollars) {
              // Report provider cost in cents for local/BYOK telemetry only.
              await params.onCostCalculated(
                calculateProviderCostCents({
                  costDollars: costOverrideDollars,
                }),
              )
            }
          }

          if (attempt > 0 || failoverIndex > 0) {
            emitProviderStatus({ status: 'recovered', model: failoverModel })
          }
          return promptSuccess(messageId)
        } catch (caughtError) {
          const error =
            normalizeProviderContentPolicyError(caughtError) ?? caughtError
          lastError = error

          // Don't retry user-cancelled requests
          if (params.signal.aborted) {
            throw error
          }

          if (anyContentYielded) {
            // Content was already yielded to the caller — cannot safely retry
            logger.warn(
              { error: getErrorObject(error), attempt: attempt + 1 },
              'Stream error after content was yielded, cannot retry',
            )
            throw error
          }

          const providerContextLimit = getProviderContextLimitFromError(error)
          if (
            providerContextLimit !== undefined &&
            !promptTooLongRetried &&
            attempt < MAX_RETRIES_PER_MESSAGE
          ) {
            promptTooLongRetried = true
            // Leave room for system/tool overhead and provider-side tokenization
            // differences. The normal model-window policy is also applied, so a
            // configured smaller window remains authoritative.
            providerMessageLimitOverride =
              getModelContextMessageLimit(providerContextLimit)
            logger.warn(
              {
                model: failoverModel,
                providerContextLimit,
                messageLimit: providerMessageLimitOverride,
              },
              'Provider rejected an oversized prompt; retrying once with an adaptive context trim',
            )
            emitProviderStatus({
              status: 'retrying',
              model: failoverModel,
              attempt: attempt + 2,
              maxAttempts: MAX_RETRIES_PER_MESSAGE + 1,
            })
            continue
          }

          // Retry on transient network errors OR retryable HTTP status codes
          // (408/429/500/502/503/504). The AI SDK surfaces provider 5xx responses
          // as APICallError with a `statusCode`/`status` property; without this
          // check, a provider 500 would be thrown immediately rather than retried.
          const statusCode = getErrorStatusCode(error)
          const isRetryableStatus = isRetryableStatusCode(statusCode)
          if (!isTransientNetworkError(error) && !isRetryableStatus) {
            throw error
          }

          if (attempt >= MAX_RETRIES_PER_MESSAGE) {
            logger.error(
              {
                error: getErrorObject(error),
                attempts: attempt + 1,
                statusCode,
              },
              'Stream failed after all retry attempts',
            )
            throw error
          }

          const delayMs = computeBackoffDelayMs({
            attempt,
            baseDelayMs: RETRY_BACKOFF_BASE_DELAY_MS,
          })
          logger.warn(
            {
              error: getErrorObject(error),
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES_PER_MESSAGE,
              delayMs,
              statusCode,
            },
            isRetryableStatus
              ? `Retryable HTTP ${statusCode} during stream, retrying with delay`
              : 'Transient network error during stream, retrying with delay',
          )
          emitProviderStatus({
            status: 'retrying',
            model: failoverModel,
            attempt: attempt + 2,
            maxAttempts: MAX_RETRIES_PER_MESSAGE + 1,
            delayMs,
            ...(statusCode !== undefined ? { statusCode } : {}),
          })
          await waitForBackoffDelay({ delayMs, signal: params.signal })
        }
      }
    } catch (error) {
      lastError = error

      const canFailover =
        !anyContentYielded &&
        failoverIndex < modelsToTry.length - 1 &&
        isFailoverEligibleError(error)

      if (!canFailover) {
        throw error
      }

      const statusCode = getErrorStatusCode(error)
      trackEvent({
        event: AnalyticsEvent.PROVIDER_FAILOVER,
        userId: userId ?? '',
        properties: {
          fromModel: failoverModel,
          toModel: modelsToTry[failoverIndex + 1],
          statusCode,
          userInputId,
        },
        logger,
      })
      logger.warn(
        {
          fromModel: failoverModel,
          toModel: modelsToTry[failoverIndex + 1],
          statusCode,
          failoverIndex,
        },
        'Provider failover: primary model failed, trying next configured model',
      )
      emitProviderStatus({
        status: 'failover',
        model: failoverModel,
        nextModel: modelsToTry[failoverIndex + 1],
        ...(statusCode !== undefined ? { statusCode } : {}),
      })
    }
  }

  // Should be unreachable, but if the loop exits without returning or throwing,
  // rethrow the last error
  throw lastError
}

export async function promptAiSdk(
  params: ParamsOf<PromptAiSdkFn>,
): ReturnType<PromptAiSdkFn> {
  const { logger } = params

  if (params.signal.aborted) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
      },
      'Skipping prompt due to canceled user input',
    )
    return promptAborted('User cancelled input')
  }

  const modelParams: ModelRequestParams = {
    apiKey: params.apiKey,
    model: params.model,
    agentId: params.agentId,
    skipChatGptOAuth: true, // Non-streaming skips ChatGPT OAuth; local/provider config may still route BYOK.
    requiresVision: valueContainsImageInput(params.messages),
  }
  const {
    model: aiSDKModel,
    compatibility,
    reasoningEffort,
    effectiveModel: effectiveModelSdk,
    contextWindowTokens,
    pricing,
  } = await getModelForRequest(modelParams)

  const providerOptionsWithReasoning = withConfiguredReasoningEffort(
    (params as { providerOptions?: Record<string, JSONObject> })
      .providerOptions,
    reasoningEffort,
  )
  const requestProviderOptions = compatibility.stripProviderMetadata
    ? providerOptionsWithReasoning
    : getProviderOptions({
        ...params,
        model: effectiveModelSdk,
        providerOptions: providerOptionsWithReasoning,
        agentProviderOptions: params.agentProviderOptions,
        cacheDebugCorrelation: params.cacheDebugCorrelation,
      })

  // Same system/tool surface as the streaming path (generateText params carry
  // `system` and `tools`), so the emergency brake subtracts it here too.
  const requestOverheadTokens = countRequestOverheadTokens({
    system: params.system,
    tools: params.tools,
    includeTools: compatibility.supportsTools !== false,
  })

  let response: Awaited<ReturnType<typeof generateText>>
  try {
    response = await generateText({
      ...params,
      ...(compatibility.supportsTools === false
        ? { tools: undefined, toolChoice: undefined }
        : {}),
      prompt: undefined,
      model: aiSDKModel,
      messages: convertCbToModelMessages({
        ...params,
        messages: getMessagesForModelContext({
          messages: params.messages,
          contextWindowTokens,
          systemTokens: requestOverheadTokens,
          logger,
          trackEvent: params.trackEvent,
          userId: params.userId,
          userInputId: params.userInputId,
          model: effectiveModelSdk,
        }),
        includeCacheControl: compatibility.stripCacheControl === false,
      }),
      ...(hasProviderOptions(requestProviderOptions)
        ? { providerOptions: requestProviderOptions }
        : {}),
    })
  } catch (error) {
    throw normalizeProviderContentPolicyError(error) ?? error
  }
  const contentPolicyError = getProviderContentPolicyFinishError({
    finishReason: response.finishReason,
    model: effectiveModelSdk,
  })
  if (contentPolicyError) throw contentPolicyError
  emitCacheDebugProviderRequest({
    callback: params.onCacheDebugProviderRequestBuilt,
    provider: getModelProvider(aiSDKModel),
    rawBody: response.request?.body,
  })
  emitCacheDebugUsage({
    callback: params.onCacheDebugUsageReceived,
    usage: response.usage,
  })
  const content = response.text

  const providerMetadata = response.providerMetadata ?? {}
  let costOverrideDollars: number | undefined
  if (providerMetadata.codebuff) {
    if (providerMetadata.codebuff.usage) {
      const openrouterUsage = providerMetadata.codebuff
        .usage as OpenRouterUsageAccounting

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  // Report provider cost in cents for local/BYOK telemetry only.
  // Fallback (M8.2): when the provider does not return OpenRouter-style
  // cost metadata, compute cost from token usage × the configured
  // `modelCapabilities.pricing` capability so BYOK providers get cost
  // tracking too.
  if (costOverrideDollars === undefined && pricing) {
    const fallbackCents = computeCostCentsFromUsage({
      usage: response.usage,
      pricing,
    })
    if (fallbackCents !== undefined && params.onCostCalculated) {
      await params.onCostCalculated(fallbackCents)
    }
  } else if (params.onCostCalculated && costOverrideDollars) {
    // Report provider cost in cents for local/BYOK telemetry only.
    await params.onCostCalculated(
      calculateProviderCostCents({ costDollars: costOverrideDollars }),
    )
  }

  return promptSuccess(content)
}

export async function promptAiSdkStructured<T>(
  params: PromptAiSdkStructuredInput<T>,
): PromptAiSdkStructuredOutput<T> {
  const { logger } = params

  if (params.signal.aborted) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
      },
      'Skipping structured prompt due to canceled user input',
    )
    return promptAborted('User cancelled input')
  }
  const modelParams: ModelRequestParams = {
    apiKey: params.apiKey,
    model: params.model,
    agentId: params.agentId,
    skipChatGptOAuth: true, // Non-streaming skips ChatGPT OAuth; local/provider config may still route BYOK.
    requiresVision: valueContainsImageInput(params.messages),
  }
  const {
    model: aiSDKModel,
    compatibility,
    reasoningEffort,
    effectiveModel: effectiveModelStructured,
    contextWindowTokens,
    pricing,
  } = await getModelForRequest(modelParams)

  const providerOptionsWithReasoning = withConfiguredReasoningEffort(
    (params as { providerOptions?: Record<string, JSONObject> })
      .providerOptions,
    reasoningEffort,
  )
  const requestProviderOptions = compatibility.stripProviderMetadata
    ? providerOptionsWithReasoning
    : getProviderOptions({
        ...params,
        model: effectiveModelStructured,
        providerOptions: providerOptionsWithReasoning,
        agentProviderOptions: params.agentProviderOptions,
        cacheDebugCorrelation: params.cacheDebugCorrelation,
      })

  let response: GenerateObjectResult<T>
  try {
    response = await generateObject<z.ZodType<T>, 'object'>({
      ...params,
      ...(compatibility.supportsTools === false
        ? { tools: undefined, toolChoice: undefined }
        : {}),
      prompt: undefined,
      model: aiSDKModel,
      output: 'object',
      messages: convertCbToModelMessages({
        ...params,
        // `PromptAiSdkStructuredInput` has no `system`/`tools` request surface
        // (unlike the streamText/generateText param types), so there is
        // nothing comparable to subtract and systemTokens stays at its 0
        // default here.
        messages: getMessagesForModelContext({
          messages: params.messages,
          contextWindowTokens,
          logger,
          trackEvent: params.trackEvent,
          userId: params.userId,
          userInputId: params.userInputId,
          model: effectiveModelStructured,
        }),
        includeCacheControl: compatibility.stripCacheControl === false,
      }),
      ...(hasProviderOptions(requestProviderOptions)
        ? { providerOptions: requestProviderOptions }
        : {}),
    })
  } catch (error) {
    throw normalizeProviderContentPolicyError(error) ?? error
  }
  const contentPolicyError = getProviderContentPolicyFinishError({
    finishReason: response.finishReason,
    model: effectiveModelStructured,
    responseLabel: 'structured response',
  })
  if (contentPolicyError) throw contentPolicyError

  emitCacheDebugProviderRequest({
    callback: params.onCacheDebugProviderRequestBuilt,
    provider: getModelProvider(aiSDKModel),
    rawBody: response.request?.body,
  })
  emitCacheDebugUsage({
    callback: params.onCacheDebugUsageReceived,
    usage: response.usage,
  })

  const content = response.object

  const providerMetadata = response.providerMetadata ?? {}
  let costOverrideDollars: number | undefined
  if (providerMetadata.codebuff) {
    if (providerMetadata.codebuff.usage) {
      const openrouterUsage = providerMetadata.codebuff
        .usage as OpenRouterUsageAccounting

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  // Fallback (M8.2): when the provider does not return OpenRouter-style
  // cost metadata, compute cost from token usage × the configured
  // `modelCapabilities.pricing` capability so BYOK providers get cost
  // tracking too.
  if (costOverrideDollars === undefined && pricing) {
    const fallbackCents = computeCostCentsFromUsage({
      usage: response.usage,
      pricing,
    })
    if (fallbackCents !== undefined && params.onCostCalculated) {
      await params.onCostCalculated(fallbackCents)
    }
  } else if (params.onCostCalculated && costOverrideDollars) {
    // Report provider cost in cents for local/BYOK telemetry only.
    await params.onCostCalculated(
      calculateProviderCostCents({ costDollars: costOverrideDollars }),
    )
  }

  return promptSuccess(content)
}
