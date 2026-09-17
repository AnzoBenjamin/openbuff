import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import * as discoveryCoordinator from '../../../../orchestration/discovery-coordinator'
import { handleQueryIndex } from '../query-index'

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
  overrides: Partial<CodebuffToolCall<'query_index'>['input']> = {},
): CodebuffToolCall<'query_index'> {
  return {
    toolName: 'query_index',
    toolCallId: 'tool-call-1',
    input: {
      query: 'authentication',
      mode: 'search',
      limit: 20,
      ...overrides,
    },
  } as CodebuffToolCall<'query_index'>
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

function buildOutput(): CodebuffToolOutput<'query_index'> {
  return [
    {
      type: 'json',
      value: {
        results: [
          {
            path: 'src/auth/login.ts',
            score: 1,
            matchedOn: ['authentication'],
          },
        ],
        kind: 'query_index_result',
        schemaVersion: 1,
        totalIndexed: 1,
        indexAge: 0,
        message: 'ok',
      },
    },
  ] as unknown as CodebuffToolOutput<'query_index'>
}

function invoke(params: {
  agentState: AgentState
  output: CodebuffToolOutput<'query_index'>
  toolCall?: CodebuffToolCall<'query_index'>
  onClientCall?: (toolCall: ClientToolCall<'query_index'>) => void
}): Promise<{ output: CodebuffToolOutput<'query_index'> }> {
  const { agentState, output, toolCall, onClientCall } = params
  return handleQueryIndex({
    previousToolCallFinished: Promise.resolve(),
    toolCall: toolCall ?? buildToolCall(),
    requestClientToolCall: async (
      clientToolCall: ClientToolCall<'query_index'>,
    ) => {
      onClientCall?.(clientToolCall)
      return output
    },
    agentState,
  } as unknown as Parameters<typeof handleQueryIndex>[0])
}

describe('handleQueryIndex', () => {
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
    // The throw happened before any coverage could be recorded.
    expect(agentState.discoveryCoverage).toBeUndefined()
  })

  test('skips the client call on full cover and serves a receipt output', async () => {
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({ pathPrefixes: ['src/auth/login.ts'] })
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
    const value = (returned as unknown as Array<{ type: string; value: Record<string, unknown> }>)[0]
      .value as {
      results: Array<{ path: string }>;
      kind: string;
      schemaVersion: number;
      totalIndexed: number;
      indexAge: number;
      message: string;
    }
    expect(value.kind).toBe('query_index_result')
    expect(value.schemaVersion).toBe(1)
    expect(typeof value.totalIndexed).toBe('number')
    expect(typeof value.indexAge).toBe('number')
    expect(typeof value.message).toBe('string')
    expect(value.results.length).toBeGreaterThan(0)
    expect(value.results.length).toBeLessThanOrEqual(5)
    expect(value.results.map((entry) => entry.path)).toContain(
      'src/auth/login.ts',
    )
    // Skip still records coverage best-effort without throwing.
    expect(agentState.discoveryCoverage).toBeDefined()
  })

  test('narrows pathPrefixes on partial cover', async () => {
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({
      pathPrefixes: ['src/auth/login.ts', 'src/other/file.ts'],
    })
    const seen: Array<ClientToolCall<'query_index'>> = []
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
    expect(seen[0].input.pathPrefixes).toEqual(['src/other/file.ts'])
  })

  test('proceeds full on stale cover', async () => {
    const agentState = buildVerifiedState(
      ['src/auth/login.ts'],
      {
        workspaceState: { revision: 2 },
      } as unknown as Partial<AgentState>,
      { workspaceRevision: 1 },
    )
    const toolCall = buildToolCall({ pathPrefixes: ['src/auth/login.ts'] })
    const seen: Array<ClientToolCall<'query_index'>> = []
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
    expect(seen[0].input.pathPrefixes).toEqual(['src/auth/login.ts'])
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
