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

  test('skips the client call on full cover and serves a receipt output', async () => {
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({ paths: ['src/auth/login.ts'] })
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
      .value as { stdout: string; message: string }
    expect(typeof value.stdout).toBe('string')
    expect(typeof value.message).toBe('string')
    expect(value.stdout).toContain('src/auth/login.ts')
    expect(value.message).toContain('verified memory')
    // Skip still records coverage best-effort without throwing.
    expect(agentState.discoveryCoverage).toBeDefined()
  })

  test('skips on full cover via cwd scope', async () => {
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
    const value = (returned as unknown as Array<{ type: string; value: Record<string, unknown> }>)[0]
      .value as { stdout: string; message: string }
    expect(value.stdout).toContain('src/auth/login.ts')
    expect(agentState.discoveryCoverage).toBeDefined()
  })

  test('narrows paths on partial cover', async () => {
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
    expect(seen[0].input.paths).toEqual(['src/other/file.ts'])
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
