import { describe, expect, test } from 'bun:test'

import { handleCheckJob } from '../check-job'

import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
  ProcessJobClientToolCall,
} from '@codebuff/common/tools/list'

describe('handleCheckJob', () => {
  test('forwards wait/timeout/kill_on_timeout and stamps the trusted owner onto the client tool call', async () => {
    const toolCall: CodebuffToolCall<'check_job'> = {
      toolName: 'check_job',
      toolCallId: 'tool-call-1',
      input: {
        jobId: 'job-123',
        wait_for: 'ready',
        timeout_seconds: 1,
        kill_on_timeout: false,
      },
    }
    let forwardedToolCall: ProcessJobClientToolCall<'check_job'> | undefined

    const { output } = await handleCheckJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'check_job'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'check_job'>
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              state: 'running',
              events: [],
              nextCursor: 0,
              truncated: false,
              dropped: 0,
            },
          },
        ] as unknown as CodebuffToolOutput<'check_job'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'parent-run',
        agentId: 'parent-agent',
      },
    } as unknown as Parameters<typeof handleCheckJob>[0])

    expect(forwardedToolCall).toEqual({
      toolName: 'check_job',
      toolCallId: 'tool-call-1',
      input: {
        jobId: 'job-123',
        wait_for: 'ready',
        timeout_seconds: 1,
        kill_on_timeout: false,
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

  test('derives the stamped owner from agentState (rootRunId falls back to runId/agentId)', async () => {
    const toolCall: CodebuffToolCall<'check_job'> = {
      toolName: 'check_job',
      toolCallId: 'tool-call-2',
      input: {
        jobId: 'job-orphan',
      },
    }
    let forwardedToolCall: ProcessJobClientToolCall<'check_job'> | undefined

    const { output } = await handleCheckJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'check_job'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'check_job'>
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              state: 'lost',
              events: [],
              nextCursor: 0,
              truncated: false,
              dropped: 0,
            },
          },
        ] as unknown as CodebuffToolOutput<'check_job'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'parent-run',
        agentId: 'parent-agent',
      },
    } as unknown as Parameters<typeof handleCheckJob>[0])

    // The trusted owner is ALWAYS stamped from agent/session state so the
    // SDK can assert it against the registry (never from model input).
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
