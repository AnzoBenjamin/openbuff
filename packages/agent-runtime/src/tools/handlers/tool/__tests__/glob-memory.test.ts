import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import * as discoveryCoordinator from '../../../../orchestration/discovery-coordinator'
import { handleGlob } from '../glob'

import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

function buildAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    ancestorRunIds: ['root-run'],
    runId: 'parent-run',
    agentId: 'parent-agent',
    ...overrides,
  } as AgentState
}

function buildToolCall(
  overrides: Partial<CodebuffToolCall<'glob'>['input']> = {},
): CodebuffToolCall<'glob'> {
  return {
    toolName: 'glob',
    toolCallId: 'tool-call-1',
    input: {
      pattern: '**/*',
      ...overrides,
    }
  } as CodebuffToolCall<'glob'>
}

function buildVerifiedState(
  paths: string[],
  extra: Partial<AgentState> = {},
  excerptOptions?: { workspaceRevision?: number },
): AgentState {
  return buildAgentState({
    memoryV2Context: {
      result: {
        verifiedKnowledge: [
          {
            verifiedEvidence: paths.map((path) => ({
              selector: { path },
              excerpt: `verified content of ${path}`,
              ...(excerptOptions?.workspaceRevision !== undefined
                ? { workspaceRevision: excerptOptions.workspaceRevision }
                : {}),
            })),
          },
        ],
      },
    },
    ...extra,
  } as unknown as Partial<AgentState>)
}

function buildOutput(): CodebuffToolOutput<'glob'> {
  return [
    {
      type: 'json',
      value: {
        files: ['src/auth/login.ts'],
        count: 1,
        message: 'Found 1 file(s) matching pattern',
      },
    },
  ] as unknown as CodebuffToolOutput<'glob'>
}

function invoke(params: {
  agentState?: AgentState
  output: CodebuffToolOutput<'glob'>
  toolCall?: CodebuffToolCall<'glob'>
  onClientCall?: (toolCall: ClientToolCall<'glob'>) => void
}): Promise<{ output: CodebuffToolOutput<'glob'> }> {
  const { agentState, output, toolCall, onClientCall } = params
  return handleGlob({
    previousToolCallFinished: Promise.resolve(),
    toolCall: toolCall ?? buildToolCall(),
    requestClientToolCall: async (clientToolCall: ClientToolCall<'glob'>) => {
      onClientCall?.(clientToolCall)
      return output
    },
    agentState,
  } as unknown as Parameters<typeof handleGlob>[0])
}

describe('handleGlob memory-first', () => {
  afterEach(() => {
    mock.restore()
  })

  test('skips the client call on full cover and serves a receipt output', async () => {
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({ cwd: 'src/auth/login.ts' })
    let clientCalls = 0
    const output = buildOutput()
    const { output: returned } = await invoke({
      agentState,
      output,
      toolCall,
      onClientCall: () => {
        clientCalls += 1
      },
    })
    expect(clientCalls).toBe(0)
    const value = (
      returned as unknown as Array<{ type: string; value: Record<string, unknown> }>
    )[0].value as { files: string[]; count: number; message: string }
    expect(Array.isArray(value.files)).toBe(true)
    expect(value.files).toContain('src/auth/login.ts')
    expect(value.message).toContain('verified memory')
    expect(agentState.discoveryCoverage).toBeDefined()
  })

  test('proceeds full on stale cover', async () => {
    const agentState = buildVerifiedState(
      ['src/auth/login.ts'],
      {
        workspaceState: { revision: 2 },
      } as unknown as Partial<AgentState>,
      { workspaceRevision: 1 },
    )
    const toolCall = buildToolCall({ cwd: 'src/auth/login.ts' })
    const seen: Array<ClientToolCall<'glob'>> = []
    const output = buildOutput()
    const { output: returned } = await invoke({
      agentState,
      output,
      toolCall,
      onClientCall: (call) => {
        seen.push(call)
      },
    })
    expect(returned).toEqual(output)
    expect(seen).toHaveLength(1)
  })

  test('a failing memory check falls through to the full call', async () => {
    const agentState = buildAgentState()
    spyOn(
      discoveryCoordinator,
      'getVerifiedMemoryExcerpts',
    ).mockImplementation(() => {
      throw new Error('simulated memory failure')
    })
    const output = buildOutput()
    let clientCalls = 0
    const { output: returned } = await invoke({
      agentState,
      output,
      toolCall: buildToolCall({ cwd: 'src/auth/login.ts' }),
      onClientCall: () => {
        clientCalls += 1
      },
    })
    expect(returned).toEqual(output)
    expect(clientCalls).toBe(1)
  })
})
