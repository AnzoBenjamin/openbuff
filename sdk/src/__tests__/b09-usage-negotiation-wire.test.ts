import { expect, test } from 'bun:test'
import { tool, jsonSchema } from 'ai'
import { promptAiSdkStream } from '../impl/llm'
import { providerContextFor, silentLogger } from './fixtures/fake-llm-server'
import { userMessage } from '@codebuff/common/util/messages'
import type { PrintModeUsage } from '@codebuff/common/types/print-mode'

for (const includeUsage of [true, false, undefined])
  test(`configured stream usage negotiation=${includeUsage} preserves real tool completion and late usage policy`, async () => {
    const requests: Record<string, unknown>[] = [],
      costs: number[] = [],
      events: PrintModeUsage[] = [],
      chunks: unknown[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>
        requests.push(body)
        const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
        const negotiated =
          (body.stream_options as { include_usage?: unknown } | undefined)
            ?.include_usage === true
        return new Response(
          data({
            id: 'call-wire',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tool-1',
                      type: 'function',
                      function: { name: 'inspect', arguments: '{}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
            data({
              id: 'call-wire',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            }) +
            (negotiated
              ? data({
                  id: 'call-wire',
                  choices: [],
                  usage: {
                    prompt_tokens: 20000,
                    completion_tokens: 10000,
                    total_tokens: 30000,
                  },
                })
              : '') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const { context, cleanup } = providerContextFor({
      defaultModel: 'fixture/model',
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          models: ['model'],
          compatibility: {
            ...(includeUsage === undefined ? {} : { includeUsage }),
          },
          defaultCapabilities: {
            pricing: {
              inputPerMillionTokens: 3,
              outputPerMillionTokens: 15,
              currency: 'USD',
            },
          },
        },
      },
    })
    try {
      for await (const chunk of promptAiSdkStream(
        {
          apiKey: 'fixture',
          runId: 'usage-negotiation',
          clientSessionId: 'usage-negotiation',
          fingerprintId: 'usage-negotiation',
          userInputId: 'usage-negotiation',
          agentId: 'fixture',
          userId: undefined,
          messages: [userMessage({ content: 'Inspect once.' })],
          tools: {
            inspect: tool({
              inputSchema: jsonSchema({ type: 'object', properties: {} }),
            }),
          },
          signal: new AbortController().signal,
          logger: silentLogger,
          trackEvent() {},
          maxRetries: 0,
          sendAction({ action }) {
            if (
              action.type === 'response-chunk' &&
              typeof action.chunk !== 'string' &&
              action.chunk.type === 'usage'
            )
              events.push(action.chunk)
          },
          onCostCalculated: async (cost) => {
            costs.push(cost)
          },
        } as Parameters<typeof promptAiSdkStream>[0],
        { providerContext: context },
      ))
        chunks.push(chunk)
      expect(requests).toHaveLength(1)
      expect(
        chunks.filter(
          (chunk) => (chunk as { type: string }).type === 'tool-call',
        ),
      ).toHaveLength(1)
      if (includeUsage === true) {
        expect(requests[0].stream_options).toEqual({ include_usage: true })
        expect(costs).toEqual([21])
        expect(events[0]).toMatchObject({
          inputTokens: 20000,
          outputTokens: 10000,
          complete: true,
          costStatus: 'estimated',
          costCents: 21,
        })
      } else {
        expect(requests[0]).not.toHaveProperty('stream_options')
        expect(costs).toEqual([])
        expect(events[0]).toMatchObject({
          complete: false,
          costStatus: 'unknown',
        })
      }
    } finally {
      cleanup()
      server.stop(true)
    }
  })
