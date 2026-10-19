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

/**
 * Payload of a streamed tool call: exactly the AI SDK tool-call part the
 * runtime consumes, and nothing more. This is the shape to spread whenever a
 * tool call is forwarded or persisted (tool-call events, assistant-message /
 * tool-call history), so stream-only transport metadata can never leak into a
 * serialized tool call. It is unchanged by the transport-truncation signal,
 * which lives on {@link ToolCallStreamChunk}.
 */
export type ToolCallStreamChunkPayload = Pick<
  ToolCallPart,
  'type' | 'toolCallId' | 'toolName' | 'input' | 'providerOptions'
>

/**
 * A `tool-call` stream chunk: the payload above plus the stream-only transport
 * marker below. Explicitly handled — the marker is NOT part of
 * {@link ToolCallStreamChunkPayload}, so widening it never widens the persisted
 * tool-call shape.
 *
 * `transportTruncated` is set only when the provider reported
 * `finishReason === 'length'` (the max-token cut) for the response that
 * produced this tool call. The runtime treats it as AUTHORITATIVE evidence that
 * the tool-call payload may have been cut in transport, so truncation does not
 * have to be guessed from a downstream JSON parse error. Absent means the
 * provider reported no cut — the marker is never set to `false`.
 *
 * Consumers that forward or persist a tool call take the payload shape via
 * {@link toToolCallStreamChunkPayload}, so the on-the-wire / persisted
 * tool-call payload is identical whether or not the cut was reported.
 *
 * The marker is set solely from the provider's `finishReason === 'length'`
 * report — no byte-band comparison happens on the producer path. The related
 * config-side band is `MAX_TRANSPORT_SAFE_PAYLOAD_BYTES`
 * (`common/src/actions.ts`), surfaced through `DEFAULT_MAX_OUTPUT_BYTES` and
 * the optional per-model `modelCapabilities.<model>.maxOutputBytes` /
 * `defaultCapabilities.maxOutputBytes` overrides
 * (`sdk/src/provider-config.ts`). Its one runtime consumer is the sdk
 * stream's band diagnostic, which warns when pending payloads exceed the
 * configured band without a provider length report. The band never gates or
 * sets this marker.
 */
export type ToolCallStreamChunk = ToolCallStreamChunkPayload & {
  transportTruncated?: true
}

/**
 * Applies the provider's authoritative transport-truncation fact. The single
 * producer-side mutation of the marker, so the flag is emitted through one
 * named operation instead of an ad-hoc spread.
 */
export function withTransportTruncation(
  chunk: ToolCallStreamChunk,
): ToolCallStreamChunk {
  return { ...chunk, transportTruncated: true }
}

/**
 * Drops the stream-only transport marker, returning the payload shape that is
 * forwarded and persisted. Generic so the caller's EXACT field types survive:
 * a narrow `CodebuffToolCall` stays narrow (its zod-inferred `input` type is
 * preserved), a streamed chunk yields the bare payload, and any history
 * tool-call object without a `type` gets one filled in. Every boundary into
 * message history routes through this one strip point, so a streamed tool
 * call's transport evidence never survives into a serialized tool call.
 */
export function toToolCallStreamChunkPayload<
  TToolCall extends Omit<ToolCallStreamChunk, 'type'> & {
    type?: ToolCallStreamChunkPayload['type']
  },
>(
  chunk: TToolCall,
): Omit<TToolCall, 'transportTruncated' | 'type'> & { type: 'tool-call' } {
  // Copy-and-strip, not a field-by-field rebuild: only the stream-only marker
  // is removed and every other field — including ones the AI SDK adds to
  // ToolCallPart after this contract was written — flows through unchanged, so
  // the persisted tool-call shape can never silently narrow.
  const { transportTruncated: _streamOnlyMarker, ...rest } = chunk
  // The result provably carries every field of `rest` plus a required
  // 'tool-call' discriminator; the assertion only bridges the generic spread
  // that TypeScript cannot verify on its own.
  return { ...rest, type: 'tool-call' } as Omit<
    TToolCall,
    'transportTruncated' | 'type'
  > & { type: 'tool-call' }
}

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
  | ToolCallStreamChunk
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
