/**
 * N01 wire test: prompt-cache markers on the streaming agent loop.
 *
 * Drives the real `promptAiSdkStream` and the real model builders against a
 * local fake provider (`fixtures/fake-llm-server.ts`) and inspects the request
 * bodies on the wire. Before N01 the streaming path sent no markers for any
 * route (providers-sdk-01, verification/runtime.md item 7).
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
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

import plan from '../../../agents/base2/base2-plan'
import executePlan from '../../../agents/base2/base2-execute-plan'
import { createBase2 } from '../../../agents/base2/base2'
import { OpenbuffClient } from '../client'
import * as llm from '../impl/llm'
import { withToolsCacheBreakpoint } from '../impl/llm'
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

import type { CapturedRequest, FakeLlmServer } from './fixtures/fake-llm-server'
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
  for await (const chunk of llm.promptAiSdkStream(
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
    const provider = startFakeLlmServer()
    server = provider
    const { inputs } = contextFor({
      defaultModel: 'fakeanth/claude-fake',
      indexing: { enabled: false },
      providers: {
        fakeanth: {
          type: 'anthropic-compatible',
          baseURL: provider.baseURL,
          models: ['claude-fake'],
        },
      },
    }).snapshot
    const client = new OpenbuffClient({
      apiKey: 'fixture-key',
      cwd: inputs.projectRoot,
      projectFiles: {},
      knowledgeFiles: {},
      userKnowledgeFiles: {},
      repositoryIntelligence: false,
      harnessStateDir: join(inputs.projectRoot, '..', 'harness'),
      runTimeoutMs: 10_000,
      logger: silentLogger,
      handleEvent() {},
      hostConfiguration: {
        ...inputs,
        environment: {
          OPENBUFF_PROCESS_SUPERVISION: '0',
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
        },
      },
    })
    // A fresh greeting takes base2's real one-step path without a review gate.
    const prompt = 'Hello!'
    const runMode = async (agent: typeof plan | typeof executePlan) => {
      const before = provider.requests.length
      const result = await client.run({ agent, prompt })
      expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
        'completed',
      )
      expect(provider.requests).toHaveLength(before + 1)
      const request = provider.requests[before]!
      expect(request.path).toBe('/v1/messages')
      expect(request.body.model).toBe('claude-fake')
      return request
    }

    const planBreakpoint = plan.programmaticConfig?.cacheControlToolBreakpoint
    expect(typeof planBreakpoint).toBe('string')
    expect(executePlan.programmaticConfig?.cacheControlToolBreakpoint).toBe(
      planBreakpoint,
    )
    const planRequest = await runMode(plan)
    const executeRequest = await runMode(executePlan)
    const definitions = (request: CapturedRequest) =>
      request.body.tools as Array<Record<string, unknown>>
    const planDefinitions = definitions(planRequest)
    const executeDefinitions = definitions(executeRequest)
    const breakpointIndex = planDefinitions.findIndex(
      (definition) => definition.name === planBreakpoint,
    )
    const spawnIndex = (tools: Array<Record<string, unknown>>) =>
      tools.findIndex((definition) => definition.name === 'spawn_agents')

    expect(breakpointIndex).toBeGreaterThanOrEqual(0)
    for (const tools of [planDefinitions, executeDefinitions]) {
      expect(spawnIndex(tools)).toBeGreaterThan(breakpointIndex)
      expect(tools.filter((definition) => 'cache_control' in definition)).toEqual([
        expect.objectContaining({
          name: planBreakpoint,
          cache_control: { type: 'ephemeral' },
        }),
      ])
    }
    expect(planDefinitions.slice(breakpointIndex + 1)).not.toEqual(
      executeDefinitions.slice(breakpointIndex + 1),
    )
    expect(planDefinitions[spawnIndex(planDefinitions)]).not.toEqual(
      executeDefinitions[spawnIndex(executeDefinitions)],
    )
    const wirePrefix = (request: CapturedRequest) => {
      const tools = definitions(request)
      const encodedTools = `"tools":${JSON.stringify(tools)}`
      const start = request.text.indexOf(encodedTools)
      // Check the compact encoding against the raw request before slicing, so
      // key order and byte equality are tested, not just parsed schema equality.
      expect(start).toBeGreaterThanOrEqual(0)
      const end = JSON.stringify(tools.slice(0, breakpointIndex + 1)).length - 1
      const arrayStart = start + '"tools":'.length
      return request.text.slice(arrayStart, arrayStart + end)
    }
    const hash = (bytes: string) =>
      createHash('sha256').update(bytes, 'utf8').digest('hex')
    const planPrefix = wirePrefix(planRequest)
    const executePrefix = wirePrefix(executeRequest)
    const planPrefixHash = hash(planPrefix)
    expect(executePrefix).toBe(planPrefix)
    expect(hash(executePrefix)).toBe(planPrefixHash)

    // Inspect the shipped instructions as rendered by the runtime, not a
    // fixture-supplied mode banner. They travel as user-role content blocks.
    const instructions = (request: CapturedRequest) => {
      const messages = request.body.messages as Array<{
        role: string
        content: Array<{ type: string; text?: string }>
      }>
      return messages
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
    }
    const planInstructions = 'Plan mode must not edit project source or perform implementation work.'
    const executeInstructions = 'You are in EXECUTE_PLAN mode. Your job is to execute or resume durable plan artifacts, not merely revise them.'
    expect(instructions(planRequest)).toContain(planInstructions)
    expect(instructions(planRequest)).not.toContain(executeInstructions)
    expect(instructions(executeRequest)).toContain(executeInstructions)
    expect(instructions(executeRequest)).not.toContain(planInstructions)
    expect(provider.cacheReads[0]).toBe(0)
    expect(provider.cacheReads[1]).toBeGreaterThan(0)

    const firstSharedToolName = planDefinitions[0]?.name
    if (typeof firstSharedToolName !== 'string') {
      throw new Error('Expected a tool in the shared provider-schema prefix')
    }
    const changedSchema = {
      type: 'object',
      properties: { cacheMissControl: { type: 'string' } },
    } as const
    // Mutate only the negative control, before the real serializer/marker logic.
    // The generator, instructions, route, and loopback cache are unchanged.
    const stream = llm.promptAiSdkStream
    const changeSchema = spyOn(llm, 'promptAiSdkStream').mockImplementation(
      (params, deps) => {
        const tools = params.tools
        const original = tools?.[firstSharedToolName]
        if (!original) throw new Error('Expected the shared tool from base2')
        return stream({
          ...params,
          tools: {
            ...tools,
            [firstSharedToolName]: {
              ...original,
              inputSchema: jsonSchema(changedSchema),
            },
          },
        }, deps)
      },
    )
    let changedRequest: CapturedRequest
    try {
      changedRequest = await runMode(plan)
    } finally {
      changeSchema.mockRestore()
    }
    const changedDefinitions = definitions(changedRequest)
    expect(changedDefinitions).toEqual([
      { ...planDefinitions[0], input_schema: changedSchema },
      ...planDefinitions.slice(1),
    ])
    expect(instructions(changedRequest)).toContain(planInstructions)
    expect(hash(wirePrefix(changedRequest))).not.toBe(planPrefixHash)
    expect(provider.cacheReads).toHaveLength(3)
    expect(provider.cacheReads[2]).toBe(0)
  }, 35_000)

  test('does not move a missing configured breakpoint to a later tool', () => {
    expect(withToolsCacheBreakpoint(tools, 'missing_shared_tool')).toBe(tools)
  })
})
