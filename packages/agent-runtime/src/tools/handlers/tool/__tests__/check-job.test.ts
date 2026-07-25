import { beforeEach, describe, expect, test } from 'bun:test'

import { handleCheckJob } from '../check-job'
import {
  __clearPendingBackgroundJobsForTest,
  upsertPendingBackgroundJob,
} from '@codebuff/common/util/pending-background-jobs'

import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

describe('handleCheckJob', () => {
  beforeEach(() => {
    __clearPendingBackgroundJobsForTest()
  })

  test('forwards kill_on_timeout to the client tool call', async () => {
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
    let forwardedToolCall: ClientToolCall<'check_job'> | undefined
    upsertPendingBackgroundJob({
      jobId: 'job-123',
      command: 'bun test',
      status: 'running',
      startedAt: Date.now(),
      owner: {
        clientSessionId: 'client-1',
        rootRunId: 'root-run',
        parentRunId: 'parent-run',
        parentAgentId: 'parent-agent',
      },
    })

    const { output } = await handleCheckJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'check_job'>,
      ) => {
        forwardedToolCall = clientToolCall
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              status: 'running',
              newOutput: '',
              matched: false,
              killed: false,
            },
          },
        ] satisfies CodebuffToolOutput<'check_job'>
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
        owner: {
          clientSessionId: 'client-1',
          rootRunId: 'root-run',
          parentRunId: 'parent-run',
          parentAgentId: 'parent-agent',
        },
        wait_for: 'ready',
        timeout_seconds: 1,
        kill_on_timeout: false,
      },
    })
    expect(output[0].type).toBe('json')
  })

  test('pending-miss forwards with the full owner tuple (recover path)', async () => {
    const toolCall: CodebuffToolCall<'check_job'> = {
      toolName: 'check_job',
      toolCallId: 'tool-call-2',
      input: {
        jobId: 'job-orphan',
      },
    }
    let forwardedToolCall: ClientToolCall<'check_job'> | undefined

    const { output } = await handleCheckJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'check_job'>,
      ) => {
        forwardedToolCall = clientToolCall
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              status: 'lost',
              newOutput: '',
              killed: false,
            },
          },
        ] satisfies CodebuffToolOutput<'check_job'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'parent-run',
        agentId: 'parent-agent',
      },
    } as unknown as Parameters<typeof handleCheckJob>[0])

    expect(forwardedToolCall?.input.owner).toEqual({
      clientSessionId: 'client-1',
      rootRunId: 'root-run',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
    })
    expect(output[0].type).toBe('json')
  })

  test('foreign-owner pending entry is rejected and does not forward', async () => {
    const toolCall: CodebuffToolCall<'check_job'> = {
      toolName: 'check_job',
      toolCallId: 'tool-call-3',
      input: {
        jobId: 'job-foreign',
      },
    }
    let forwarded = false
    upsertPendingBackgroundJob({
      jobId: 'job-foreign',
      command: 'bun test',
      status: 'running',
      startedAt: Date.now(),
      owner: {
        clientSessionId: 'client-1',
        rootRunId: 'other-root-run',
        parentRunId: 'other-parent-run',
        parentAgentId: 'other-parent-agent',
      },
    })

    const { output } = await handleCheckJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async () => {
        forwarded = true
        return [] as unknown as CodebuffToolOutput<'check_job'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'parent-run',
        agentId: 'parent-agent',
      },
    } as unknown as Parameters<typeof handleCheckJob>[0])

    expect(forwarded).toBe(false)
    const value = output[0].type === 'json' ? (output[0].value as any) : {}
    expect(value.errorMessage).toContain('job-foreign')
  })
})
