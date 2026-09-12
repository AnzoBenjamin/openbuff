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
  afterEach(() => {
    mock.restore()
  })

  test('records results into discovery coverage candidates', async () => {
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
    const candidatePaths = agentState.discoveryCoverage?.candidates.map(
      (candidate) => candidate.path,
    )
    expect(candidatePaths).toContain('src/auth/login.ts')
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
    spyOn(discoveryCoordinator, 'recordDiscoveryResult').mockImplementation(
      () => {
        throw new Error('simulated coverage update failure')
      },
    )

    const { output: returned } = await handleQueryIndex({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall(),
      requestClientToolCall: async (
        _clientToolCall: ClientToolCall<'query_index'>,
      ) => output,
      agentState,
    } as unknown as Parameters<typeof handleQueryIndex>[0])

    expect(returned).toEqual(output)
    // The throw happened before any coverage could be recorded.
    expect(agentState.discoveryCoverage).toBeUndefined()
  })
})
