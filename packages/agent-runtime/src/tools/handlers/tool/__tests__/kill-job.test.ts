import { beforeEach, describe, expect, test } from 'bun:test'

import { handleKillJob } from '../kill-job'
import {
  __clearPendingBackgroundJobsForTest,
  upsertPendingBackgroundJob,
} from '@codebuff/common/util/pending-background-jobs'

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

describe('handleKillJob', () => {
  beforeEach(() => {
    __clearPendingBackgroundJobsForTest()
  })

  test('foreign-owner pending entry is rejected and does not forward', async () => {
    const toolCall: CodebuffToolCall<'kill_job'> = {
      toolName: 'kill_job',
      toolCallId: 'tool-call-1',
      input: {
        jobId: 'job-foreign',
        signal: 'SIGTERM',
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

    const { output } = await handleKillJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async () => {
        forwarded = true
        return [] as unknown as CodebuffToolOutput<'kill_job'>
      },
      clientSessionId: 'client-1',
      agentState: buildAgentState(),
    } as unknown as Parameters<typeof handleKillJob>[0])

    expect(forwarded).toBe(false)
    const value = output[0].type === 'json' ? (output[0].value as any) : {}
    expect(value.errorMessage).toContain('job-foreign')
  })

  test('pending-miss forwards with the full owner tuple (recover path)', async () => {
    const toolCall: CodebuffToolCall<'kill_job'> = {
      toolName: 'kill_job',
      toolCallId: 'tool-call-2',
      input: {
        jobId: 'job-orphan',
        signal: 'SIGTERM',
      },
    }
    let forwardedToolCall: ClientToolCall<'kill_job'> | undefined

    const { output } = await handleKillJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'kill_job'>,
      ) => {
        forwardedToolCall = clientToolCall
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              status: 'stopped',
            },
          },
        ] as unknown as CodebuffToolOutput<'kill_job'>
      },
      clientSessionId: 'client-1',
      agentState: buildAgentState(),
    } as unknown as Parameters<typeof handleKillJob>[0])

    expect(forwardedToolCall?.input.owner).toEqual({
      clientSessionId: 'client-1',
      rootRunId: 'root-run',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
    })
    expect(output[0].type).toBe('json')
  })

  test('owned pending entry (owned by this run) forwards', async () => {
    const toolCall: CodebuffToolCall<'kill_job'> = {
      toolName: 'kill_job',
      toolCallId: 'tool-call-3',
      input: {
        jobId: 'job-owned',
        signal: 'SIGTERM',
      },
    }
    let forwardedToolCall: ClientToolCall<'kill_job'> | undefined
    upsertPendingBackgroundJob({
      jobId: 'job-owned',
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

    const { output } = await handleKillJob({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'kill_job'>,
      ) => {
        forwardedToolCall = clientToolCall
        return [
          {
            type: 'json',
            value: {
              jobId: clientToolCall.input.jobId,
              status: 'stopped',
            },
          },
        ] as unknown as CodebuffToolOutput<'kill_job'>
      },
      clientSessionId: 'client-1',
      agentState: buildAgentState(),
    } as unknown as Parameters<typeof handleKillJob>[0])

    expect(forwardedToolCall?.input.jobId).toBe('job-owned')
    expect(forwardedToolCall?.input.owner).toEqual({
      clientSessionId: 'client-1',
      rootRunId: 'root-run',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
    })
    expect(output[0].type).toBe('json')
  })
})
