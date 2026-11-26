import { test, expect } from 'bun:test'
import { promptAiSdkStream } from '../impl/llm'
import { providerContextFor, silentLogger } from './fixtures/fake-llm-server'
import { userMessage } from '@codebuff/common/util/messages'

for (const stripProviderMetadata of [false, true])
  test(`B09 real compatible late usage produces exactly21cents with metadata stripping=${stripProviderMetadata}`, async () => {
    const requests: unknown[] = [],
      costs: number[] = [],
      usage: unknown[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        requests.push(await req.json())
        const chunk = (choices: unknown[], usage?: unknown) =>
          `data: ${JSON.stringify({ id: 'b09', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices, ...(usage ? { usage } : {}) })}\n\n`
        return new Response(
          chunk([
            {
              index: 0,
              delta: { role: 'assistant', content: 'ok' },
              finish_reason: null,
            },
          ]) +
            chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
            chunk([], {
              prompt_tokens: 20000,
              completion_tokens: 10000,
              total_tokens: 30000,
            }) +
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
          compatibility: { stripProviderMetadata },
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
      for await (const _chunk of promptAiSdkStream(
        {
          apiKey: 'fixture',
          runId: 'b09',
          clientSessionId: 'b09',
          fingerprintId: 'b09',
          userInputId: 'b09',
          agentId: 'fixture',
          userId: undefined,
          messages: [userMessage({ content: 'hello' })],
          signal: new AbortController().signal,
          logger: silentLogger,
          trackEvent() {},
          sendAction({ action }) {
            if (
              action.type === 'response-chunk' &&
              typeof action.chunk !== 'string' &&
              action.chunk.type === 'usage'
            )
              usage.push(action.chunk)
          },
          onCostCalculated: async (cost) => {
            costs.push(cost)
          },
          maxRetries: 0,
        } as Parameters<typeof promptAiSdkStream>[0],
        { providerContext: context },
      )) {
      }
      expect(requests).toHaveLength(1)
      expect(costs).toEqual([21])
      expect(usage).toEqual([
        expect.objectContaining({
          complete: true,
          costStatus: 'estimated',
          costCents: 21,
          inputTokens: 20000,
          outputTokens: 10000,
        }),
      ])
    } finally {
      cleanup()
      server.stop(true)
    }
  })
