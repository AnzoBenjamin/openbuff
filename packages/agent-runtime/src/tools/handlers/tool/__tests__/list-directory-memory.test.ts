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

  test('skips the client call on full cover and serves a receipt output', async () => {
    const agentState = buildVerifiedState(['src/auth'])
    const toolCall = buildToolCall({ path: 'src/auth' })
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
    )[0].value as { files: string[]; directories: string[]; path: string }
    expect(Array.isArray(value.files)).toBe(true)
    expect(value.path).toBe('src/auth')
    expect(agentState.discoveryCoverage).toBeDefined()
  })
})
