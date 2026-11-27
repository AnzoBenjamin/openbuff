import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  getInitialAgentState,
  type AgentState,
} from '@codebuff/common/types/session-state'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  clearAgentGeneratorCache,
  runProgrammaticStep,
} from '../run-programmatic-step'
import { mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { ParamsOf } from '@codebuff/common/types/function-params'

describe('programmatic generator execution (in-host-realm, NOT isolated)', () => {
  let mockAgentState: AgentState
  let mockParams: ParamsOf<typeof runProgrammaticStep>
  let mockTemplate: AgentTemplate
  let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

  beforeEach(() => {
    // Inject a deterministic id generator so identity ids are stable, replacing
    // the previous spyOn(crypto, 'randomUUID').
    agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
      sendAction: () => {},
      idGen: {
        uuid: () => 'mock-uuid-0000-0000-0000-000000000000',
        prefixedId: (prefix: string, separator = '-') =>
          `${prefix}${separator}mock-uuid-0000-0000-0000-000000000000`,
      },
    }

    clearAgentGeneratorCache()

    // Reuse common test data structure
    mockAgentState = {
      ...getInitialAgentState(),
      agentId: 'test-agent-123',
      agentType: 'test-vm-agent',
      runId:
        'test-run-id' as `${string}-${string}-${string}-${string}-${string}`,
      directCreditsUsed: 0,
      childRunIds: [],
    }

    // Base template structure - will be customized per test
    mockTemplate = {
      id: 'test-vm-agent',
      displayName: 'Test VM Agent',
      spawnerPrompt: 'Test VM isolation',
      model: 'anthropic/claude-4-sonnet-20250522',
      outputMode: 'structured_output',
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['set_output'],
      spawnableAgents: [],
      inputSchema: {},
      systemPrompt: '',
      instructionsPrompt: '',
      stepPrompt: '',

      handleSteps: '', // Will be set per test
    }

    // Common params structure
    mockParams = {
      ...agentRuntimeImpl,
      runId: 'test-run-id',
      ancestorRunIds: [],
      repoId: undefined,
      repoUrl: undefined,
      system: 'Test system prompt',
      agentState: mockAgentState,
      template: mockTemplate,
      prompt: 'Test prompt',
      toolCallParams: { testParam: 'value' },
      userId: 'test-user',
      userInputId: 'test-input',
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      onResponseChunk: () => {},
      onCostCalculated: async () => {},
      fileContext: mockFileContext,
      localAgentTemplates: {},
      stepsComplete: false,
      stepNumber: 1,
      signal: new AbortController().signal,
      tools: {},
    }
  })

  afterEach(() => {
    clearAgentGeneratorCache()
  })

  test('executes a string-based generator in the host realm', async () => {
    // Customize template for this test
    mockTemplate.handleSteps = `
      function* ({ agentState, prompt, params }) {
        yield {
          toolName: 'set_output',
          input: {
            message: 'Hello from the host realm!',
            prompt: prompt,
            agentId: agentState.agentId
          }
        }
      }
    `
    mockParams.template = mockTemplate
    mockParams.localAgentTemplates = { 'test-vm-agent': mockTemplate }

    const result = await runProgrammaticStep(mockParams)

    expect(result.agentState.output).toEqual({
      message: 'Hello from the host realm!',
      prompt: 'Test prompt',
      agentId: 'test-agent-123',
    })
    expect(result.endTurn).toBe(true)
  })

  test('surfaces generator errors as agent output', async () => {
    // Customize for error test
    mockTemplate.id = 'test-vm-agent-error'
    mockTemplate.displayName = 'Test VM Agent Error'
    mockTemplate.spawnerPrompt = 'Test generator error handling'
    mockTemplate.toolNames = []
    mockTemplate.handleSteps = `
      function* ({ agentState, prompt, params }) {
        throw new Error('generator error test')
      }
    `

    mockAgentState.agentId = 'test-agent-error-123'
    mockAgentState.agentType = 'test-vm-agent-error'

    mockParams.template = mockTemplate
    mockParams.toolCallParams = {}
    mockParams.localAgentTemplates = { 'test-vm-agent-error': mockTemplate }

    const result = await runProgrammaticStep(mockParams)

    expect(result.endTurn).toBe(true)
    expect(result.agentState.output?.error).toContain(
      'Error executing handleSteps for agent test-vm-agent-error',
    )
  })

  // ORCH-2: This test DOCUMENTS the current (non-isolated) behavior. The string
  // handleSteps generator runs in the host realm via `new Function`, so host
  // globals ARE reachable from within it. When a real QuickJS/isolate sandbox
  // lands (ORCH-2 full fix), this test should be INVERTED to assert the host
  // global is NOT reachable from the generator.
  test('DOCUMENTS non-isolation: string generator can read a host global (NOT sandboxed)', async () => {
    try {
      // Set a unique marker on the host realm's globalThis before running.
      ;(globalThis as any).__orch2_probe = 'host-realm-visible'

      mockTemplate.id = 'test-vm-agent-probe'
      mockTemplate.displayName = 'Test VM Agent Probe'
      mockTemplate.spawnerPrompt = 'Test host-realm visibility'
      mockTemplate.handleSteps = `
        function* ({ agentState, prompt, params }) {
          yield {
            toolName: 'set_output',
            input: {
              probe: globalThis.__orch2_probe
            }
          }
        }
      `

      mockAgentState.agentId = 'test-agent-probe-123'
      mockAgentState.agentType = 'test-vm-agent-probe'

      mockParams.template = mockTemplate
      mockParams.localAgentTemplates = { 'test-vm-agent-probe': mockTemplate }

      const result = await runProgrammaticStep(mockParams)

      // Asserts the CURRENT (non-isolated) behavior: the host global IS visible.
      expect(result.agentState.output?.probe).toBe('host-realm-visible')
    } finally {
      delete (globalThis as any).__orch2_probe
    }
  })
})
