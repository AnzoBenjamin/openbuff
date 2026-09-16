/**
 * Chat Completions <-> OpenAI Responses API translation for OpenCode Go
 * responses-only models (`.../zen/go/v1/responses`).
 *
 * Openbuff's provider stack speaks Chat Completions (`/chat/completions`)
 * and Anthropic Messages (`/messages`). Models in
 * `OPENCODE_GO_RESPONSES_MODELS` (e.g. `muse-spark-1.3-contributor`,
 * `grok-4.6`, `gpt-5.6-luna`) are only served on Go's `/responses`
 * endpoint, so this module translates in both directions:
 *
 * - Request: Chat Completions body -> Responses API body
 *   (`model`, `instructions`, `input`, `tools`, `tool_choice`, `stream`).
 *   Unlike the ChatGPT-backend translator, the `stream` flag is preserved
 *   so `doGenerate` (non-streaming JSON) and `doStream` (SSE) both work,
 *   and sampling params (`temperature`, `top_p`, `max_tokens`,
 *   `reasoning_effort`) pass through instead of being forced to
 *   backend-specific defaults.
 * - Response (streaming): Responses API SSE -> Chat Completions SSE via the
 *   battle-tested `transformResponseStream` shared with the Codex backend.
 * - Response (non-streaming): Responses JSON object -> Chat Completions
 *   JSON object so `OpenAICompatibleChatResponseSchema` validates.
 *
 * Source: https://opencode.ai/docs/go/#endpoints
 */

import {
  convertMessages,
  convertTools,
  transformResponseStream,
} from './chatgpt-backend-fetch'

import type { FetchFunction } from '@ai-sdk/provider-utils'

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

interface ChatCompletionsTool {
  type: string
  function?: {
    name: string
    description?: string
    parameters?: unknown
    strict?: boolean
  }
}

interface ChatCompletionsMessage {
  role: string
  content?: unknown
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/**
 * Convert a Chat Completions request body into an OpenAI Responses API
 * request body, preserving streaming mode and sampling params.
 */
export function transformOpenCodeGoResponsesRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = (body.messages ?? []) as ChatCompletionsMessage[]
  const tools = body.tools as ChatCompletionsTool[] | undefined

  // System messages become top-level `instructions`; the rest become `input`.
  const systemMessages = messages.filter((m) => m.role === 'system')
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')
  const instructions = systemMessages
    .map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    )
    .join('\n\n')

  const transformed: Record<string, unknown> = {
    model: body.model,
    ...(instructions ? { instructions } : {}),
    input: convertMessages(nonSystemMessages),
    // Preserve the caller's streaming mode: doGenerate sends no `stream`
    // flag (JSON response), doStream sends `stream: true` (SSE response).
    stream: body.stream === true,
    store: false,
  }

  if (tools?.length) {
    transformed.tools = convertTools(tools)
  }
  if (body.tool_choice != null) {
    transformed.tool_choice = body.tool_choice
  }

  // Responses API field names / passthrough sampling params.
  if (typeof body.max_tokens === 'number') {
    transformed.max_output_tokens = body.max_tokens
  }
  if (body.temperature != null) {
    transformed.temperature = body.temperature
  }
  if (body.top_p != null) {
    transformed.top_p = body.top_p
  }
  if (
    typeof body.reasoning_effort === 'string' &&
    body.reasoning_effort.length > 0
  ) {
    transformed.reasoning = { effort: body.reasoning_effort }
  }

  return transformed
}

interface ResponsesOutputItem {
  type?: string
  role?: string
  content?: Array<{ type?: string; text?: string }>
  call_id?: string
  id?: string
  name?: string
  arguments?: unknown
}

/**
 * Convert a non-streaming Responses API JSON object into a Chat Completions
 * JSON object matching `OpenAICompatibleChatResponseSchema`.
 */
export function transformResponsesJsonToChatCompletions(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const output = Array.isArray(body.output)
    ? (body.output as ResponsesOutputItem[])
    : []

  let text = ''
  const toolCalls: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }> = []

  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text
        }
      }
    } else if (item.type === 'function_call') {
      const id =
        typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string'
            ? item.id
            : `call_${toolCalls.length}`
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : '',
          arguments:
            typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? ''),
        },
      })
    }
  }

  const status = body.status as string | undefined
  let finishReason = 'stop'
  if (status === 'incomplete') {
    finishReason = 'length'
  } else if (toolCalls.length > 0) {
    finishReason = 'tool_calls'
  }

  const usage = body.usage as Record<string, unknown> | undefined

  return {
    ...(typeof body.id === 'string' ? { id: body.id } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
          },
        }
      : {}),
  }
}

/**
 * Fetch wrapper translating Chat Completions <-> Responses API for the
 * OpenCode Go `/responses` endpoint. Streaming (SSE) responses are
 * translated event-by-event; non-streaming (JSON) responses are converted
 * whole. Non-OK responses pass through untouched for the standard error
 * handler.
 */
export function createOpenCodeGoResponsesFetch(): FetchFunction {
  const fetchFn: FetchLike = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let transformedInit = init

    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        transformedInit = {
          ...init,
          body: JSON.stringify(transformOpenCodeGoResponsesRequestBody(body)),
        }
      } catch {
        // If the body can't be parsed, pass through unchanged.
      }
    }

    const response = await globalThis.fetch(input, transformedInit)

    if (!response.ok || !response.body) {
      return response
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const transformedStream = transformResponseStream(response.body)
      return new Response(transformedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers({
          'content-type': 'text/event-stream; charset=utf-8',
        }),
      })
    }

    // Non-streaming JSON response: convert the Responses object into a
    // Chat Completions object. Rebuild the response from the consumed text
    // in every path since the original body can only be read once.
    const text = await response.text()
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      return new Response(
        JSON.stringify(transformResponsesJsonToChatCompletions(json)),
        {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers({ 'content-type': 'application/json' }),
        },
      )
    } catch {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
  }

  return fetchFn as FetchFunction
}
