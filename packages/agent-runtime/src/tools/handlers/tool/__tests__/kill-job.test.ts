import { describe, expect, test } from 'bun:test'

import { handleKillJob } from '../kill-job'

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

describe('handleKillJob', () => {
  test('forwards jobId + signal and stamps the trusted owner onto the client tool call', async () => {
    const toolCall: CodebuffToolCall<'kill_job'> = {
      toolName: 'kill_job',
      toolCallId: 'tool-call-1',
      input: {
        jobId: 'job-123',
        signal: 'SIGTERM',
      },
    }
    let forwardedToolCall: ProcessJobClientToolCall<'kill_job'> | undefined

    const { output } = await handleKillJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'kill_job'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'kill_job'>
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              status: 'stopped',
              killed: true,
              signal: 'SIGTERM',
            },
          },
        ] as unknown as CodebuffToolOutput<'kill_job'>
      },
      clientSessionId: 'client-1',
      agentState: buildAgentState(),
    } as unknown as Parameters<typeof handleKillJob>[0])

    expect(forwardedToolCall).toEqual({
      toolName: 'kill_job',
      toolCallId: 'tool-call-1',
      input: {
        jobId: 'job-123',
        signal: 'SIGTERM',
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

  test('derives the stamped owner from agentState (never model input)', async () => {
    const toolCall: CodebuffToolCall<'kill_job'> = {
      toolName: 'kill_job',
      toolCallId: 'tool-call-2',
      input: {
        jobId: 'job-orphan',
        signal: 'SIGKILL',
      },
    }
    let forwardedToolCall: ProcessJobClientToolCall<'kill_job'> | undefined

    const { output } = await handleKillJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'kill_job'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'kill_job'>
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              status: 'stopped',
              killed: true,
              signal: 'SIGKILL',
            },
          },
        ] as unknown as CodebuffToolOutput<'kill_job'>
      },
      clientSessionId: 'client-1',
      agentState: buildAgentState(),
    } as unknown as Parameters<typeof handleKillJob>[0])

    // The trusted owner is ALWAYS stamped from agent/session state so the
    // SDK can gate the mutating kill on registry ownership.
    expect(
      (forwardedToolCall?.input as Record<string, unknown>).owner,
    ).toEqual({
      clientSessionId: 'client-1',
      rootRunId: 'root-run',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
    })
    expect(output[0].type).toBe('json')
  })
})
