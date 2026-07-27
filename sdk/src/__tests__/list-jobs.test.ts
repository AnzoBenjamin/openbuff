import { afterEach, describe, expect, test } from 'bun:test'

import {
  __clearJobRegistryForTest,
  jobRegistry,
} from '@codebuff/common/util/job-registry'

import { listJobs } from '../tools/list-jobs'

import type { BackgroundJobOwner } from '../tools/background-jobs'

const owner: BackgroundJobOwner = {
  clientSessionId: 'session-1',
  rootRunId: 'root-1',
  parentRunId: 'parent-1',
  parentAgentId: 'agent-1',
}

const foreignOwner: BackgroundJobOwner = {
  clientSessionId: 'session-2',
  rootRunId: 'root-2',
  parentRunId: 'parent-2',
  parentAgentId: 'agent-2',
}

/** Seed a running registry job and return its id. */
function seedRunningJob(command: string, jobOwner: BackgroundJobOwner): string {
  const job = jobRegistry.create({
    kind: 'process',
    label: command,
    owner: jobOwner,
  })
  jobRegistry.start(job.jobId)
  return job.jobId
}

/** Seed a settled (completed) registry job and return its id. */
function seedCompletedJob(
  command: string,
  jobOwner: BackgroundJobOwner,
): { jobId: string } {
  const jobId = seedRunningJob(command, jobOwner)
  jobRegistry.emit(jobId, { type: 'lifecycle', state: 'completed', exitCode: 0 })
  return { jobId }
}

function value(output: Awaited<ReturnType<typeof listJobs>>): any {
  return output[0].value
}

afterEach(() => {
  __clearJobRegistryForTest()
})

describe('listJobs', () => {
  test('returns only owner-scoped jobs with correct statuses and completedAt', async () => {
    // Use wall-clock-relative timestamps so the settled job stays inside the
    // retention TTL and is not swept before the assertion runs.
    const running1 = seedRunningJob('bun dev', owner)
    const running2 = seedRunningJob('bun watch', owner)
    const done = seedCompletedJob('bun build', owner)
    seedRunningJob('bun other', foreignOwner)

    const jobs = value(await listJobs({ owner })).jobs as Array<{
      jobId: string
      status: string
      completedAt?: number
    }>

    expect(jobs.map((job) => job.jobId).sort()).toEqual(
      [running1, running2, done.jobId].sort(),
    )

    const doneEntry = jobs.find((job) => job.jobId === done.jobId)
    expect(doneEntry?.status).toBe('completed')
    expect(doneEntry?.completedAt).toBeDefined()

    const runningEntry = jobs.find((job) => job.jobId === running1)
    expect(runningEntry?.status).toBe('running')
    expect(runningEntry?.completedAt).toBeUndefined()
  })
})
