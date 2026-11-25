import { expect, test } from 'bun:test'
import { promptAiSdkStream } from '../../../../sdk/src/impl/llm'
import {
  providerContextFor,
  silentLogger,
} from '../../../../sdk/src/__tests__/fixtures/fake-llm-server'
import { userMessage } from '@codebuff/common/util/messages'
import { useChatStore } from '../../state/chat-store'
import { createEventHandler } from '../../utils/sdk-event-handlers'
import { clearUsageObservations } from '../../utils/usage-observations'
import { formatUsageReport } from '../usage'
import type { EventHandlerState } from '../../utils/sdk-event-handlers'

test('real provider usage → CLI event handler → local /usage preserves token and fractional cost attribution', async () => {
  useChatStore.getState().reset()
  clearUsageObservations()
  const home = process.env.HOME,
    requests: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({
          id: 'usage-wire',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`
      return new Response(
        chunk({ role: 'assistant', content: 'ok' }, null) +
          chunk({}, 'stop', {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
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
        defaultCapabilities: {
          pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
        },
      },
    },
  })
  const handle = createEventHandler({
    message: { aiMessageId: 'actual-turn' },
  } as EventHandlerState)
  try {
    for await (const _chunk of promptAiSdkStream(
      {
        apiKey: 'fixture',
        runId: 'usage-wire-run',
        clientSessionId: 'usage-wire',
        fingerprintId: 'usage-wire',
        userInputId: 'usage-wire',
        agentId: 'agent',
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
            handle(action.chunk)
        },
      } as Parameters<typeof promptAiSdkStream>[0],
      { providerContext: context },
    )) {
    }
    const report = formatUsageReport()
    expect(requests).toHaveLength(1)
    expect(report).toContain('1 observed request usage events')
    expect(report).toContain('Input: 1')
    expect(report).toContain('Output: 1')
    expect(report).toContain('$0.000018')
    expect(report).toContain('fixture/model')
    expect(report).toContain('usage-wire-run')
    expect(process.env.HOME).toBe(home)
  } finally {
    cleanup()
    server.stop(true)
    clearUsageObservations()
    useChatStore.getState().reset()
  }
}, 10_000)
