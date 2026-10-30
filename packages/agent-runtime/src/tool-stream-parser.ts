import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { realIdGen } from '@codebuff/common/deps/real-runtime-deps'
import { toToolCallStreamChunkPayload } from '@codebuff/common/types/contracts/llm'

import {
  createStreamParserState,
  finalizeStreamParserState,
  parseStreamChunk,
} from './util/stream-xml-parser'

import type {
  StreamParserError,
  StreamParserState,
} from './util/stream-xml-parser'
import type { Model } from '@codebuff/common/old-constants'
import type { IdGen } from '@codebuff/common/types/contracts/agent-runtime'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ProviderMetadata } from '@codebuff/common/types/messages/provider-metadata'
import type {
  PrintModeError,
  PrintModeText,
} from '@codebuff/common/types/print-mode'
import type { PromptResult } from '@codebuff/common/util/error'

/**
 * The chunk types this parser forwards downstream. The stream-only `finish`
 * marker (the `{ type: 'finish' }` StreamChunk variant carrying the
 * provider's finish reason) is intercepted in `processChunk` below and is
 * never forwarded: the wrapper's exhaustive chunk-type switches
 * (`chunk satisfies never`) must never see it, and it is never persisted.
 */
type ForwardedStreamChunk = Exclude<StreamChunk, { type: 'finish' }>

type ToolCallContext = {
  toolCallId?: string
  providerOptions?: ProviderMetadata
  /**
   * Set only when the provider reported a max-token cut for the response that
   * emitted this call, so the executor can classify truncation from a known
   * fact instead of a JSON-parse heuristic.
   */
  providerReportedTruncation?: boolean
}

function summarizeToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    return {
      inputType: 'string',
      inputLength: input.length,
    }
  }

  if (Array.isArray(input)) {
    return {
      inputType: 'array',
      inputLength: input.length,
    }
  }

  if (input && typeof input === 'object') {
    const keys = Object.keys(input as Record<string, unknown>)
    return {
      inputType: 'object',
      inputKeyCount: keys.length,
      inputKeys: keys.slice(0, 25),
    }
  }

  return {
    inputType: input === null ? 'null' : typeof input,
  }
}

/**
 * Actionable next-step guidance per parser error code. Composed onto the
 * base message only at the emission boundary (never baked into the parser,
 * so the base messages stay byte-identical): the overflow error used to
 * carry no guidance at all, and a call dropped at end of stream needs an
 * explicit retry directive the model can act on
 * (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
 */
export function streamParserErrorGuidance(
  code: StreamParserError['code'],
): string | undefined {
  switch (code) {
    case 'tool_call_buffer_exceeded':
      return 'This tool call exceeded the streaming buffer limit. Split large payloads across multiple smaller tool calls (for example, write files in smaller chunks) instead of inlining the entire payload.'
    case 'tool_call_unterminated_eof':
      return 'The response ended before this tool call was complete. Re-emit the complete tool call, keeping the payload small enough to finish within the response.'
    default:
      return undefined
  }
}

/**
 * Additive annotation appended to a parser error when the provider reported
 * the max-token cut (`finishReason === 'length'`): without it, a tool call
 * cut off by the response's token limit is indistinguishable from a
 * payload-too-big failure in the error report, so the model would shrink the
 * payload when it actually needs to finish the response
 * (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
 */
const MAX_TOKEN_TRUNCATION_ANNOTATION =
  'The provider reported the response ended at the max-token limit (finish reason "length"), so this tool call was cut off before it completed.'

export async function* processStreamWithTools(params: {
  stream: AsyncGenerator<StreamChunk, PromptResult<string | null>>
  processors: Record<
    string,
    {
      onTagStart: (
        tagName: string,
        attributes: Record<string, string>,
      ) => void | Promise<void>
      onTagEnd: (
        tagName: string,
        params: Record<string, any>,
        context?: ToolCallContext,
      ) => void | Promise<void>
    }
  >
  defaultProcessor: (toolName: string) => {
    onTagStart: (
      tagName: string,
      attributes: Record<string, string>,
    ) => void | Promise<void>
    onTagEnd: (
      tagName: string,
      params: Record<string, any>,
      context?: ToolCallContext,
    ) => void | Promise<void>
  }
  onResponseChunk: (chunk: PrintModeText | PrintModeError) => void
  logger: Logger
  loggerOptions?: {
    userId?: string
    model?: Model
    agentName?: string
  }
  trackEvent: TrackEventFn
  /** Injectable id generator (P2-T1); resolves to realIdGen when omitted. */
  idGen?: IdGen
  executeXmlToolCall: (params: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<void>
}): AsyncGenerator<ForwardedStreamChunk, PromptResult<string | null>> {
  const {
    stream,
    processors,
    defaultProcessor,
    onResponseChunk,
    logger,
    loggerOptions,
    trackEvent,
    idGen,
    executeXmlToolCall,
  } = params
  let autocompleted = false

  // State for parsing XML tool calls from text stream
  const xmlParserState: StreamParserState = createStreamParserState()

  // Stream-only evidence from the `finish` chunk (intercepted in
  // processChunk below, never forwarded): the provider's authoritative
  // finish reason for the response. `finishReason === 'length'` is the
  // max-token cut — the fact that separates a tool call cut off by the
  // response limit from one that was simply too big, which the parser's
  // error reports could not previously distinguish
  // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
  let streamFinishReason:
    | Extract<StreamChunk, { type: 'finish' }>['finishReason']
    | undefined

  // Mid-stream parser errors, deferred to the finalize block: the finish
  // chunk arrives BEFORE stream end, so finalize is the only emission point
  // where the max-token fact above is known. The finalize emission runs from
  // the consumption loop's finally (below), so the deferral never drops a
  // report on a thrown stream or a consumer early exit.
  const deferredParserErrors: StreamParserError[] = []

  async function processToolCallObject(params: {
    toolCallId?: string
    toolName: string
    input: any
    contents?: string
    providerOptions?: ProviderMetadata
    /**
     * Provider-reported max-token cut carried on the tool-call chunk
     * (`ToolCallStreamChunk.transportTruncated`) — stream-only evidence that
     * this call's payload may have been cut in transport.
     */
    transportTruncated?: true
  }): Promise<void> {
    const { toolCallId, toolName, contents, providerOptions } = params
    let { input } = params

    // AI SDK sometimes emits tool-call chunks with a raw JSON string as `input`
    // when its repair pass can't produce a parsed object. Try to parse; if it
    // fails, leave as string — the executor surfaces a clear error.
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch (err) {
        // Audit shard-runtime-loop tool-stream-parser.ts:132: surface the
        // failure through the injected logger (with run context) instead of a
        // bare console.debug, so malformed model tool input is observable in
        // production. NO onResponseChunk error event here: the raw string is
        // still forwarded to the executor, whose parseJsonStringWithRepair
        // pass may repair it — emitting an error now double-reports the same
        // failure once the executor decides the real outcome.
        logger.warn(
          {
            toolName,
            ...(loggerOptions ?? {}),
            error: err instanceof Error ? err.message : String(err),
            inputLength: input.length,
          },
          'Non-JSON tool input from the model; forwarding raw string to the executor',
        )
      }
    }

    const processor = processors[toolName] ?? defaultProcessor(toolName)

    trackEvent({
      event: AnalyticsEvent.TOOL_USE,
      userId: loggerOptions?.userId ?? '',
      properties: {
        toolName,
        ...summarizeToolInput(input),
        hasContents: typeof contents === 'string' && contents.length > 0,
        contentsLength: contents?.length ?? 0,
        autocompleted,
        model: loggerOptions?.model,
        agent: loggerOptions?.agentName,
      },
      logger,
    })

    await processor.onTagStart(toolName, {})
    await processor.onTagEnd(toolName, input, {
      toolCallId,
      providerOptions,
      ...(params.transportTruncated
        ? { providerReportedTruncation: true }
        : {}),
    })
  }

  function emitParserErrors(errors: StreamParserError[]) {
    // Compose the bounded raw excerpt into the forwarded message at this
    // emission boundary (mirroring the executor's pinned 'Original tool call
    // input:' self-correcting pattern) so the model can diff its broken JSON
    // instead of guessing which call was malformed
    // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
    for (const error of errors) {
      let message =
        error.rawExcerpt !== undefined
          ? `${error.message}\n\nOriginal tool call input (excerpt): ${error.rawExcerpt}`
          : error.message
      // Guidance is appended after the excerpt composition, so base messages
      // stay byte-identical while the model still gets a concrete next step
      // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
      const guidance = streamParserErrorGuidance(error.code)
      if (guidance !== undefined) {
        message += `\n\n${guidance}`
      }
      // Additive truncation annotation, appended only when the provider
      // reported the max-token cut (the intercepted finish chunk above): it
      // rides at the same boundary as the guidance so the base messages stay
      // byte-identical, and tells the model to finish the response instead
      // of shrinking the payload
      // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
      if (streamFinishReason === 'length') {
        message += `\n\n${MAX_TOKEN_TRUNCATION_ANNOTATION}`
      }
      onResponseChunk({ type: 'error', message })
    }
  }

  async function* processChunk(
    chunk: StreamChunk,
  ): AsyncGenerator<ForwardedStreamChunk> {
    if (chunk.type === 'text') {
      // Parse XML tool calls from the text stream
      const { filteredText, toolCalls, errors } = parseStreamChunk(
        chunk.text,
        xmlParserState,
      )

      // Deferred emission (see deferredParserErrors above): held for the
      // finalize block, the only emission point where the finish reason is
      // known.
      deferredParserErrors.push(...errors)

      if (filteredText) {
        // Memory bounding (stream-buffer-unbounded-retained-text): emit text
        // straight through instead of retaining every chunk until a flush
        // point. The previous buffering duplicated the entire response in
        // memory on long pure-text outputs and re-emitted the full prefix at
        // each flush point.
        onResponseChunk({
          type: 'text',
          text: filteredText,
        })
        yield {
          type: 'text',
          text: filteredText,
        }
      }

      // Then process and yield any XML tool calls found
      for (const toolCall of toolCalls) {
        // Full UUID (audit shard-runtime-loop tool-stream-parser.ts:216): the
        // 8-hex-char truncation left a 32-bit id space, so long sessions or
        // eval sweeps could collide tool_call ids and pair a tool_result with
        // the wrong call. There is no size constraint on synthetic ids.
        // P2-T1: the synthetic id mints through the injected idGen
        // (realIdGen fallback), so a replay host can reproduce it.
        const toolCallId = idGen?.prefixedId('xml') ?? realIdGen.prefixedId('xml')

        // Execute the tool immediately if callback provided, pausing the stream
        // The callback handles emitting tool_call and tool_result events
        await executeXmlToolCall({
          toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        })
      }
      return
    }

    if (chunk.type === 'tool-call') {
      await processToolCallObject(chunk)
      // The transport marker is consumed above into `providerReportedTruncation`
      // and is then dropped: it is stream-only evidence, so nothing this stream
      // forwards or persists ever carries it.
      yield toToolCallStreamChunkPayload(chunk)
      return
    }

    // Stream-only finish evidence: intercepted here and never forwarded —
    // the wrapper's exhaustive chunk-type switches must never see this
    // chunk. It is consumed into streamFinishReason so the finalize-time
    // error emission can annotate a max-token cut
    // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
    if (chunk.type === 'finish') {
      streamFinishReason = chunk.finishReason
      return
    }

    yield chunk
  }

  let result: PromptResult<string | null> = { aborted: false, value: null }
  // The finalize emission below runs from a finally, not as a post-loop
  // continuation: a mid-stream throw from `stream.next()` (fatal provider
  // error, content-policy throw, network error) used to propagate straight
  // past it, and a consumer early-exit (the wrapper's cooperative
  // `signal.aborted` break stops calling `.next()`, leaving this generator
  // suspended at a yield until the wrapper closes it via `.return()`) never
  // reached it either — so deferred mid-stream parser errors were silently
  // dropped on exactly the failure paths the pre-deferral immediate emission
  // covered. try/finally runs the finalize emission on EVERY exit path,
  // exactly once.
  try {
    while (true) {
      const { value, done } = await stream.next()
      if (done) {
        result = value
        break
      }
      yield* processChunk(value)
    }
  } finally {
    // End of stream: close the silent EOF gaps in the parser state. A call
    // left unterminated at end of stream is reported back (never executed,
    // never leaked as text) and the outside-call partial-tag carry is flushed
    // as real prose, so neither vanishes silently. The error flows through the
    // existing wrapper routing (TOOL_CALL_ERROR persistence + hadToolCallError
    // retry)
    // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
    const finalized = finalizeStreamParserState(xmlParserState)
    // Deferred mid-stream errors emit first, then the EOF report — document
    // order, both derived from stream order. This is also the only point
    // where the intercepted finish reason is known, so both batches carry the
    // truncation annotation when the provider reported the max-token cut; the
    // finish chunk arrives before stream end, so `streamFinishReason` is
    // already set on every exit path through here and the annotation survives
    // a thrown stream and a consumer early exit unchanged.
    emitParserErrors(deferredParserErrors)
    // Emit-and-clear at the boundary: the buffer is emptied together with the
    // emission, so the exactly-once guarantee holds even if the generator is
    // resumed after the trailing-text yield below.
    deferredParserErrors.length = 0
    emitParserErrors(finalized.errors)
    if (finalized.filteredText) {
      onResponseChunk({ type: 'text', text: finalized.filteredText })
      yield { type: 'text', text: finalized.filteredText }
    }
  }
  return result
}
