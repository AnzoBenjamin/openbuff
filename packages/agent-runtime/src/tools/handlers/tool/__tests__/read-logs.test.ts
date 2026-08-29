import { describe, expect, test } from 'bun:test'

import { handleReadLogs } from '../read-logs'

import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
  ProcessJobClientToolCall,
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

describe('handleReadLogs', () => {
  test('forwards a jobId read and stamps the trusted owner onto the client tool call', async () => {
    const toolCall: CodebuffToolCall<'read_logs'> = {
      toolName: 'read_logs',
      toolCallId: 'tool-call-1',
      input: {
        jobId: 'job-123',
        lines: 100,
        max_chars: 1_000,
      },
    }
    let forwardedToolCall: ProcessJobClientToolCall<'read_logs'> | undefined

    const { output } = await handleReadLogs({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'read_logs'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'read_logs'>
        return [
          {
            type: 'json',
            value: {
              path: '/tmp/log',
              jobId: clientToolCall.input.jobId,
              lines: 100,
              content: 'x\n',
            },
          },
        ] as unknown as CodebuffToolOutput<'read_logs'>
      },
      clientSessionId: 'client-1',
      agentState: buildAgentState(),
    } as unknown as Parameters<typeof handleReadLogs>[0])

    expect(forwardedToolCall).toEqual({
      toolName: 'read_logs',
      toolCallId: 'tool-call-1',
      input: {
        path: undefined,
        jobId: 'job-123',
        lines: 100,
        max_chars: 1_000,
        owner: {
          clientSessionId: 'client-1',
          rootRunId: 'root-run',
          parentRunId: 'parent-run',
          parentAgentId: 'parent-agent',
        },
      },
    })
    expect(output[0].type).toBe('json')
  })

  test('forwards a path-only read and stamps the trusted owner from agentState', async () => {
    const toolCall: CodebuffToolCall<'read_logs'> = {
      toolName: 'read_logs',
      toolCallId: 'tool-call-2',
      input: {
        path: 'logs/app.log',
        lines: 50,
      },
    }
    let forwardedToolCall: ProcessJobClientToolCall<'read_logs'> | undefined

    const { output } = await handleReadLogs({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'read_logs'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'read_logs'>
        return [
          {
            type: 'json',
            value: {
              path: clientToolCall.input.path ?? '',
              lines: 50,
              content: 'y\n',
            },
          },
        ] as unknown as CodebuffToolOutput<'read_logs'>
      },
      clientSessionId: 'client-1',
      agentState: buildAgentState(),
    } as unknown as Parameters<typeof handleReadLogs>[0])

    expect(forwardedToolCall?.input.path).toBe('logs/app.log')
    expect(forwardedToolCall?.input.jobId).toBeUndefined()
    expect((forwardedToolCall?.input as Record<string, unknown>).owner).toEqual(
      {
        clientSessionId: 'client-1',
        rootRunId: 'root-run',
        parentRunId: 'parent-run',
        parentAgentId: 'parent-agent',
      },
    )
    expect(output[0].type).toBe('json')
  })
})
