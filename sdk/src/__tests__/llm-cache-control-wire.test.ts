/**
 * N01 wire test: prompt-cache markers on the streaming agent loop.
 *
 * Drives the real `promptAiSdkStream` and the real model builders against a
 * local fake provider (`fixtures/fake-llm-server.ts`) and inspects the request
 * bodies on the wire. Before N01 the streaming path sent no markers for any
 * route (providers-sdk-01, verification/runtime.md item 7).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { jsonSchema, tool } from 'ai'

import {
  assistantMessage,
  systemMessage,
  userMessage,
} from '@codebuff/common/util/messages'

import { promptAiSdkStream } from '../impl/llm'
import { getModelForRequest } from '../impl/model-provider'
import {
  OPENBUFF_PROVIDER_PRESETS,
  providerConfigFileSchema,
  resolveConfiguredProviderModelMetadata,
} from '../provider-config'
import {
  providerContextFor,
  silentLogger,
  startFakeLlmServer,
} from './fixtures/fake-llm-server'

import type { FakeLlmServer } from './fixtures/fake-llm-server'
import type { LlmHostDeps } from '../impl/llm'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const big = 'stable project context line. '.repeat(400)

const tools = {
  read_files: tool({
    description: 'Read files from the project.',
    inputSchema: jsonSchema({ type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } }),
  }),
  code_search: tool({
    description: 'Search the codebase.',
    inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' } } }),
  }),
}

function agentHistory(system: string, turns: number): Message[] {
  const messages: Message[] = [systemMessage(system)]
  for (let turn = 0; turn < turns; turn++) {
    messages.push(userMessage({ content: `step ${turn} context ${big}` }))
    messages.push(assistantMessage(`done step ${turn}`))
  }
  messages.push(userMessage({ content: 'now do the task', tags: ['USER_PROMPT'] }))
  return messages
}

async function runStream(params: {
  deps: LlmHostDeps
  messages: Message[]
  model?: string
  onUsage?: (usage: { cachedInputTokens: number }) => void
}) {
  const chunks: unknown[] = []
  for await (const chunk of promptAiSdkStream(
    {
      apiKey: 'fixture-key', runId: 'n01', clientSessionId: 'n01', fingerprintId: 'n01', userInputId: 'n01',
      userId: undefined, agentId: 'fixture', model: params.model,
      messages: params.messages, tools, includeCacheControl: true,
      signal: new AbortController().signal, maxRetries: 0,
      logger: silentLogger, trackEvent() {}, sendAction() {},
      onCacheDebugUsageReceived: params.onUsage,
    } as never,
    params.deps,
  )) chunks.push(chunk)
  return chunks
}

const count = (text: string) => (text.match(/cache_control/g) ?? []).length

let server: FakeLlmServer | undefined
const cleanups: Array<() => void> = []
afterEach(() => {
  server?.stop()
  server = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function contextFor(config: unknown) {
  const { context, cleanup } = providerContextFor(config)
  cleanups.push(cleanup)
  return context
}

/** The shipped OpenRouter preset, parsed exactly as a user config would be. */
const openRouterPreset = {
  sourceFilePaths: [],
  config: providerConfigFileSchema.parse(OPENBUFF_PROVIDER_PRESETS.openrouter.config),
}

/**
 * The OpenRouter preset points at https://openrouter.ai. The fake server
 * stands in for it: the model is built by the real `getModelForRequest` for a
 * local `openrouter` provider, and the compatibility is the one the real
 * preset route resolves to.
 */
function openRouterDeps(
  baseURL: string,
  defaultModel = 'openrouter/anthropic/claude-sonnet-4.5',
): LlmHostDeps {
  const providerContext = contextFor({
    defaultModel,
    providers: {
      openrouter: {
        type: 'openai-compatible',
        baseURL: `${baseURL}/api/v1`,
        models: OPENBUFF_PROVIDER_PRESETS.openrouter.config.providers.openrouter.models,
      },
    },
  })
  return {
    providerContext,
    getModel: async (params) => {
      const built = await getModelForRequest(params)
      const presetRoute = resolveConfiguredProviderModelMetadata({
        model: built.effectiveModel,
        loadedConfig: openRouterPreset,
      })
      if (!presetRoute) throw new Error(`preset has no route for ${built.effectiveModel}`)
      return { ...built, compatibility: presetRoute.compatibility }
    },
  }
}

describe('N01: streaming request carries prompt-cache markers', () => {
  test('anthropic-compatible: system, tools and last-user breakpoints', async () => {
    server = startFakeLlmServer()
    const providerContext = contextFor({
      defaultModel: 'fakeanth/claude-fake',
      providers: { fakeanth: { type: 'anthropic-compatible', baseURL: server.baseURL, models: ['claude-fake'] } },
    })
    await runStream({ deps: { providerContext }, messages: agentHistory(`You are a coding agent. ${big}`, 2) })

    expect(server.requests).toHaveLength(1)
    const { body, text } = server.requests[0]!
    const system = body.system as Array<Record<string, unknown>>
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    const sentTools = body.tools as Array<Record<string, unknown>>
    expect(sentTools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(sentTools.slice(0, -1).every((t) => t.cache_control === undefined)).toBe(true)
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const lastUser = messages.at(-1)!
    expect(lastUser.role).toBe('user')
    expect(lastUser.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    // Anthropic accepts at most four breakpoints per request.
    expect(count(text)).toBeGreaterThanOrEqual(3)
    expect(count(text)).toBeLessThanOrEqual(4)
  })

  test('OpenRouter preset, anthropic/* model: system and last-user content-part markers', async () => {
    server = startFakeLlmServer()
    await runStream({ deps: openRouterDeps(server.baseURL), messages: agentHistory(`You are a coding agent. ${big}`, 2) })

    expect(server.requests).toHaveLength(1)
    const { body, path } = server.requests[0]!
    expect(path).toBe('/api/v1/chat/completions')
    expect(body.model).toBe('anthropic/claude-sonnet-4.5')
    const messages = body.messages as Array<{ role: string; content: unknown }>
    // OpenRouter honours cache_control on content parts, so the system
    // prompt is sent as one text part that carries the marker.
    const system = messages[0] as { role: string; content: Array<Record<string, unknown>> }
    expect(system.role).toBe('system')
    expect(system.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    const lastUser = messages.at(-1) as { role: string; content: Array<Record<string, unknown>> }
    expect(lastUser.role).toBe('user')
    expect(lastUser.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('strict OpenAI-compatible routes get no markers', async () => {
    server = startFakeLlmServer()
    const providerContext = contextFor({
      defaultModel: 'local/strict-model',
      providers: { local: { type: 'openai-compatible', baseURL: `${server.baseURL}/v1`, models: ['strict-model'] } },
    })
    await runStream({ deps: { providerContext }, messages: agentHistory(`You are a coding agent. ${big}`, 2) })
    // The OpenRouter preset's non-Anthropic model keeps the strict default.
    await runStream({
      deps: openRouterDeps(server.baseURL, 'openrouter/openai/gpt-4.1-mini'),
      messages: agentHistory(`You are a coding agent. ${big}`, 2),
    })

    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]!.body.model).toBe('openai/gpt-4.1-mini')
    for (const request of server.requests) {
      expect(count(request.text)).toBe(0)
      expect(request.text).not.toContain('cacheControl')
    }
  })

  test('10-step agent loop reports cache-read tokens on steps 2-10', async () => {
    server = startFakeLlmServer()
    const providerContext = contextFor({
      defaultModel: 'fakeanth/claude-fake',
      providers: { fakeanth: { type: 'anthropic-compatible', baseURL: server.baseURL, models: ['claude-fake'] } },
    })
    const system = `You are a coding agent. ${big}`
    const reported: number[] = []
    // Each step appends the previous step's assistant reply and a new user
    // message, as the agent loop does.
    const history: Message[] = [systemMessage(system), userMessage({ content: `task ${big}`, tags: ['USER_PROMPT'] })]
    for (let step = 1; step <= 10; step++) {
      await runStream({
        deps: { providerContext },
        messages: [...history],
        onUsage: (usage) => reported.push(usage.cachedInputTokens),
      })
      history.push(assistantMessage(`step ${step} done`))
      history.push(userMessage({ content: `tool result for step ${step}`, tags: ['STEP_PROMPT'] }))
    }

    expect(server.cacheReads).toHaveLength(10)
    expect(reported).toEqual(server.cacheReads)
    expect(reported[0]).toBe(0)
    for (const cached of reported.slice(1)) expect(cached).toBeGreaterThan(0)
  })

  test('changing the system prompt (plan -> execute) keeps the cached tool prefix', async () => {
    server = startFakeLlmServer()
    const providerContext = contextFor({
      defaultModel: 'fakeanth/claude-fake',
      providers: { fakeanth: { type: 'anthropic-compatible', baseURL: server.baseURL, models: ['claude-fake'] } },
    })
    await runStream({ deps: { providerContext }, messages: agentHistory('You are in PLAN mode.', 0) })
    await runStream({ deps: { providerContext }, messages: agentHistory('You are in EXECUTE mode.', 0) })

    expect(server.requests).toHaveLength(2)
    const [plan, execute] = server.requests.map((r) => JSON.stringify(r.body.tools))
    expect(execute).toBe(plan)
    // The tools breakpoint is the only shared prefix; it is a cache hit.
    expect(server.cacheReads[1]).toBeGreaterThan(0)
  })
})
