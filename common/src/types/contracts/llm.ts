import type { TrackEventFn } from './analytics'
import type { SendActionFn } from './client'
import type {
  OpenRouterProviderRoutingOptions,
  AgentTemplate,
} from '../agent-template'
import type { ParamsExcluding } from '../function-params'
import type { Logger } from './logger'
import type { Model } from '../../old-constants'
import type { Message } from '../messages/codebuff-message'
import type { RequestContextTrimInfo } from '../print-mode'
import type { PromptResult } from '../../util/error'
import type { generateText, streamText, ToolCallPart } from 'ai'
import type z from 'zod/v4'

export type StreamChunk =
  | {
      type: 'text'
      text: string
      agentId?: string
    }
  | {
      type: 'reasoning'
      text: string
    }
  | Pick<
      ToolCallPart,
      'type' | 'toolCallId' | 'toolName' | 'input' | 'providerOptions'
    >
  | { type: 'error'; message: string }

export type CacheDebugUsageData = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
}

/**
 * Report of the SDK's request-time emergency-brake trim (the last line of
 * defense, applied when a dispatched request's messages still exceed the
 * provider-safe budget after the runtime brakes). Emitted only when the trim
 * actually dropped messages.
 *
 * `contextWindowTokens` is the resolved model window when known;
 * `messageBudgetTokens` is the message-only budget applied after reserving the
 * counted system + tool surface.
 *
 * PUBLISHED PAYLOAD TYPE for the optional `onRequestContextTrimmed` callback
 * below. It is DECLARED in `../print-mode` — the module the SDK entry point
 * publishes wholesale, and the only surface the generated `dist/index.d.ts` is
 * built from — and re-exported here so the runtime and SDK call sites that
 * already import it from this contracts module keep working unchanged.
 * Widening it is therefore a public-contract change: only add optional fields.
 */
export type { RequestContextTrimInfo }

export type PromptAiSdkStreamFn = (
  params: {
    apiKey: string
    runId: string
    messages: Message[]
    clientSessionId: string
    fingerprintId: string
    model?: Model
    userId: string | undefined
    chargeUser?: boolean
    thinkingBudget?: number
    userInputId: string
    agentId?: string
    maxRetries?: number
    onCostCalculated?: (providerCostCents: number) => Promise<void>
    onCacheDebugProviderRequestBuilt?: (params: {
      provider: string
      rawBody: unknown
      normalizedBody?: unknown
    }) => void
    onCacheDebugUsageReceived?: (usage: CacheDebugUsageData) => void
    /** Reports the post-routing model context window to the runtime. */
    onModelContextResolved?: (contextWindowTokens: number | undefined) => void
    /**
     * Reports a request-time emergency trim that actually dropped messages.
     * Purely observational: the callback can never affect the trim result, and
     * a throwing consumer is caught and logged rather than aborting dispatch.
     */
    onRequestContextTrimmed?: (info: RequestContextTrimInfo) => void
    includeCacheControl?: boolean
    cacheDebugCorrelation?: string
    agentProviderOptions?: OpenRouterProviderRoutingOptions
    /** List of agents that can be spawned - used to transform agent tool calls */
    spawnableAgents?: string[]
    /** Map of locally available agent templates - used to transform agent tool calls */
    localAgentTemplates?: Record<string, AgentTemplate>
    /** Optional provider cost/accounting mode forwarded to provider adapters. */
    costMode?: string
    /** Extra key/values merged into the request's provider metadata field.
     *  Used to forward client-scoped identifiers or provider-routing metadata
     *  that downstream adapters read from the chat-completions body. */
    extraCodebuffMetadata?: Record<string, string>
    sendAction: SendActionFn
    logger: Logger
    trackEvent: TrackEventFn
    signal: AbortSignal
  } & ParamsExcluding<typeof streamText, 'model' | 'messages'>,
) => AsyncGenerator<StreamChunk, PromptResult<string | null>>

export type PromptAiSdkFn = (
  params: {
    apiKey: string
    runId: string
    messages: Message[]
    clientSessionId: string
    fingerprintId: string
    userInputId: string
    model?: Model
    userId: string | undefined
    chargeUser?: boolean
    agentId?: string
    onCostCalculated?: (providerCostCents: number) => Promise<void>
    onCacheDebugProviderRequestBuilt?: (params: {
      provider: string
      rawBody: unknown
      normalizedBody?: unknown
    }) => void
    onCacheDebugUsageReceived?: (usage: CacheDebugUsageData) => void
    /** See {@link PromptAiSdkStreamFn}'s `onRequestContextTrimmed`. */
    onRequestContextTrimmed?: (info: RequestContextTrimInfo) => void
    includeCacheControl?: boolean
    cacheDebugCorrelation?: string
    agentProviderOptions?: OpenRouterProviderRoutingOptions
    maxRetries?: number
    /** Optional provider cost/accounting mode forwarded to provider adapters. */
    costMode?: string
    sendAction: SendActionFn
    logger: Logger
    trackEvent: TrackEventFn
    n?: number
    signal: AbortSignal
  } & ParamsExcluding<typeof generateText, 'model' | 'messages'>,
) => Promise<PromptResult<string>>

export type PromptAiSdkStructuredInput<T> = {
  apiKey: string
  runId: string
  messages: Message[]
  schema: z.ZodType<T>
  clientSessionId: string
  fingerprintId: string
  userInputId: string
  /** Optional: if omitted, resolved from openbuff.json via agentId or defaultModel. */
  model?: Model
  userId: string | undefined
  maxTokens?: number
  temperature?: number
  timeout?: number
  chargeUser?: boolean
  agentId?: string
  onCostCalculated?: (providerCostCents: number) => Promise<void>
  onCacheDebugProviderRequestBuilt?: (params: {
    provider: string
    rawBody: unknown
    normalizedBody?: unknown
  }) => void
  onCacheDebugUsageReceived?: (usage: CacheDebugUsageData) => void
  /** See {@link PromptAiSdkStreamFn}'s `onRequestContextTrimmed`. */
  onRequestContextTrimmed?: (info: RequestContextTrimInfo) => void
  includeCacheControl?: boolean
  cacheDebugCorrelation?: string
  agentProviderOptions?: OpenRouterProviderRoutingOptions
  maxRetries?: number
  sendAction: SendActionFn
  logger: Logger
  trackEvent: TrackEventFn
  signal: AbortSignal
}
export type PromptAiSdkStructuredOutput<T> = Promise<PromptResult<T>>
export type PromptAiSdkStructuredFn = <T>(
  params: PromptAiSdkStructuredInput<T>,
) => PromptAiSdkStructuredOutput<T>

export type HandleOpenRouterStreamFn = (params: {
  body: Record<string, unknown>
  userId: string
  agentId: string
}) => Promise<ReadableStream>
