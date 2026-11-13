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

  test('probe: glob("Dockerfile", cwd:"src") with only src/auth/login.ts in memory hits the filesystem and returns no match', async () => {
    // read-search-01 negative case. Before the fix, memory "covered" cwd
    // `src` and the handler returned src/auth/login.ts as a Dockerfile match.
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({ pattern: 'Dockerfile', cwd: 'src' })
    const filesystemResult = [
      {
        type: 'json',
        value: {
          files: [],
          count: 0,
          message: 'Found 0 file(s) matching pattern "Dockerfile"',
        },
      },
    ] as unknown as CodebuffToolOutput<'glob'>
    const seen: Array<ClientToolCall<'glob'>> = []
    const { output: returned } = await invoke({
      agentState,
      output: filesystemResult,
      toolCall,
      onClientCall: (call) => {
        seen.push(call)
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].input).toEqual(toolCall.input)
    expect(returned).toEqual(filesystemResult)
    const value = (
      returned as unknown as Array<{ value: { files: string[]; message: string } }>
    )[0].value
    expect(value.files).not.toContain('src/auth/login.ts')
    expect(value.message).not.toContain('verified memory')
    expect(agentState.memoryReuse?.skip ?? 0).toBe(0)
    expect(agentState.memoryReuse?.byTool?.[0]).toMatchObject({
      tool: 'glob',
      decision: 'full',
      reason: 'exhaustive-tool',
    })
  })

  test('full memory cover of cwd still issues the real call', async () => {
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
    expect(clientCalls).toBe(1)
    expect(returned).toEqual(output)
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

  test('narrow cover falls through to the full call without rooting cwd at a file gap', async () => {
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({
      pattern: 'src/auth/login.ts src/missing/file.ts',
    })
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
    // The full call must be issued unchanged: no cwd derived from a file gap.
    expect(seen[0].input).toEqual(toolCall.input)
    expect(
      (seen[0].input as { cwd?: string }).cwd,
    ).toBeUndefined()
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
