import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import * as discoveryCoordinator from '../../../../orchestration/discovery-coordinator'
import { handleCodeSearch } from '../code-search'

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
  overrides: Partial<CodebuffToolCall<'code_search'>['input']> = {},
): CodebuffToolCall<'code_search'> {
  return {
    toolName: 'code_search',
    toolCallId: 'tool-call-1',
    input: {
      pattern: 'authentication',
      ...overrides,
    },
  } as CodebuffToolCall<'code_search'>
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

function buildOutput(): CodebuffToolOutput<'code_search'> {
  return [
    {
      type: 'json',
      value: {
        stdout: 'src/auth/login.ts:1:authentication',
        message: 'ok',
      },
    },
  ] as unknown as CodebuffToolOutput<'code_search'>
}

function invoke(params: {
  agentState?: AgentState
  output: CodebuffToolOutput<'code_search'>
  toolCall?: CodebuffToolCall<'code_search'>
  onClientCall?: (toolCall: ClientToolCall<'code_search'>) => void
}): Promise<{ output: CodebuffToolOutput<'code_search'> }> {
  const { agentState, output, toolCall, onClientCall } = params
  return handleCodeSearch({
    previousToolCallFinished: Promise.resolve(),
    toolCall: toolCall ?? buildToolCall(),
    requestClientToolCall: async (
      clientToolCall: ClientToolCall<'code_search'>,
    ) => {
      onClientCall?.(clientToolCall)
      return output
    },
    agentState,
  } as unknown as Parameters<typeof handleCodeSearch>[0])
}

describe('handleCodeSearch memory-first', () => {
  afterEach(() => {
    mock.restore()
  })

  test('records results into discovery coverage candidates', async () => {
    const agentState = buildAgentState()
    const output = buildOutput()

    const { output: returned } = await invoke({ agentState, output })

    expect(returned).toEqual(output)
    const candidatePaths = agentState.discoveryCoverage?.candidates.map(
      (candidate) => candidate.path,
    )
    expect(candidatePaths).toContain('src/auth/login.ts')
  })

  test('returns the output unchanged', async () => {
    const agentState = buildAgentState()
    const output = buildOutput()

    const { output: returned } = await invoke({ agentState, output })

    expect(returned).toEqual(output)
  })

  test('a failing coverage update does not break the tool', async () => {
    const output = buildOutput()
    const agentState = buildAgentState()
    spyOn(discoveryCoordinator, 'recordDiscoveryResult').mockImplementation(
      () => {
        throw new Error('simulated coverage update failure')
      },
    )

    const { output: returned } = await invoke({ agentState, output })

    expect(returned).toEqual(output)
    expect(agentState.discoveryCoverage).toBeUndefined()
  })

  test('probe: TODO|FIXME in src with only src/auth/login.ts in memory runs the real search', async () => {
    // read-search-01 negative case. Before the fix, the memory excerpt was
    // printed as stdout even though it does not match the pattern.
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({ pattern: 'TODO|FIXME', cwd: 'src' })
    const filesystemResult = [
      { type: 'json', value: { stdout: '', message: 'No matches' } },
    ] as unknown as CodebuffToolOutput<'code_search'>
    const seen: Array<ClientToolCall<'code_search'>> = []
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
    expect(agentState.memoryReuse?.skip ?? 0).toBe(0)
    expect(agentState.memoryReuse?.narrow ?? 0).toBe(0)
  })

  test('full memory cover of the scope still issues the real call', async () => {
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    for (const toolCall of [
      buildToolCall({ paths: ['src/auth/login.ts'] }),
      buildToolCall({ cwd: 'src/auth/login.ts' }),
    ]) {
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
    }
    expect(agentState.discoveryCoverage).toBeDefined()
  })

  test('partial cover does not narrow the search scope', async () => {
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({
      paths: ['src/auth/login.ts', 'src/other/file.ts'],
    })
    const seen: Array<ClientToolCall<'code_search'>> = []
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
    expect(seen[0].input.paths).toEqual([
      'src/auth/login.ts',
      'src/other/file.ts',
    ])
  })

  test('proceeds full on stale cover', async () => {
    const agentState = buildVerifiedState(
      ['src/auth/login.ts'],
      {
        workspaceState: { revision: 2 },
      } as unknown as Partial<AgentState>,
      { workspaceRevision: 1 },
    )
    const toolCall = buildToolCall({ paths: ['src/auth/login.ts'] })
    const seen: Array<ClientToolCall<'code_search'>> = []
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
    expect(seen[0].input.paths).toEqual(['src/auth/login.ts'])
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

    const { output: returned } = await invoke({ agentState, output })

    expect(returned).toEqual(output)
  })
})
