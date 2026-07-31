import { afterEach, describe, expect, test } from 'bun:test'

import {
  __clearJobRegistryForTest,
  jobRegistry,
} from '@codebuff/common/util/job-registry'

import {
  __clearBackgroundAgentJobsForTest,
  allocateBackgroundAgentJob,
} from '../util/background-agent-jobs'
import { handleEndTurn } from '../tools/handlers/tool/end-turn'

afterEach(() => {
  __clearJobRegistryForTest()
  __clearBackgroundAgentJobsForTest()
})

/** Seed a running shell (process) job into the unified registry. */
function seedShellJob(params: {
  command: string
  startedAt?: number
  completed?: boolean
  owner?: {
    clientSessionId: string
    rootRunId: string
    parentRunId: string
    parentAgentId: string
  }
}): string {
  const job = jobRegistry.create({
    kind: 'process',
    label: params.command,
    owner: params.owner ?? {
      clientSessionId: 'unknown-session',
      rootRunId: 'unknown-root',
      parentRunId: 'unknown-parent',
      parentAgentId: 'unknown-agent',
    },
  })
  jobRegistry.start(job.jobId)
  if (params.completed) {
    jobRegistry.emit(job.jobId, {
      type: 'lifecycle',
      state: 'completed',
      exitCode: 0,
    })
  }
  return job.jobId
}

const runHandler = async (params?: {
  clientSessionId: string
  agentId: string
  runId: string
}) => {
  const result = await handleEndTurn({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolName: 'end_turn',
      toolCallId: 'test-end-turn',
      input: {},
    },
    ...(params
      ? {
          clientSessionId: params.clientSessionId,
          agentState: {
            agentId: params.agentId,
            runId: params.runId,
            ancestorRunIds: [],
          },
        }
      : {}),
  } as Parameters<typeof handleEndTurn>[0])
  const [entry] = result.output as Array<{
    type: 'json'
    value: Record<string, unknown>
  }>
  return entry.value
}

describe('handleEndTurn', () => {
  test('returns the plain Turn ended message when no jobs are running', async () => {
    const value = await runHandler()
    expect(value).toEqual({ message: 'Turn ended.' })
  })

  test('fails closed and lists nothing when clientSessionId/agentState are missing', async () => {
    // Seed jobs that would be visible to an UNSCOPED registry listing. With no
    // client session id or agent state the handler must NOT surface them (it
    // would leak cross-session jobs); it returns the plain turn-ended message.
    seedShellJob({ command: 'echo cross-session' })

    const value = await runHandler()
    expect(value).toEqual({ message: 'Turn ended.' })
  })

  test('surfaces running background shell jobs in the end_turn output', async () => {
    const job1 = seedShellJob({ command: 'echo hi' })
    const job2 = seedShellJob({ command: 'sleep 100' })

    const value = await runHandler({
      clientSessionId: 'unknown-session',
      agentId: 'unknown-agent',
      runId: 'unknown-root',
    })
    expect(value.message).toContain('2 shell job(s)')
    expect(value.pendingBackgroundJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: job1, command: 'echo hi' }),
        expect.objectContaining({ jobId: job2, command: 'sleep 100' }),
      ]),
    )
    expect(value.pendingBackgroundJobsTruncated).toBeUndefined()
  })

  test('surfaces running background agent jobs', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'researcher-web',
      agentName: 'Web researcher',
      owner: {
        clientSessionId: 'session-agent-1',
        rootRunId: 'root-agent-1',
        parentRunId: 'parent-agent-1',
        parentAgentId: 'agent-1',
        userInputId: 'input-agent-1',
      },
    })

    const value = await runHandler({
      clientSessionId: 'session-agent-1',
      agentId: 'agent-1',
      runId: 'root-agent-1',
    })
    expect(value.message).toContain('1 agent job(s)')
    expect(value.pendingBackgroundAgentJobs).toEqual([
      expect.objectContaining({
        jobId: job.jobId,
        agentType: 'researcher-web',
      }),
    ])
  })

  test('only surfaces background agent jobs owned by this root run', async () => {
    const owner = {
      clientSessionId: 'session-1',
      rootRunId: 'root-1',
      parentRunId: 'parent-run-1',
      parentAgentId: 'parent-agent-1',
      userInputId: 'input-1',
    }
    const owned = allocateBackgroundAgentJob({
      agentType: 'researcher',
      agentName: 'Owned researcher',
      owner,
    })
    allocateBackgroundAgentJob({
      agentType: 'researcher',
      agentName: 'Other researcher',
      owner: {
        ...owner,
        rootRunId: 'root-2',
      },
    })

    const value = await runHandler({
      clientSessionId: owner.clientSessionId,
      agentId: 'parent-agent-1',
      runId: owner.rootRunId,
    })
    expect(value.pendingBackgroundAgentJobs).toEqual([
      expect.objectContaining({
        jobId: owned.jobId,
        agentType: 'researcher',
      }),
    ])
  })

  test('truncates the listed jobs when more than five are running', async () => {
    for (let i = 0; i < 7; i++) {
      seedShellJob({ command: `cmd ${i}` })
    }

    const value = await runHandler({
      clientSessionId: 'unknown-session',
      agentId: 'unknown-agent',
      runId: 'unknown-root',
    })
    expect(value.pendingBackgroundJobs).toHaveLength(5)
    expect(value.pendingBackgroundJobsTruncated).toBe(2)
  })

  test('ignores completed/errored jobs that are still registered', async () => {
    const running = seedShellJob({ command: 'echo running' })
    seedShellJob({ command: 'echo done', completed: true })

    const value = await runHandler({
      clientSessionId: 'unknown-session',
      agentId: 'unknown-agent',
      runId: 'unknown-root',
    })
    expect(value.pendingBackgroundJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: running, command: 'echo running' }),
      ]),
    )
    expect(value.pendingBackgroundJobs).toHaveLength(1)
  })

  test('truncates the listed agent jobs when more than five are running', async () => {
    const owner = {
      clientSessionId: 'session-truncate-agents',
      rootRunId: 'root-truncate-agents',
      parentRunId: 'parent-truncate-agents',
      parentAgentId: 'agent-truncate',
      userInputId: 'input-truncate-agents',
    }
    for (let i = 0; i < 7; i++) {
      allocateBackgroundAgentJob({
        agentType: 'researcher',
        agentName: `Researcher ${i}`,
        owner,
      })
    }

    const value = await runHandler({
      clientSessionId: owner.clientSessionId,
      agentId: owner.parentAgentId,
      runId: owner.rootRunId,
    })
    expect(value.pendingBackgroundAgentJobs).toHaveLength(5)
    expect(value.pendingBackgroundAgentJobsTruncated).toBe(2)
  })

  test('surfaces a mixed shell and agent running scenario with combined summary', async () => {
    seedShellJob({
      command: 'echo shell',
      owner: {
        clientSessionId: 'session-mixed',
        rootRunId: 'root-mixed',
        parentRunId: 'parent-mixed',
        parentAgentId: 'agent-mixed',
      },
    })
    allocateBackgroundAgentJob({
      agentType: 'researcher',
      agentName: 'Agent researcher',
      owner: {
        clientSessionId: 'session-mixed',
        rootRunId: 'root-mixed',
        parentRunId: 'parent-mixed',
        parentAgentId: 'agent-mixed',
        userInputId: 'input-mixed',
      },
    })

    const value = await runHandler({
      clientSessionId: 'session-mixed',
      agentId: 'agent-mixed',
      runId: 'root-mixed',
    })
    expect(value.message).toContain('1 shell job(s)')
    expect(value.message).toContain('1 agent job(s)')
    expect(value.pendingBackgroundJobs).toHaveLength(1)
    expect(value.pendingBackgroundAgentJobs).toHaveLength(1)
  })
})
