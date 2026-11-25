import { test, expect } from 'bun:test'
import { promptAiSdkStream } from '../impl/llm'
import {
  providerContextFor,
  silentLogger,
  startFakeLlmServer,
} from './fixtures/fake-llm-server'
import { userMessage } from '@codebuff/common/util/messages'

test('B09 actual unpriced usage stays explicitly unknown rather than reporting a free request', async () => {
  const server = startFakeLlmServer(),
    costs: number[] = [],
    usage: unknown[] = []
  const { context, cleanup } = providerContextFor({
    defaultModel: 'fixture/model',
    providers: {
      fixture: {
        type: 'openai-compatible',
        baseURL: `${server.baseURL}/v1`,
        models: ['model'],
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
    expect(server.requests).toHaveLength(1)
    expect(costs).toEqual([])
    expect(usage).toEqual([
      expect.objectContaining({
        complete: true,
        costStatus: 'unknown',
        costReason: expect.stringContaining('pricing'),
      }),
    ])
    expect(usage[0]).not.toHaveProperty('costCents', 0)
  } finally {
    cleanup()
    server.stop()
  }
})
