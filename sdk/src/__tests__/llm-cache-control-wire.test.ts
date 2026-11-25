/**
 * N01 wire test: prompt-cache markers on the streaming agent loop.
 *
 * Drives the real `promptAiSdkStream` and the real model builders against a
 * local fake provider (`fixtures/fake-llm-server.ts`) and inspects the request
 * bodies on the wire. Before N01 the streaming path sent no markers for any
 * route (providers-sdk-01, verification/runtime.md item 7).
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import { jsonSchema, tool } from 'ai'
import type { ToolSet } from 'ai'

import { getModelVisibleSpawnableAgents } from '@codebuff/agent-runtime/templates/prompts'
import { getToolSet } from '@codebuff/agent-runtime/tools/prompts'
import { getEffectiveAgentToolNames } from '@codebuff/agent-runtime/util/agent-tool-names'

import {
  assistantMessage,
  systemMessage,
  userMessage,
} from '@codebuff/common/util/messages'

import {
  promptAiSdkStream,
  withToolsCacheBreakpoint,
} from '../impl/llm'
import { getModelForRequest } from '../impl/model-provider'
import {
  OPENBUFF_PROVIDER_PRESETS,
  providerConfigFileSchema,
  resolveConfiguredProviderModelMetadata,
} from '../provider-config'
import { createBase2 } from '../../../agents/base2/base2'
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
  tools?: ToolSet
  cacheControlToolBreakpoint?: string
  onUsage?: (usage: {
    inputTokens: number
    cachedInputTokens: number
    cacheUsageComplete?: boolean
  }) => void
}) {
  const chunks: unknown[] = []
  for await (const chunk of promptAiSdkStream(
    {
      apiKey: 'fixture-key', runId: 'n01', clientSessionId: 'n01', fingerprintId: 'n01', userInputId: 'n01',
      userId: undefined, agentId: 'fixture', model: params.model,
      messages: params.messages,
      tools: params.tools ?? tools,
      cacheControlToolBreakpoint: params.cacheControlToolBreakpoint,
      includeCacheControl: true,
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

async function base2ProviderTools(template: ReturnType<typeof createBase2>) {
  return getToolSet({
    toolNames: getEffectiveAgentToolNames(template, { unlockedToolTiers: [] }),
    additionalToolDefinitions: async () => ({}),
    agentTools: {},
    skills: {},
    spawnableAgentTypes: getModelVisibleSpawnableAgents(
      template.spawnableAgents ?? [],
    ),
  })
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
    const usageReports: Array<{
      inputTokens: number
      cachedInputTokens: number
      cacheUsageComplete?: boolean
    }> = []
    await runStream({
      deps: { providerContext },
      messages: agentHistory(`You are a coding agent. ${big}`, 2),
      onUsage: (usage) => usageReports.push(usage),
    })

    expect(server.requests).toHaveLength(1)
    expect(usageReports).toHaveLength(1)
    expect(usageReports[0]).toMatchObject({
      inputTokens: expect.any(Number),
      cachedInputTokens: 0,
      cacheUsageComplete: true,
    })
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

  test('OpenRouter marks the shared base2 plan/execute tool prefix', async () => {
    server = startFakeLlmServer()
    const deps = openRouterDeps(server.baseURL)
    const plan = createBase2('default', { planOnly: true })
    const execute = createBase2('default', { executePlan: true })
    const [planTools, executeTools] = await Promise.all([
      base2ProviderTools(plan),
      base2ProviderTools(execute),
    ])
    const breakpoint = plan.programmaticConfig?.cacheControlToolBreakpoint

    if (typeof breakpoint !== 'string') {
      throw new Error('Expected base2 to configure a cache breakpoint')
    }
    expect(execute.programmaticConfig?.cacheControlToolBreakpoint).toBe(
      breakpoint,
    )
    await runStream({
      deps,
      messages: agentHistory('Plan-only instructions.', 0),
      tools: planTools,
      cacheControlToolBreakpoint: breakpoint,
    })
    await runStream({
      deps,
      messages: agentHistory('Execute-plan instructions.', 0),
      tools: executeTools,
      cacheControlToolBreakpoint: breakpoint,
    })

    const planDefinitions = server.requests[0]!.body.tools as Array<
      Record<string, unknown>
    >
    const executeDefinitions = server.requests[1]!.body.tools as Array<
      Record<string, unknown>
    >
    const toolName = (definition: Record<string, unknown>) =>
      (definition.function as Record<string, unknown>).name
    const breakpointIndex = planDefinitions.findIndex(
      (definition) => toolName(definition) === breakpoint,
    )
    const spawnIndex = planDefinitions.findIndex(
      (definition) => toolName(definition) === 'spawn_agents',
    )

    expect(breakpointIndex).toBeGreaterThanOrEqual(0)
    expect(planDefinitions[breakpointIndex]?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(executeDefinitions[breakpointIndex]?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(
      planDefinitions
        .filter((_, index) => index !== breakpointIndex)
        .every((definition) => definition.cache_control === undefined),
    ).toBe(true)
    expect(spawnIndex).toBeGreaterThan(breakpointIndex)
    expect(planDefinitions.slice(0, breakpointIndex + 1)).toEqual(
      executeDefinitions.slice(0, breakpointIndex + 1),
    )
    expect(planDefinitions[spawnIndex]).not.toEqual(
      executeDefinitions[spawnIndex],
    )
  })

  test('strict OpenAI-compatible routes get no markers', async () => {
    server = startFakeLlmServer()
    const providerContext = contextFor({
      defaultModel: 'local/strict-model',
      providers: { local: { type: 'openai-compatible', baseURL: `${server.baseURL}/v1`, models: ['strict-model'] } },
    })
    const usageReports: Array<{ cacheUsageComplete?: boolean }> = []
    await runStream({
      deps: { providerContext },
      messages: agentHistory(`You are a coding agent. ${big}`, 2),
      onUsage: (usage) => usageReports.push(usage),
    })
    // The OpenRouter preset's non-Anthropic model keeps the strict default.
    await runStream({
      deps: openRouterDeps(server.baseURL, 'openrouter/openai/gpt-4.1-mini'),
      messages: agentHistory(`You are a coding agent. ${big}`, 2),
    })

    expect(server.requests).toHaveLength(2)
    expect(usageReports).toHaveLength(1)
    expect(usageReports[0]?.cacheUsageComplete).toBe(false)
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
    const reported: Array<{ cachedInputTokens: number; cacheUsageComplete?: boolean }> = []
    // Each step appends the previous step's assistant reply and a new user
    // message, as the agent loop does.
    const history: Message[] = [systemMessage(system), userMessage({ content: `task ${big}`, tags: ['USER_PROMPT'] })]
    for (let step = 1; step <= 10; step++) {
      await runStream({
        deps: { providerContext },
        messages: [...history],
        onUsage: (usage) =>
          reported.push({
            cachedInputTokens: usage.cachedInputTokens,
            cacheUsageComplete: usage.cacheUsageComplete,
          }),
      })
      history.push(assistantMessage(`step ${step} done`))
      history.push(userMessage({ content: `tool result for step ${step}`, tags: ['STEP_PROMPT'] }))
    }

    expect(server.cacheReads).toHaveLength(10)
    expect(reported.map((usage) => usage.cachedInputTokens)).toEqual(
      server.cacheReads,
    )
    expect(reported[0]).toMatchObject({
      cachedInputTokens: 0,
      cacheUsageComplete: true,
    })
    for (const usage of reported.slice(1)) {
      expect(usage.cachedInputTokens).toBeGreaterThan(0)
      expect(usage.cacheUsageComplete).toBe(true)
    }
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

  test('reuses a fixed shared tool-prefix breakpoint across mode-specific suffixes', async () => {
    server = startFakeLlmServer()
    const providerContext = contextFor({
      defaultModel: 'fakeanth/claude-fake',
      providers: { fakeanth: { type: 'anthropic-compatible', baseURL: server.baseURL, models: ['claude-fake'] } },
    })
    const planTools = {
      ...tools,
      update_plan_status: tool({
        description: 'Update the active plan status.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { status: { type: 'string' } },
        }),
      }),
    }
    const executeTools = {
      ...tools,
      write_file: tool({
        description: 'Write a file.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { path: { type: 'string' } },
        }),
      }),
    }

    await runStream({
      deps: { providerContext },
      messages: agentHistory('Plan-only instructions.', 0),
      tools: planTools,
      cacheControlToolBreakpoint: 'code_search',
    })
    await runStream({
      deps: { providerContext },
      messages: agentHistory('Execute-plan instructions.', 0),
      tools: executeTools,
      cacheControlToolBreakpoint: 'code_search',
    })

    expect(server.requests).toHaveLength(2)
    const planToolDefinitions = server.requests[0]!.body.tools as Array<
      Record<string, unknown>
    >
    const executeToolDefinitions = server.requests[1]!.body.tools as Array<
      Record<string, unknown>
    >
    expect(planToolDefinitions.slice(0, 2)).toEqual(
      executeToolDefinitions.slice(0, 2),
    )
    expect(planToolDefinitions).not.toEqual(executeToolDefinitions)
    expect(server.cacheReads[1]).toBeGreaterThan(0)
  })

  test('base2 plan and execute reuse only their identical marked provider-schema prefix', async () => {
    server = startFakeLlmServer()
    const providerContext = contextFor({
      defaultModel: 'fakeanth/claude-fake',
      providers: {
        fakeanth: {
          type: 'anthropic-compatible',
          baseURL: server.baseURL,
          models: ['claude-fake'],
        },
      },
    })
    const plan = createBase2('default', { planOnly: true })
    const execute = createBase2('default', { executePlan: true })
    const [planTools, executeTools] = await Promise.all([
      base2ProviderTools(plan),
      base2ProviderTools(execute),
    ])
    const planBreakpoint = plan.programmaticConfig?.cacheControlToolBreakpoint
    const executeBreakpoint =
      execute.programmaticConfig?.cacheControlToolBreakpoint

    expect(typeof planBreakpoint).toBe('string')
    expect(executeBreakpoint).toBe(planBreakpoint)
    await runStream({
      deps: { providerContext },
      messages: agentHistory('Plan-only instructions.', 0),
      tools: planTools,
      cacheControlToolBreakpoint: planBreakpoint as string,
    })
    await runStream({
      deps: { providerContext },
      messages: agentHistory('Execute-plan instructions.', 0),
      tools: executeTools,
      cacheControlToolBreakpoint: executeBreakpoint as string,
    })

    expect(server.requests).toHaveLength(2)
    const planDefinitions = server.requests[0]!.body.tools as Array<
      Record<string, unknown>
    >
    const executeDefinitions = server.requests[1]!.body.tools as Array<
      Record<string, unknown>
    >
    const breakpointIndex = planDefinitions.findIndex(
      (definition) => definition.name === planBreakpoint,
    )
    const spawnIndex = planDefinitions.findIndex(
      (definition) => definition.name === 'spawn_agents',
    )

    expect(breakpointIndex).toBeGreaterThanOrEqual(0)
    expect(spawnIndex).toBeGreaterThan(breakpointIndex)
    expect(planDefinitions[breakpointIndex]?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(executeDefinitions[breakpointIndex]?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(planDefinitions.slice(0, breakpointIndex + 1)).toEqual(
      executeDefinitions.slice(0, breakpointIndex + 1),
    )
    expect(planDefinitions[spawnIndex]).not.toEqual(
      executeDefinitions[spawnIndex],
    )

    const hashPrefix = (definitions: Array<Record<string, unknown>>) =>
      createHash('sha256')
        .update(JSON.stringify(definitions.slice(0, breakpointIndex + 1)))
        .digest('hex')
    const planPrefixHash = hashPrefix(planDefinitions)
    expect(hashPrefix(executeDefinitions)).toBe(planPrefixHash)
    expect(server.cacheReads[1]).toBeGreaterThan(0)

    const firstSharedToolName = planDefinitions[0]?.name
    expect(typeof firstSharedToolName).toBe('string')
    if (typeof firstSharedToolName !== 'string') {
      throw new Error('Expected a tool in the shared provider-schema prefix')
    }
    const firstSharedTool = planTools[firstSharedToolName]
    expect(firstSharedTool).toBeDefined()
    const changedPlanTools = {
      ...planTools,
      [firstSharedToolName]: {
        ...firstSharedTool,
        inputSchema: jsonSchema({
          type: 'object',
          properties: { cacheMissControl: { type: 'string' } },
        }),
      },
    }
    await runStream({
      deps: { providerContext },
      messages: agentHistory('Plan-only instructions.', 0),
      tools: changedPlanTools,
      cacheControlToolBreakpoint: planBreakpoint as string,
    })

    const changedDefinitions = server.requests[2]!.body.tools as Array<
      Record<string, unknown>
    >
    expect(hashPrefix(changedDefinitions)).not.toBe(planPrefixHash)
    expect(server.cacheReads[2]).toBe(0)
  })

  test('does not move a missing configured breakpoint to a later tool', () => {
    expect(withToolsCacheBreakpoint(tools, 'missing_shared_tool')).toBe(tools)
  })
})
