import { describe, expect, test } from 'bun:test'

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

function buildToolCall(): CodebuffToolCall<'query_index'> {
  return {
    toolName: 'query_index',
    toolCallId: 'tool-call-1',
    input: {
      query: 'authentication',
      mode: 'search',
      limit: 20,
    },
  } as CodebuffToolCall<'query_index'>
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

describe('handleQueryIndex', () => {
  test('records results into discovery coverage candidates', async () => {
    const agentState = buildAgentState()
    const output = buildOutput()

    await handleQueryIndex({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall(),
      requestClientToolCall: async (
        _clientToolCall: ClientToolCall<'query_index'>,
      ) => output,
      agentState,
    } as unknown as Parameters<typeof handleQueryIndex>[0])

    const candidates = agentState.discoveryCoverage?.candidates ?? []
    expect(candidates.map((candidate) => candidate.path)).toContain(
      'src/auth/login.ts',
    )
  })

  test('returns the output unchanged', async () => {
    const agentState = buildAgentState()
    const output = buildOutput()

    const { output: returned } = await handleQueryIndex({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall(),
      requestClientToolCall: async (
        _clientToolCall: ClientToolCall<'query_index'>,
      ) => output,
      agentState,
    } as unknown as Parameters<typeof handleQueryIndex>[0])

    expect(returned).toEqual(output)
  })

  test('a failing coverage update does not break the tool', async () => {
    const output = buildOutput()
    const agentState = buildAgentState()
    Object.freeze(agentState)

    const { output: returned } = await handleQueryIndex({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall(),
      requestClientToolCall: async (
        _clientToolCall: ClientToolCall<'query_index'>,
      ) => output,
      agentState,
    } as unknown as Parameters<typeof handleQueryIndex>[0])

    expect(returned).toEqual(output)
  })
})
