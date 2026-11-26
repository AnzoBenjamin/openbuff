import { expect, test } from 'bun:test'
import { z } from 'zod'

import type { CacheDebugUsageData } from '@codebuff/common/types/contracts/llm'
import type { PrintModeUsage } from '@codebuff/common/types/print-mode'
import { userMessage } from '@codebuff/common/util/messages'

import {
  promptAiSdk,
  promptAiSdkStream,
  promptAiSdkStructured,
} from '../impl/llm'
import { providerContextFor, silentLogger } from './fixtures/fake-llm-server'

const pricing = {
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
  cachedInputPerMillionTokens: 0.3,
  cacheWriteInputPerMillionTokens: 3.75,
  currency: 'USD',
}

for (const pricedWrite of [true, false]) {
  test(`actual Anthropic stream keeps disjoint cache-read/write input buckets; write pricing=${pricedWrite}`, async () => {
    const requests: unknown[] = []
    const costs: number[] = []
    const events: PrintModeUsage[] = []
    const debug: CacheDebugUsageData[] = []
    const rawUsage = {
      input_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
      output_tokens: 0,
    }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push(await request.json())
        const event = (type: string, value: Record<string, unknown>) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
        return new Response(
          event('message_start', {
            message: {
              id: 'anth-cache',
              type: 'message',
              role: 'assistant',
              model: 'claude-fixture',
              content: [],
              stop_reason: null,
              usage: rawUsage,
            },
          }) +
            event('content_block_start', {
              index: 0,
              content_block: { type: 'text', text: '' },
            }) +
            event('content_block_delta', {
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            }) +
            event('content_block_stop', { index: 0 }) +
            event('message_delta', {
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 20 },
            }) +
            event('message_stop', {}),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const { context, cleanup } = providerContextFor({
      defaultModel: 'fixture/claude-fixture',
      providers: {
        fixture: {
          type: 'anthropic-compatible',
          baseURL: `http://127.0.0.1:${server.port}`,
          models: ['claude-fixture'],
          defaultCapabilities: {
            pricing: {
              inputPerMillionTokens: pricing.inputPerMillionTokens,
              outputPerMillionTokens: pricing.outputPerMillionTokens,
              cachedInputPerMillionTokens: pricing.cachedInputPerMillionTokens,
              currency: pricing.currency,
              ...(pricedWrite
                ? {
                    cacheWriteInputPerMillionTokens:
                      pricing.cacheWriteInputPerMillionTokens,
                  }
                : {}),
            },
          },
        },
      },
    })
    try {
      for await (const _chunk of promptAiSdkStream(
        {
          apiKey: 'fixture',
          runId: 'anth-cache',
          clientSessionId: 'anth-cache',
          fingerprintId: 'anth-cache',
          userInputId: 'anth-cache',
          agentId: 'fixture',
          userId: undefined,
          messages: [userMessage({ content: 'hello' })],
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
          onCacheDebugUsageReceived: (usage) => {
            debug.push(usage)
          },
          onCostCalculated: async (cost) => {
            costs.push(cost)
          },
        } as Parameters<typeof promptAiSdkStream>[0],
        { providerContext: context },
      )) {
      }
      expect(requests).toHaveLength(1)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        inputTokens: 1300,
        outputTokens: 20,
        cachedInputTokens: 1000,
        cacheWriteInputTokens: 200,
        totalTokens: 1320,
        complete: true,
      })
      expect(debug[0]).toMatchObject({
        inputTokens: 1300,
        cachedInputTokens: 1000,
        cacheWriteInputTokens: 200,
        inputTokensIncludesCache: true,
        cacheUsageComplete: true,
      })
      expect(costs).toEqual(pricedWrite ? [0.165] : [])
      expect(events[0].costStatus).toBe(pricedWrite ? 'estimated' : 'unknown')
    } finally {
      cleanup()
      server.stop(true)
    }
  })
}

test('actual Anthropic plain completion uses the same canonical cache-write accounting', async () => {
  const costs: number[] = []
  const debug: CacheDebugUsageData[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      await request.json()
      return Response.json({
        id: 'plain-anth',
        type: 'message',
        role: 'assistant',
        model: 'claude-fixture',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          output_tokens: 20,
        },
      })
    },
  })
  const { context, cleanup } = providerContextFor({
    defaultModel: 'fixture/claude-fixture',
    providers: {
      fixture: {
        type: 'anthropic-compatible',
        baseURL: `http://127.0.0.1:${server.port}`,
        models: ['claude-fixture'],
        defaultCapabilities: { pricing },
      },
    },
  })
  try {
    const result = await promptAiSdk(
      {
        apiKey: 'fixture',
        runId: 'plain',
        clientSessionId: 'plain',
        fingerprintId: 'plain',
        userInputId: 'plain',
        agentId: 'fixture',
        userId: undefined,
        messages: [userMessage({ content: 'hello' })],
        signal: new AbortController().signal,
        logger: silentLogger,
        trackEvent() {},
        sendAction() {},
        maxRetries: 0,
        onCacheDebugUsageReceived: (usage) => {
          debug.push(usage)
        },
        onCostCalculated: async (cost) => {
          costs.push(cost)
        },
      } as Parameters<typeof promptAiSdk>[0],
      { providerContext: context },
    )
    expect(result).toMatchObject({ aborted: false, value: 'ok' })
    expect(costs).toEqual([0.165])
    expect(debug[0]).toMatchObject({
      inputTokens: 1300,
      cachedInputTokens: 1000,
      cacheWriteInputTokens: 200,
      inputTokensIncludesCache: true,
    })
  } finally {
    cleanup()
    server.stop(true)
  }
})

test('actual Anthropic structured completion uses the same canonical cache-write accounting', async () => {
  const costs: number[] = []
  const debug: CacheDebugUsageData[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        tools?: Array<{ name?: string }>
      }
      const toolName = body.tools?.[0]?.name
      if (!toolName)
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'structured tool missing',
            },
          },
          { status: 400 },
        )
      return Response.json({
        id: 'structured-anth',
        type: 'message',
        role: 'assistant',
        model: 'claude-fixture',
        content: [
          {
            type: 'tool_use',
            id: 'structured-output',
            name: toolName,
            input: { answer: 'ok' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          output_tokens: 20,
        },
      })
    },
  })
  const { context, cleanup } = providerContextFor({
    defaultModel: 'fixture/claude-fixture',
    providers: {
      fixture: {
        type: 'anthropic-compatible',
        baseURL: `http://127.0.0.1:${server.port}`,
        models: ['claude-fixture'],
        defaultCapabilities: { pricing },
      },
    },
  })
  try {
    const result = await promptAiSdkStructured(
      {
        apiKey: 'fixture',
        runId: 'structured',
        clientSessionId: 'structured',
        fingerprintId: 'structured',
        userInputId: 'structured',
        agentId: 'fixture',
        userId: undefined,
        messages: [userMessage({ content: 'Return JSON.' })],
        schema: z.object({ answer: z.string() }),
        signal: new AbortController().signal,
        logger: silentLogger,
        trackEvent() {},
        sendAction() {},
        maxRetries: 0,
        onCacheDebugUsageReceived: (usage) => {
          debug.push(usage)
        },
        onCostCalculated: async (cost) => {
          costs.push(cost)
        },
      } as Parameters<typeof promptAiSdkStructured>[0],
      { providerContext: context },
    )
    expect(result).toEqual({ aborted: false, value: { answer: 'ok' } })
    expect(costs).toEqual([0.165])
    expect(debug[0]).toMatchObject({
      inputTokens: 1300,
      cachedInputTokens: 1000,
      cacheWriteInputTokens: 200,
      inputTokensIncludesCache: true,
      cacheUsageComplete: true,
    })
  } finally {
    cleanup()
    server.stop(true)
  }
})
