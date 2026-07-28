import { afterEach, describe, expect, test } from 'bun:test'

import { __clearJobRegistryForTest } from '@codebuff/common/util/job-registry'
import {
  __clearBackgroundAgentJobsForTest,
  allocateBackgroundAgentJob,
} from '../../../../util/background-agent-jobs'
import { handleListJobs } from '../list-jobs'

import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

afterEach(() => {
  __clearJobRegistryForTest()
  __clearBackgroundAgentJobsForTest()
})

describe('handleListJobs', () => {
  test('lists background agent jobs from the unified registry (no client tool call)', async () => {
    const toolCall: CodebuffToolCall<'list_jobs'> = {
      toolName: 'list_jobs',
      toolCallId: 'tool-call-1',
      input: {},
    }
    const owner = {
      clientSessionId: 'client-1',
      rootRunId: 'root-run',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-1',
    }
    const agentJob = allocateBackgroundAgentJob({
      agentType: 'researcher',
      agentName: 'Researcher',
      owner,
    })
    let clientCalled = false

    const { output } = await handleListJobs({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async () => {
        clientCalled = true
        return [] as unknown as CodebuffToolOutput<'list_jobs'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'parent-run',
        agentId: 'parent-agent',
      },
    } as unknown as Parameters<typeof handleListJobs>[0])

    expect(clientCalled).toBe(false)
    expect(output[0].type).toBe('json')
    const jobs =
      output[0].type === 'json'
        ? ((output[0].value as {
            jobs: Array<{
              jobId: string
              kind: string
              command: string
              status: string
              startedAt: number
              completedAt?: number
            }>
          }).jobs ?? [])
        : []
    expect(jobs).toContainEqual(
      expect.objectContaining({ jobId: agentJob.jobId, kind: 'agent' }),
    )
  })
})
