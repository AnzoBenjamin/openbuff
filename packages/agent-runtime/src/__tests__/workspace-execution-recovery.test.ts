import { afterEach, describe, expect, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { advanceWorkspaceState } from '@codebuff/common/types/workspace-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { classifyActionOutput } from '@codebuff/common/util/action-outcomes'
import { processStream } from '../tools/stream-parser'
import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { applyHostWorkspaceState } from '../util/execution-recovery'
import {
  createMockStreamWithToolCalls,
  createToolCallChunk,
  mockFileContext,
} from './test-utils'
import type { AgentTemplate } from '../templates/types'
import type { AgentState } from '@codebuff/common/types/session-state'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'

const template: AgentTemplate = {
  id: 'workspace-recovery',
  displayName: 'Workspace recovery',
  spawnerPrompt: '',
  model: 'test-model',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['run_terminal_command', 'end_turn'],
  spawnableAgents: [],
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
}
const refused = (reason: 'stale-authority' | 'denied') => ({
  output: [
    {
      type: 'json' as const,
      value: {
        errorMessage: 'fixture refusal',
        executionRefusal: {
          ok: false as const,
          reason,
          cause: 'fixture refusal',
        },
      },
    },
  ],
})
function streamParams(
  state: AgentState,
  deps: Partial<AgentRuntimeDeps & AgentRuntimeScopedDeps> = {},
) {
  return {
    ...TEST_AGENT_RUNTIME_IMPL,
    ...deps,
    sendAction: () => {},
    agentContext: {},
    agentState: state,
    agentStepId: 'step',
    agentTemplate: template,
    ancestorRunIds: [],
    clientSessionId: 'session',
    fileContext: mockFileContext,
    fingerprintId: 'fixture',
    fullResponse: '',
    localAgentTemplates: { [template.id]: template },
    messages: [],
    prompt: '',
    repoId: undefined,
    repoUrl: undefined,
    runId: 'run',
    signal: new AbortController().signal,
    stream: createMockStreamWithToolCalls([
      {
        toolName: 'run_terminal_command',
        input: { command: 'git status --short' },
      },
    ]),
    system: '',
    tools: {},
    userId: 'user',
    userInputId: 'input',
    onCostCalculated: async () => {},
    onResponseChunk: () => {},
  }
}
afterEach(clearAgentGeneratorCache)

describe('host workspace and execution refusal recovery', () => {
  test('a child adopts host effects and remains current across successive terminal steps', async () => {
    const host = getInitialSessionState(mockFileContext).mainAgentState
    const child = structuredClone(host)
    child.agentId = 'child'
    let starts = 0
    for (let step = 0; step < 3; step++) {
      await processStream(
        streamParams(child, {
          synchronizeWorkspace: () => structuredClone(host.workspaceState),
          onExecutionActionStart: ({ identity }) => {
            expect(identity.workspaceSnapshotId).toBe(
              host.workspaceState!.snapshotId,
            )
            expect(identity.basis.workspaceRevision).toBe(
              host.workspaceState!.revision,
            )
          },
          requestToolCall: async () => {
            starts++
            host.workspaceState = advanceWorkspaceState(host.workspaceState, {
              source: 'host:started-command',
              actions: [{ action: 'unknown' }],
            })
            return {
              output: [
                {
                  type: 'json',
                  value: { stdout: '## main', stderr: '', exitCode: 0 },
                },
              ],
              workspaceState: structuredClone(host.workspaceState),
            }
          },
        }),
      )
      expect(child.workspaceState).toEqual(host.workspaceState)
    }
    expect(starts).toBe(3)
    expect(child.workspaceState!.revision).toBe(3)
  })

  test('pre-launch refusal cannot create synthetic workspace revisions', async () => {
    const state = getInitialSessionState(mockFileContext).mainAgentState
    const original = structuredClone(state.workspaceState)
    await processStream(
      streamParams(state, {
        synchronizeWorkspace: () => structuredClone(original),
        requestToolCall: async () => refused('stale-authority'),
      }),
    )
    expect(state.workspaceState).toEqual(original)
    expect(state.runOutcome).toBeUndefined()
    expect(state.actionOutcomes?.at(-1)).toMatchObject({
      outcome: 'refused',
      cause: { code: 'execution_stale-authority' },
    })
    expect(JSON.stringify(state.messageHistory)).toContain(
      're-verify the staged changes',
    )
  })

  test('synchronization revokes old read grants without changing captured action identities', () => {
    const state = getInitialSessionState(mockFileContext).mainAgentState
    state.readAuthorizationsByPath = { 'a.ts': true }
    state.readAuthorizationHashesByPath = { 'a.ts': 'old' }
    const next = advanceWorkspaceState(state.workspaceState, {
      source: 'sibling',
      actions: [{ action: 'unknown' }],
    })
    applyHostWorkspaceState(state, next)
    expect(state.readAuthorizationsByPath).toEqual({})
    expect(state.readAuthorizationHashesByPath).toEqual({})
  })

  test.each(['stale-authority', 'denied'] as const)(
    '%s ends the actual inference loop within its recovery budget',
    async (reason) => {
      const state = getInitialSessionState(mockFileContext).mainAgentState
      let generations = 0,
        requests = 0
      const result = await loopAgentSteps({
        ...TEST_AGENT_RUNTIME_IMPL,
        agentType: template.id,
        agentTemplate: template,
        localAgentTemplates: { [template.id]: template },
        agentState: state,
        prompt: 'Commit the owned changes',
        fileContext: mockFileContext,
        spawnParams: undefined,
        repoId: undefined,
        repoUrl: undefined,
        userInputId: 'input',
        userId: 'user',
        clientSessionId: 'session',
        fingerprintId: 'fixture',
        ancestorRunIds: [],
        signal: new AbortController().signal,
        onResponseChunk: () => {},
        synchronizeWorkspace: () => structuredClone(state.workspaceState),
        requestToolCall: async () => {
          requests++
          return refused(reason)
        },
        promptAiSdkStream: async function* () {
          generations++
          yield createToolCallChunk('run_terminal_command', {
            command: generations === 1 ? 'git commit -m fix' : 'git status',
          })
          return promptSuccess('message')
        },
      })
      expect(requests).toBe(reason === 'denied' ? 1 : 2)
      expect(generations).toBe(requests)
      expect(result.agentState.runOutcome).toMatchObject({
        termination: 'failed',
        cause: { code: `execution_${reason}`, message: 'fixture refusal' },
      })
      expect(result.output.type).toBe('error')
    },
  )

  test('a refused action without a workspace synchronization seam ends immediately', async () => {
    const state = getInitialSessionState(mockFileContext).mainAgentState
    await processStream(
      streamParams(state, {
        requestToolCall: async () => refused('stale-authority'),
      }),
    )
    expect(state.runOutcome?.termination).toBe('failed')
  })

  test('typed policy denial retains its reason, independently of command exit failures', () => {
    expect(
      classifyActionOutput('run_terminal_command', refused('denied').output),
    ).toMatchObject({ outcome: 'refused', cause: { code: 'execution_denied' } })
    expect(
      classifyActionOutput('run_terminal_command', [
        { type: 'json', value: { exitCode: 1 } },
      ]),
    ).toMatchObject({ outcome: 'failed', cause: { code: 'nonzero_exit' } })
  })
})
