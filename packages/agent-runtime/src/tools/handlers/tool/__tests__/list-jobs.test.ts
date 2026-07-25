import { describe, expect, test } from 'bun:test'

import { handleListJobs } from '../list-jobs'

import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

describe('handleListJobs', () => {
  test('forwards a list_jobs client tool call carrying the owner tuple', async () => {
    const toolCall: CodebuffToolCall<'list_jobs'> = {
      toolName: 'list_jobs',
      toolCallId: 'tool-call-1',
      input: {},
    }
    let forwardedToolCall: ClientToolCall<'list_jobs'> | undefined

    await handleListJobs({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      requestClientToolCall: async (
        clientToolCall: ClientToolCall<'list_jobs'>,
      ) => {
        forwardedToolCall = clientToolCall
        return [
          {
            type: 'json',
            value: { jobs: [] },
          },
        ] satisfies CodebuffToolOutput<'list_jobs'>
      },
      clientSessionId: 'client-1',
      agentState: {
        ancestorRunIds: ['root-run'],
        runId: 'parent-run',
        agentId: 'parent-agent',
      },
    } as unknown as Parameters<typeof handleListJobs>[0])

    expect(forwardedToolCall?.toolName).toBe('list_jobs')
    expect(forwardedToolCall?.input.owner).toEqual({
      clientSessionId: 'client-1',
      rootRunId: 'root-run',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
    })
  })
})
