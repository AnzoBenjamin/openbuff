import { describe, expect, test, afterEach } from 'bun:test'

import {
  createOpenCodeGoResponsesFetch,
  transformOpenCodeGoResponsesRequestBody,
  transformResponsesJsonToChatCompletions,
} from '../impl/opencode-go-responses-fetch'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('opencode-go-responses-fetch', () => {
  test('moves system messages to instructions and chat messages to input', () => {
    const body = transformOpenCodeGoResponsesRequestBody({
      model: 'muse-spark-1.3-contributor',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
    })

    expect(body.model).toBe('muse-spark-1.3-contributor')
    expect(body.instructions).toBe('Be concise.')
    expect(body.store).toBe(false)
    expect(body).not.toHaveProperty('messages')
    expect(Array.isArray(body.input)).toBe(true)
    expect(body.input).toHaveLength(1)
  })

  test('preserves streaming mode and maps sampling fields', () => {
    const streamed = transformOpenCodeGoResponsesRequestBody({
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      reasoning_effort: 'high',
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: { name: 'read_files', parameters: { type: 'object' } },
        },
      ],
    })

    expect(streamed.stream).toBe(true)
    expect(streamed.max_output_tokens).toBe(100)
    expect(streamed.temperature).toBe(0.5)
    expect(streamed.top_p).toBe(0.9)
    expect(streamed.reasoning).toEqual({ effort: 'high' })
    expect(streamed.tool_choice).toBe('required')
    expect(streamed.tools).toHaveLength(1)

    const generated = transformOpenCodeGoResponsesRequestBody({
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(generated.stream).toBe(false)
  })

  test('converts Responses text output to a chat completion', () => {
    const converted = transformResponsesJsonToChatCompletions({
      id: 'resp-1',
      model: 'muse-spark-1.3-contributor',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    })

    expect(converted.choices).toEqual([
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello',
        },
        finish_reason: 'stop',
      },
    ])
    expect(converted.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    })
  })

  test('converts Responses function calls to chat tool calls', () => {
    const converted = transformResponsesJsonToChatCompletions({
      id: 'resp-2',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'read_files',
          arguments: '{"path":"a.ts"}',
        },
      ],
    })

    expect(converted.choices).toEqual([
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_files', arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ])
  })

  test('maps incomplete status to length finish reason', () => {
    const converted = transformResponsesJsonToChatCompletions({
      status: 'incomplete',
      output: [],
    })
    expect((converted.choices as Array<{ finish_reason: string }>)[0]
      .finish_reason).toBe('length')
  })

  test('fetch translates non-streaming JSON responses', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          id: 'resp-1',
          model: 'muse-spark-1.3-contributor',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const response = await createOpenCodeGoResponsesFetch()(
      'https://opencode.ai/zen/go/v1/responses',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'muse-spark-1.3-contributor',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      },
    )

    expect(capturedBody).not.toHaveProperty('messages')
    expect(capturedBody).toHaveProperty('input')
    const json = (await response.json()) as Record<string, unknown>
    expect(json.choices).toEqual([
      {
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      },
    ])
  })

  test('fetch translates streaming SSE responses', async () => {
    const encoder = new TextEncoder()
    const events = [
      'data: {"type":"response.created","response":{"id":"resp-1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ].join('')
    globalThis.fetch = (async () =>
      new Response(encoder.encode(events), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch

    const response = await createOpenCodeGoResponsesFetch()(
      'https://opencode.ai/zen/go/v1/responses',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'muse-spark-1.3-contributor',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      },
    )

    const text = await response.text()
    expect(text).toContain('"content":"hello"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('data: [DONE]')
  })

  test('fetch passes error responses through untouched', async () => {
    globalThis.fetch = (async () =>
      new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch

    const response = await createOpenCodeGoResponsesFetch()(
      'https://opencode.ai/zen/go/v1/responses',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'muse-spark-1.3-contributor',
          messages: [],
        }),
      },
    )

    expect(response.status).toBe(429)
    expect(await response.text()).toBe('quota exceeded')
  })

  test('drops a dangling tool call but keeps the answered one', () => {
    const body = transformOpenCodeGoResponsesRequestBody({
      model: 'm',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-live',
              type: 'function',
              function: { name: 'a', arguments: '{}' },
            },
            {
              id: 'call-dead',
              type: 'function',
              function: { name: 'b', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-live', content: 'ok' },
      ],
    })

    const input = body.input as Array<Record<string, unknown>>
    const calls = input.filter((item) => item.type === 'function_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ call_id: 'call-live', name: 'a' })
    const outputs = input.filter(
      (item) => item.type === 'function_call_output',
    )
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ call_id: 'call-live' })
  })

  test('drops an assistant message left with no live tool calls', () => {
    const body = transformOpenCodeGoResponsesRequestBody({
      model: 'm',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-dead',
              type: 'function',
              function: { name: 'b', arguments: '{}' },
            },
          ],
        },
        { role: 'user', content: 'next' },
      ],
    })

    const input = body.input as Array<Record<string, unknown>>
    expect(
      input.some((item) => item.type === 'function_call'),
    ).toBe(false)
    expect(input).toHaveLength(2)
  })

  test('drops an orphan tool output with no preceding tool call', () => {
    const body = transformOpenCodeGoResponsesRequestBody({
      model: 'm',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'tool', tool_call_id: 'call-ghost', content: 'x' },
      ],
    })

    const input = body.input as Array<Record<string, unknown>>
    expect(
      input.some((item) => item.type === 'function_call_output'),
    ).toBe(false)
    expect(input).toHaveLength(1)
  })

  test('keeps fully paired tool history untouched', () => {
    const body = transformOpenCodeGoResponsesRequestBody({
      model: 'm',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'a', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
      ],
    })

    const input = body.input as Array<Record<string, unknown>>
    expect(input.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
    ])
  })

  test('streaming assigns a deterministic id when the item has none', async () => {
    const encoder = new TextEncoder()
    const events = [
      'data: {"type":"response.created","response":{}}\n\n',
      'data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","name":"read_files"}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ].join('')
    globalThis.fetch = (async () =>
      new Response(encoder.encode(events), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch

    const response = await createOpenCodeGoResponsesFetch()(
      'https://opencode.ai/zen/go/v1/responses',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'muse-spark-1.3-contributor',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      },
    )

    const text = await response.text()
    expect(text).toContain('"id":"resp-call-2"')
    expect(text).toContain('"finish_reason":"tool_calls"')
  })
})
