import { expect, test } from 'bun:test'

import type { PrintModeUsage } from '@codebuff/common/types/print-mode'
import { userMessage } from '@codebuff/common/util/messages'

import { promptAiSdkStream } from '../impl/llm'
import { providerContextFor, silentLogger } from './fixtures/fake-llm-server'

type CatalogRoute = {
  name: string
  providerType: 'openai-compatible' | 'anthropic-compatible'
  baseURL: string
  model: string
  expectedCostCents: number
  expectedContextTokens: number
}

const routes: CatalogRoute[] = [
  {
    name: 'OpenAI',
    providerType: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5.4-mini',
    expectedCostCents: 6,
    expectedContextTokens: 400_000,
  },
  {
    name: 'Anthropic',
    providerType: 'anthropic-compatible',
    baseURL: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    expectedCostCents: 21,
    expectedContextTokens: 200_000,
  },
  {
    name: 'OpenRouter',
    providerType: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-5.5',
    expectedCostCents: 14,
    expectedContextTokens: 1_000_000,
  },
]

function requestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const request = input instanceof Request ? input : new Request(input, init)
  return request.clone().json() as Promise<Record<string, unknown>>
}

function compatibleStream(): Response {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  return new Response(
    data({
      id: 'catalog-wire',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'ok' },
          finish_reason: null,
        },
      ],
    }) +
      data({
        id: 'catalog-wire',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      data({
        id: 'catalog-wire',
        choices: [],
        usage: {
          prompt_tokens: 20_000,
          completion_tokens: 10_000,
          total_tokens: 30_000,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }) +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function anthropicStream(): Response {
  const event = (type: string, value: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
  return new Response(
    event('message_start', {
      message: {
        id: 'catalog-wire',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 20_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        },
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
        usage: { output_tokens: 10_000 },
      }) +
      event('message_stop', {}),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

for (const route of routes) {
  test(`B09 ${route.name} exact catalog route reports nonzero usage cost without user pricing`, async () => {
    const originalFetch = globalThis.fetch
    const requests: Record<string, unknown>[] = []
    const costs: number[] = []
    const usages: PrintModeUsage[] = []
    const windows: Array<number | undefined> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await requestBody(input, init))
        return route.providerType === 'anthropic-compatible'
          ? anthropicStream()
          : compatibleStream()
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    const { context, cleanup } = providerContextFor({
      defaultModel: `fixture/${route.model}`,
      providers: {
        fixture: {
          type: route.providerType,
          baseURL: route.baseURL,
          models: [route.model],
        },
      },
    })
    try {
      for await (const _chunk of promptAiSdkStream(
        {
          apiKey: 'fixture',
          runId: `catalog-${route.name.toLowerCase()}`,
          clientSessionId: 'catalog-wire',
          fingerprintId: 'catalog-wire',
          userInputId: 'catalog-wire',
          agentId: 'fixture',
          userId: undefined,
          messages: [userMessage({ content: 'Say ok.' })],
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
              usages.push(action.chunk)
          },
          onModelContextResolved: (windowTokens) => {
            windows.push(windowTokens)
          },
          onCostCalculated: async (cost) => {
            costs.push(cost)
          },
        } as Parameters<typeof promptAiSdkStream>[0],
        { providerContext: context },
      )) {
      }

      expect(requests).toHaveLength(1)
      if (route.providerType === 'openai-compatible')
        expect(requests[0].stream_options).toEqual({ include_usage: true })
      expect(windows.length).toBeGreaterThan(0)
      expect(
        windows.every((value) => value === route.expectedContextTokens),
      ).toBe(true)
      expect(costs).toEqual([route.expectedCostCents])
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({
        inputTokens: 20_000,
        outputTokens: 10_000,
        totalTokens: 30_000,
        complete: true,
        costStatus: 'estimated',
        costCents: route.expectedCostCents,
      })
    } finally {
      cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

test('B09 canonical includeUsage false remains an explicit opt-out', async () => {
  const originalFetch = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  const costs: number[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await requestBody(input, init))
      return compatibleStream()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  const { context, cleanup } = providerContextFor({
    defaultModel: 'fixture/gpt-5.4-mini',
    providers: {
      fixture: {
        type: 'openai-compatible',
        baseURL: 'https://api.openai.com/v1',
        models: ['gpt-5.4-mini'],
        compatibility: { includeUsage: false },
      },
    },
  })
  try {
    for await (const _chunk of promptAiSdkStream(
      {
        apiKey: 'fixture',
        runId: 'catalog-opt-out',
        clientSessionId: 'catalog-opt-out',
        fingerprintId: 'catalog-opt-out',
        userInputId: 'catalog-opt-out',
        agentId: 'fixture',
        userId: undefined,
        messages: [userMessage({ content: 'Say ok.' })],
        signal: new AbortController().signal,
        logger: silentLogger,
        trackEvent() {},
        maxRetries: 0,
        sendAction() {},
        onCostCalculated: async (cost) => {
          costs.push(cost)
        },
      } as Parameters<typeof promptAiSdkStream>[0],
      { providerContext: context },
    )) {
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toHaveProperty('stream_options')
    // An endpoint may still send unsolicited usage; Openbuff can account for
    // observed data even though it did not request the late-usage extension.
    expect(costs).toEqual([6])
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})
