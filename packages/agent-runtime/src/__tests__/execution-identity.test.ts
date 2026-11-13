import { describe, expect, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import type { OnExecutionActionStart, RequestToolCallFn } from '@codebuff/common/types/contracts/client'
import { executeToolCall } from '../tools/tool-executor'
import { mockFileContext } from './test-utils'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'

function params(overrides: Partial<Parameters<typeof executeToolCall>[0]> = {}): Parameters<typeof executeToolCall>[0] {
  const state = getInitialSessionState(mockFileContext).mainAgentState
  state.runId = 'run-original'
  return {
    ...TEST_AGENT_RUNTIME_IMPL, toolName: 'run_terminal_command', input: { command: 'printf fixture' },
    agentContext: {}, agentState: state, agentStepId: 'step', ancestorRunIds: [],
    agentTemplate: { id: 'fixture', toolNames: ['run_terminal_command'], programmaticToolNames: [],
      spawnableAgents: [], mcpServers: {}, instructionsPrompt: '', systemPrompt: '', stepPrompt: '' },
    clientSessionId: 'session', fileContext: mockFileContext, fileProcessingState: { failedEditRequiresReadByPath: {} },
    fingerprintId: 'fingerprint', fullResponse: '', localAgentTemplates: {}, previousToolCallFinished: Promise.resolve(),
    prompt: undefined, repoId: undefined, repoUrl: undefined, runId: 'run-original', signal: new AbortController().signal,
    system: '', tools: {}, toolCallId: 'action-original', toolCalls: [], toolCallsToAddToMessageHistory: [],
    toolResults: [], toolResultsToAddToMessageHistory: [], userId: undefined, userInputId: 'input',
    fetch: globalThis.fetch, onCostCalculated: async () => {}, onResponseChunk: () => {}, ...overrides,
  } as Parameters<typeof executeToolCall>[0]
}

describe('B02 execution identity intake', () => {
  test('spawn action carries its original attempt through handlers into supervised request', async () => {
    const p = params()
    let start!: Parameters<OnExecutionActionStart>[0]
    let captured: SupervisedSpawnRequest | undefined
    const child = { ...p.agentTemplate, id: 'child', toolNames: [], inputSchema: {}, outputMode: 'last_message' as const }
    await executeToolCall({ ...p, toolName: 'spawn_agents', input: { agents: [{ agent_type: 'child', prompt: 'fixture' }] },
      executionHostOperation: { actor: { runId: 'old-run', rootRunId: 'old-run', agentId: 'old-agent' }, purpose: 'semantic-compaction' },
      agentTemplate: { ...p.agentTemplate, toolNames: ['spawn_agents'], spawnableAgents: ['child'] },
      localAgentTemplates: { child }, processSupervision: true,
      onExecutionActionStart: value => { start = value },
      spawnSupervised: async request => {
        captured = request
        return { outcome: 'crashed', crashReason: 'fixture-no-process', exitCode: 1, durationMs: 0,
          stdoutBytes: 0, killed: false, stderrTail: '' }
      },
    })
    expect(captured?.executionIdentity).toBe(start.identity)
    expect(captured?.executionIdentity?.basis).toEqual(p.agentState.actionOutcomes?.[0]?.basis)
    expect(captured?.child?.agentId).toBeString()
    expect(captured?.executionHostOperation).toBeUndefined()
  })

  test('registers original basis synchronously and waits for parent acknowledgement before tool setup', async () => {
    const starts: Parameters<OnExecutionActionStart>[0][] = [], requests: Parameters<RequestToolCallFn>[0][] = []
    const chunks: unknown[] = []
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const input = { command: 'printf fixture' }
    const p = params({ input, onExecutionActionStart: start => { starts.push(start); return barrier },
      onResponseChunk: chunk => { chunks.push(chunk) },
      requestToolCall: async request => { requests.push(request); return { output: [{ type: 'json', value: { exitCode: 0 } }] } } })
    const running = executeToolCall(p)
    expect(starts).toHaveLength(1)
    expect(requests).toHaveLength(0)
    expect(chunks).toHaveLength(0)
    expect(starts[0].identity.actionId).toBe('action-original')
    expect(starts[0].identity.basis.inputHash).toBe(hashActionInput('run_terminal_command', input))
    input.command = 'caller-mutated-after-start'
    release()
    await running
    expect(requests).toHaveLength(1)
    expect(requests[0].input.command).toBe('printf fixture')
    expect(requests[0].input.mode).toBe('assistant')
    expect(requests[0].input.permission_profile).toBe('full-access')
    expect(requests[0].executionRequestHash).toBe(hashActionInput('run_terminal_command', requests[0].input))
    expect(requests[0].executionRequestHash).not.toBe(starts[0].identity.basis.inputHash)
    expect(requests[0].executionIdentity).toBe(starts[0].identity)
    expect(p.agentState.actionOutcomes?.[0]?.basis).toEqual(starts[0].identity.basis)
    expect(p.agentState.actionOutcomes?.[0]?.attemptId).toBe(starts[0].identity.attemptId)
  })

  test('registration refusal retains the attempted basis and never dispatches', async () => {
    let calls = 0
    const p = params({ onExecutionActionStart: () => { throw new Error('registration refused') },
      requestToolCall: async () => { calls++; return { output: [] } } })
    await expect(executeToolCall(p)).rejects.toThrow('registration refused')
    expect(calls).toBe(0)
    expect(p.agentState.actionOutcomes?.[0]?.outcome).toBe('failed')
    expect(p.agentState.actionOutcomes?.[0]?.basis.inputHash).toBe(hashActionInput(p.toolName, p.input))
  })
})
