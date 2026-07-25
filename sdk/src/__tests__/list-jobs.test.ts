import { afterEach, describe, expect, test } from 'bun:test'

import {
  __clearPendingBackgroundJobsForTest,
  upsertPendingBackgroundJob,
} from '@codebuff/common/util/pending-background-jobs'

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

function value(output: Awaited<ReturnType<typeof listJobs>>): any {
  return output[0].value
}

afterEach(() => {
  __clearPendingBackgroundJobsForTest()
})

describe('listJobs', () => {
  test('returns only owner-scoped jobs with correct statuses and completedAt', async () => {
    // Use wall-clock-relative timestamps so the settled job stays inside the
    // retention TTL and is not swept before the assertion runs.
    const now = Date.now()
    const completedAtMs = now - 1000
    upsertPendingBackgroundJob({
      jobId: 'job-run-1',
      command: 'bun dev',
      status: 'running',
      startedAt: now - 4000,
      owner,
    })
    upsertPendingBackgroundJob({
      jobId: 'job-run-2',
      command: 'bun watch',
      status: 'running',
      startedAt: now - 3000,
      owner,
    })
    upsertPendingBackgroundJob({
      jobId: 'job-done-1',
      command: 'bun build',
      status: 'completed',
      startedAt: now - 2000,
      completedAt: completedAtMs,
      owner,
    })
    upsertPendingBackgroundJob({
      jobId: 'job-foreign-1',
      command: 'bun other',
      status: 'running',
      startedAt: now - 1000,
      owner: foreignOwner,
    })

    const jobs = value(await listJobs({ owner })).jobs as Array<{
      jobId: string
      status: string
      completedAt?: number
    }>

    expect(jobs.map((job) => job.jobId).sort()).toEqual([
      'job-done-1',
      'job-run-1',
      'job-run-2',
    ])
    expect(jobs.some((job) => job.jobId === 'job-foreign-1')).toBe(false)

    const done = jobs.find((job) => job.jobId === 'job-done-1')
    expect(done?.status).toBe('completed')
    expect(done?.completedAt).toBe(completedAtMs)

    const running = jobs.find((job) => job.jobId === 'job-run-1')
    expect(running?.status).toBe('running')
    expect(running?.completedAt).toBeUndefined()
  })
})
