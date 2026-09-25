import { describe, expect, test, mock, afterEach } from 'bun:test'

import {
  transformChatGptBackendRequestBody,
  transformResponseStream,
} from '../impl/chatgpt-backend-fetch'

// Feed recorded Responses-API SSE lines through transformResponseStream and
// parse the emitted chat-completions SSE chunks back into records.
async function runSseThroughTransform(
  events: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const encoded = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  const input = new Response(encoded).body!
  const transformed = transformResponseStream(input)
  const text = await new Response(transformed).text()
  return text
    .split('\n\n')
    .filter(
      (line) =>
        line.startsWith('data: ') && line.trim() !== 'data: [DONE]',
    )
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

function accumulateToolArgs(
  chunks: Record<string, unknown>[],
): Map<number, string> {
  const accumulated = new Map<number, string>()
  for (const chunk of chunks) {
    const delta = (chunk.choices as
      | Array<{ index: number; delta?: Record<string, unknown> }>
      | undefined)?.[0]?.delta
    const toolCalls = delta?.tool_calls as
      | Array<{ index: number; function?: { arguments?: string } }>
      | undefined
    for (const tc of toolCalls ?? []) {
      accumulated.set(
        tc.index,
        (accumulated.get(tc.index) ?? '') + (tc.function?.arguments ?? ''),
      )
    }
  }
  return accumulated
}

function functionCallAddedEvent(outputIndex = 0) {
  return {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      call_id: 'call-1',
      name: 'get_weather',
    },
  }
}

describe('chatgpt backend fetch transform', () => {
  test('defaults GPT/Codex reasoning effort to low for interactive agent tool loops', () => {
    const transformed = transformChatGptBackendRequestBody({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(transformed.reasoning).toEqual({ effort: 'low' })
  })

  test('preserves explicit reasoning effort from openai-compatible provider options', () => {
    const transformed = transformChatGptBackendRequestBody({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'high',
    })

    expect(transformed.reasoning).toEqual({ effort: 'high' })
  })
})

describe('chatgpt backend SSE transform - tool-call argument reassembly', () => {
  const originalConsoleDebug = console.debug

  afterEach(() => {
    console.debug = originalConsoleDebug
  })

  const suppressDebug = () => {
    console.debug = mock(() => {})
  }

  const argsDoneEvent = (args: string, outputIndex = 0) => ({
    type: 'response.function_call_arguments.done',
    output_index: outputIndex,
    arguments: args,
  })

  const argsDeltaEvent = (delta: string, outputIndex = 0) => ({
    type: 'response.function_call_arguments.delta',
    output_index: outputIndex,
    delta,
  })

  const completedEvent = {
    type: 'response.completed',
    response: {
      id: 'resp-1',
      model: 'gpt-5.5',
      status: 'completed',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  }

  test('matching done args emit only the not-yet-streamed tail', async () => {
    const chunks = await runSseThroughTransform([
      functionCallAddedEvent(),
      argsDeltaEvent('{"a":1'),
      argsDoneEvent('{"a":1,"b":2}'),
      completedEvent,
    ])

    const accumulated = accumulateToolArgs(chunks)
    expect(accumulated.get(0)).toBe('{"a":1,"b":2}')
  })

  test('identical repeated done args emit nothing extra', async () => {
    suppressDebug()
    const chunks = await runSseThroughTransform([
      functionCallAddedEvent(),
      argsDeltaEvent('{"a":1,"b":2}'),
      argsDoneEvent('{"a":1,"b":2}'),
      // Some providers re-emit the final args in output_item.done.
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'get_weather',
          arguments: '{"a":1,"b":2}',
        },
      },
      completedEvent,
    ])

    const accumulated = accumulateToolArgs(chunks)
    expect(accumulated.get(0)).toBe('{"a":1,"b":2}')
  })

  test('divergent done args do not append corrupted input; streamed prefix is kept', async () => {
    suppressDebug()
    const chunks = await runSseThroughTransform([
      functionCallAddedEvent(),
      argsDeltaEvent('{"a":1,'),
      // The authoritative done args were rewritten out of band and do not
      // extend the already-streamed accumulation.
      argsDoneEvent('{"a":9,"b":2}'),
      completedEvent,
    ])

    const accumulated = accumulateToolArgs(chunks)
    expect(accumulated.get(0)).toBe('{"a":1,')
  })

  test('output_item.done extends the streamed accumulation with only the tail', async () => {
    const chunks = await runSseThroughTransform([
      functionCallAddedEvent(),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'get_weather',
          arguments: '{"a":1,"b":2}',
        },
      },
      completedEvent,
    ])

    const accumulated = accumulateToolArgs(chunks)
    // No deltas were streamed beforehand, so the item's full args arrive
    // whole and the reassembled value is exactly the authoritative JSON.
    expect(accumulated.get(0)).toBe('{"a":1,"b":2}')
  })

  test('finish_reason tool_calls survives a good stream', async () => {
    const chunks = await runSseThroughTransform([
      functionCallAddedEvent(),
      argsDeltaEvent('{"a":1'),
      argsDoneEvent('{"a":1}'),
      completedEvent,
    ])

    const finishChunk = chunks.find((chunk) => {
      const choice = (chunk.choices as
        | Array<{ finish_reason?: string }>
        | undefined)?.[0]
      return choice?.finish_reason === 'tool_calls'
    })
    expect(finishChunk).toBeDefined()
  })
})
