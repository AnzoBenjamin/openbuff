import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

import {
  createStreamParserState,
  parseStreamChunk,
} from './util/stream-xml-parser'

import type {
  StreamParserError,
  StreamParserState,
} from './util/stream-xml-parser'
import type { Model } from '@codebuff/common/old-constants'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ProviderMetadata } from '@codebuff/common/types/messages/provider-metadata'
import type {
  PrintModeError,
  PrintModeText,
} from '@codebuff/common/types/print-mode'
import type { PromptResult } from '@codebuff/common/util/error'

type ToolCallContext = {
  toolCallId?: string
  providerOptions?: ProviderMetadata
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
  executeXmlToolCall: (params: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<void>
}): AsyncGenerator<StreamChunk, PromptResult<string | null>> {
  const {
    stream,
    processors,
    defaultProcessor,
    onResponseChunk,
    logger,
    loggerOptions,
    trackEvent,
    executeXmlToolCall,
  } = params
  let autocompleted = false

  // State for parsing XML tool calls from text stream
  const xmlParserState: StreamParserState = createStreamParserState()

  async function processToolCallObject(params: {
    toolCallId?: string
    toolName: string
    input: any
    contents?: string
    providerOptions?: ProviderMetadata
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
    })
  }

  function emitParserErrors(errors: StreamParserError[]) {
    for (const error of errors) {
      onResponseChunk({
        type: 'error',
        message: error.message,
      })
    }
  }

  async function* processChunk(
    chunk: StreamChunk,
  ): AsyncGenerator<StreamChunk> {
    if (chunk.type === 'text') {
      // Parse XML tool calls from the text stream
      const { filteredText, toolCalls, errors } = parseStreamChunk(
        chunk.text,
        xmlParserState,
      )

      emitParserErrors(errors)

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
        const toolCallId = `xml-${crypto.randomUUID()}`

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
    }

    yield chunk
  }

  let result: PromptResult<string | null> = { aborted: false, value: null }
  while (true) {
    const { value, done } = await stream.next()
    if (done) {
      result = value
      break
    }
    yield* processChunk(value)
  }
  return result
}
