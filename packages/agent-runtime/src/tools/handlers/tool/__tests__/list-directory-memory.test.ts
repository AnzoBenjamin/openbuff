import { afterEach, describe, expect, mock, test } from 'bun:test'

import { handleListDirectory } from '../list-directory'

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
  overrides: Partial<CodebuffToolCall<'list_directory'>['input']> = {},
): CodebuffToolCall<'list_directory'> {
  return {
    toolName: 'list_directory',
    toolCallId: 'tool-call-1',
    input: {
      path: 'src/auth',
      ...overrides,
    },
  } as CodebuffToolCall<'list_directory'>
}

function buildVerifiedState(paths: string[]): AgentState {
  return buildAgentState({
    memoryV2Context: {
      result: {
        verifiedKnowledge: [
          {
            verifiedEvidence: paths.map((path) => ({
              selector: { path },
              excerpt: `verified content of ${path}`,
            })),
          },
        ],
      },
    },
  } as unknown as Partial<AgentState>)
}

function buildOutput(): CodebuffToolOutput<'list_directory'> {
  return [
    {
      type: 'json',
      value: {
        files: ['login.ts'],
        directories: ['session'],
        path: 'src/auth',
      },
    },
  ] as unknown as CodebuffToolOutput<'list_directory'>
}

function invoke(params: {
  agentState?: AgentState
  output: CodebuffToolOutput<'list_directory'>
  toolCall?: CodebuffToolCall<'list_directory'>
  onClientCall?: (toolCall: ClientToolCall<'list_directory'>) => void
}): Promise<{ output: CodebuffToolOutput<'list_directory'> }> {
  const { agentState, output, toolCall, onClientCall } = params
  return handleListDirectory({
    previousToolCallFinished: Promise.resolve(),
    toolCall: toolCall ?? buildToolCall(),
    requestClientToolCall: async (
      clientToolCall: ClientToolCall<'list_directory'>,
    ) => {
      onClientCall?.(clientToolCall)
      return output
    },
    agentState,
  } as unknown as Parameters<typeof handleListDirectory>[0])
}

describe('handleListDirectory memory-first', () => {
  afterEach(() => {
    mock.restore()
  })

  test('memory covering the path never replaces the real listing', async () => {
    // read-search-01 negative case. Before the fix the handler returned the
    // nested memory path as a direct child with `directories: []`.
    const agentState = buildVerifiedState(['src/auth/login.ts'])
    const toolCall = buildToolCall({ path: 'src' })
    const filesystemResult = [
      {
        type: 'json',
        value: { files: [], directories: ['auth', 'db'], path: 'src' },
      },
    ] as unknown as CodebuffToolOutput<'list_directory'>
    let clientCalls = 0
    const { output: returned } = await invoke({
      agentState,
      output: filesystemResult,
      toolCall,
      onClientCall: () => {
        clientCalls += 1
      },
    })
    expect(clientCalls).toBe(1)
    expect(returned).toEqual(filesystemResult)
    const value = (
      returned as unknown as Array<{ value: { files: string[]; directories: string[] } }>
    )[0].value
    expect(value.files).not.toContain('src/auth/login.ts')
    expect(value.directories).toEqual(['auth', 'db'])
    expect(agentState.memoryReuse?.skip ?? 0).toBe(0)
    expect(agentState.discoveryCoverage).toBeDefined()
  })
})
