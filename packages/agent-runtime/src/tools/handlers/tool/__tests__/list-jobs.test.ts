import { afterEach, describe, expect, test } from 'bun:test'

import { __clearJobRegistryForTest } from '@codebuff/common/util/job-registry'
import { __clearBackgroundAgentJobsForTest } from '../../../../util/background-agent-jobs'
import { handleListJobs } from '../list-jobs'

import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
  ProcessJobClientToolCall,
} from '@codebuff/common/tools/list'

afterEach(() => {
  __clearJobRegistryForTest()
  __clearBackgroundAgentJobsForTest()
})

describe('handleListJobs', () => {
  test('forwards to the client tool and stamps the trusted owner', async () => {
    const toolCall: CodebuffToolCall<'list_jobs'> = {
      toolName: 'list_jobs',
      toolCallId: 'tool-call-1',
      input: {},
    }
    let forwardedToolCall: ProcessJobClientToolCall<'list_jobs'> | undefined

    const { output } = await handleListJobs({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'list_jobs'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'list_jobs'>
        return [
          {
            type: 'json',
            value: {
              jobs: [
                {
                  jobId: 'bg-agent-1',
                  kind: 'agent',
                  command: 'researcher',
                  status: 'running',
                  startedAt: 1,
                },
              ],
            },
          },
        ] as unknown as CodebuffToolOutput<'list_jobs'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'parent-run',
        agentId: 'parent-agent',
      },
    } as unknown as Parameters<typeof handleListJobs>[0])

    expect(forwardedToolCall).toEqual({
      toolName: 'list_jobs',
      toolCallId: 'tool-call-1',
      input: {
        owner: {
          clientSessionId: 'client-1',
          rootRunId: 'root-run',
          parentRunId: 'parent-run',
          parentAgentId: 'parent-agent',
        },
      },
    })
    expect(output[0].type).toBe('json')
    if (output[0].type === 'json') {
      const jobs = (output[0].value as { jobs: Array<{ jobId: string; kind: string }> })
        .jobs
      expect(jobs).toContainEqual(
        expect.objectContaining({ jobId: 'bg-agent-1', kind: 'agent' }),
      )
    }
  })

  test('basher-like child agentState stamps rootRunId from ancestorRunIds[0]', async () => {
    // Regression: basher BACKGROUND spawn uses root (clientSessionId, rootRunId);
    // list_jobs from a basher child must stamp the same root pair so rediscovery works.
    const toolCall: CodebuffToolCall<'list_jobs'> = {
      toolName: 'list_jobs',
      toolCallId: 'tool-call-basher',
      input: {},
    }
    let forwardedToolCall: ProcessJobClientToolCall<'list_jobs'> | undefined

    await handleListJobs({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'list_jobs'>,
      ) => {
        forwardedToolCall =
          clientToolCall as unknown as ProcessJobClientToolCall<'list_jobs'>
        return [
          { type: 'json', value: { jobs: [] } },
        ] as unknown as CodebuffToolOutput<'list_jobs'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'basher-run',
        agentId: 'basher',
      },
    } as unknown as Parameters<typeof handleListJobs>[0])

    expect(
      (forwardedToolCall?.input as Record<string, unknown>).owner,
    ).toEqual({
      clientSessionId: 'client-1',
      rootRunId: 'root-run',
      parentRunId: 'basher-run',
      parentAgentId: 'basher',
    })
  })
})
