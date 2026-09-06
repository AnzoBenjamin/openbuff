import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { jobRegistry } from '@codebuff/common/util/job-registry'

import {
  __clearJobsForTest,
  __registerJobForTest,
  __setLastCheckCursorForTest,
  type BackgroundJob,
} from '../tools/background-jobs'
import { checkJob } from '../tools/check-job'
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

/** Seed a running process job and return its id. */
function seedRunningJob(
  command: string,
  jobOwner: BackgroundJobOwner,
  kind: 'process' | 'agent' = 'process',
): string {
  const job = jobRegistry.create({
    kind,
    label: command,
    owner: jobOwner,
  })
  jobRegistry.start(job.jobId)
  return job.jobId
}

/** Seed a settled (completed) process job and return its id. */
function seedCompletedJob(
  command: string,
  jobOwner: BackgroundJobOwner,
): { jobId: string } {
  const jobId = seedRunningJob(command, jobOwner)
  jobRegistry.emit(jobId, {
    type: 'lifecycle',
    state: 'completed',
    exitCode: 0,
  })
  return { jobId }
}

function value(output: Awaited<ReturnType<typeof listJobs>>): any {
  return output[0].value
}

/** Emit output events until the ring at cursor 0 reports truncation. */
function emitUntilGap(jobId: string): void {
  // Batch to avoid one giant loop; stop at the first truncated/dropped
  // snapshot. maxBatches is a fixed generous backstop (deliberately decoupled
  // from DEFAULT_JOB_EVENT_BUFFER_LIMIT); the early return keeps this fast.
  const batchSize = 50
  const maxBatches = 2000
  for (let round = 0; round < maxBatches; round++) {
    for (let i = 0; i < batchSize; i++) {
      jobRegistry.emit(jobId, {
        type: 'output',
        data: `gap-line-${round}-${i}\n`,
      })
    }
    const snap = jobRegistry.snapshot(jobId, 0)
    if (snap?.truncated || (snap?.dropped ?? 0) > 0) return
  }
  throw new Error('emitUntilGap: ring never reported truncation')
}

afterEach(() => {
  // Clears adapter Map + jobRegistry (stronger than registry-only clear).
  __clearJobsForTest()
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

  test('includes agent jobs owned by the trusted owner and excludes foreign agents', async () => {
    const processJob = seedRunningJob('bun dev', owner, 'process')
    const agentJob = seedRunningJob('researcher', owner, 'agent')
    seedRunningJob('foreign-agent', foreignOwner, 'agent')

    const jobs = value(await listJobs({ owner })).jobs as Array<{
      jobId: string
      kind: string
    }>

    expect(jobs.map((job) => job.jobId).sort()).toEqual(
      [processJob, agentJob].sort(),
    )
    expect(jobs.find((job) => job.jobId === agentJob)?.kind).toBe('agent')
    expect(jobs.find((job) => job.jobId === processJob)?.kind).toBe('process')
  })

  test('lists a root-owned process job for the root owner and not for a foreign owner', async () => {
    // Regression for the smoke failure class: check/kill work by jobId, but
    // list must still rediscover via (clientSessionId, rootRunId) ownership.
    const jobId = seedRunningJob('smoke-loop', owner, 'process')

    const rootJobs = value(await listJobs({ owner })).jobs as Array<{
      jobId: string
    }>
    expect(rootJobs.map((job) => job.jobId)).toContain(jobId)

    const foreignJobs = value(await listJobs({ owner: foreignOwner }))
      .jobs as Array<{
      jobId: string
    }>
    expect(foreignJobs.map((job) => job.jobId)).not.toContain(jobId)
  })

  test('lists a job with basher parent fields when root clientSessionId+rootRunId match', async () => {
    // parentRunId/parentAgentId are diagnostic only; ownedBy keys on
    // (clientSessionId, rootRunId). A basher-spawned job stamped with the root
    // pair must still appear in the root list.
    const basherStamped: BackgroundJobOwner = {
      clientSessionId: owner.clientSessionId,
      rootRunId: owner.rootRunId,
      parentRunId: 'basher-run',
      parentAgentId: 'basher',
    }
    const jobId = seedRunningJob('basher-bg', basherStamped, 'process')

    const jobs = value(await listJobs({ owner })).jobs as Array<{
      jobId: string
    }>
    expect(jobs.map((job) => job.jobId)).toContain(jobId)
  })

  test('buckets pending output relative to check_job cursor (cursor 0 → all pending)', async () => {
    const jobId = seedRunningJob('bun dev', owner)
    // Three complete lines → pending bucket '<10' (not 'none').
    jobRegistry.emit(jobId, { type: 'output', data: 'line-1\n' })
    jobRegistry.emit(jobId, { type: 'output', data: 'line-2\n' })
    jobRegistry.emit(jobId, { type: 'output', data: 'line-3\n' })

    const result = value(await listJobs({ owner }))
    expect(result.note).toBe('No action required unless you need this output.')
    const entry = (
      result.jobs as Array<{
        jobId: string
        pending: string
        gap: boolean
      }>
    ).find((job) => job.jobId === jobId)
    expect(entry?.pending).toBe('<10')
    expect(entry?.gap).toBe(false)
  })

  test('escalates pending bucket when enough lines are buffered', async () => {
    const jobId = seedRunningJob('chatty', owner)
    for (let i = 0; i < 12; i++) {
      jobRegistry.emit(jobId, { type: 'output', data: `line-${i}\n` })
    }

    const entry = (
      value(await listJobs({ owner })).jobs as Array<{
        jobId: string
        pending: string
      }>
    ).find((job) => job.jobId === jobId)
    expect(entry?.pending).toBe('<100')
  })

  test('completed job may include exitCode and note is always present', async () => {
    const { jobId } = seedCompletedJob('bun build', owner)
    jobRegistry.emit(jobId, { type: 'output', data: 'built ok\n' })

    const result = value(await listJobs({ owner }))
    expect(result.note).toBe('No action required unless you need this output.')
    const entry = (
      result.jobs as Array<{
        jobId: string
        status: string
        exitCode?: number | null
        pending: string
      }>
    ).find((job) => job.jobId === jobId)
    expect(entry?.status).toBe('completed')
    expect(entry?.exitCode).toBe(0)
    expect(entry?.pending).not.toBeUndefined()
  })

  test('advanced lastCheckCursor drops pending to none without mutating cursor', async () => {
    const jobId = seedRunningJob('bun dev', owner)
    jobRegistry.emit(jobId, { type: 'output', data: 'line-1\n' })
    jobRegistry.emit(jobId, { type: 'output', data: 'line-2\n' })
    jobRegistry.emit(jobId, { type: 'output', data: 'line-3\n' })

    const first = (
      value(await listJobs({ owner })).jobs as Array<{
        jobId: string
        pending: string
        gap: boolean
      }>
    ).find((job) => job.jobId === jobId)
    expect(first?.pending).toBe('<10')
    expect(first?.gap).toBe(false)

    // Same registry id as production live spawns (no dual-id remapping).
    const tip = jobRegistry.snapshot(jobId, 0)!.nextCursor
    __setLastCheckCursorForTest(jobId, tip, owner)

    const second = (
      value(await listJobs({ owner })).jobs as Array<{
        jobId: string
        pending: string
        gap: boolean
      }>
    ).find((job) => job.jobId === jobId)
    expect(second?.pending).toBe('none')
    expect(second?.gap).toBe(false)

    // list_jobs is read-only: re-list still shows none (cursor not mutated).
    const third = (
      value(await listJobs({ owner })).jobs as Array<{
        jobId: string
        pending: string
      }>
    ).find((job) => job.jobId === jobId)
    expect(third?.pending).toBe('none')
  })

  test('reports gap:true when the event ring has truncated output', async () => {
    const jobId = seedRunningJob('flood', owner)
    emitUntilGap(jobId)

    const snap = jobRegistry.snapshot(jobId, 0)
    expect(snap?.truncated || (snap?.dropped ?? 0) > 0).toBe(true)

    const entry = (
      value(await listJobs({ owner })).jobs as Array<{
        jobId: string
        gap: boolean
      }>
    ).find((job) => job.jobId === jobId)
    expect(entry?.gap).toBe(true)
  })

  test('terminal job includes tail of last ≤10 non-empty output lines', async () => {
    const { jobId } = seedCompletedJob('bun build', owner)
    const emitted: string[] = []
    for (let i = 0; i < 12; i++) {
      const line = `build-line-${i}`
      emitted.push(line)
      jobRegistry.emit(jobId, { type: 'output', data: `${line}\n` })
    }

    const entry = (
      value(await listJobs({ owner })).jobs as Array<{
        jobId: string
        status: string
        tail?: string[]
      }>
    ).find((job) => job.jobId === jobId)

    expect(entry?.status).toBe('completed')
    expect(entry?.tail).toBeDefined()
    expect(entry!.tail!.length).toBeLessThanOrEqual(10)
    expect(entry!.tail).toEqual(emitted.slice(-10))
  })

  test('registered process job: list_jobs exposes jobId; pending uses adapter cursor; listed id works with check_job', async () => {
    // After the id collapse, __registerJobForTest passes the adapter's jobId
    // as the explicit registry id, so the registry record and adapter Map
    // share one key. list_jobs must resolve the adapter, emit the id, and
    // honor lastCheckCursor so rediscovery works with check_job/kill_job.
    const userJobId = 'job-registered-user'
    const logFile = path.join(os.tmpdir(), `openbuff-${userJobId}.log`)
    fs.writeFileSync(logFile, '')
    const adapter: BackgroundJob = {
      jobId: userJobId,
      command: 'registered-cmd',
      child: { pid: 4242 } as BackgroundJob['child'],
      logFile,
      metadataFile: path.join(os.tmpdir(), `openbuff-${userJobId}.json`),
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      readOffset: 0,
      owner,
    }
    __registerJobForTest(adapter)
    // After collapse: registry id === adapter.jobId (no remapping).
    expect(adapter.jobId).toBe(userJobId)

    // Emit on the jobId (where process output is mirrored).
    jobRegistry.emit(userJobId, { type: 'output', data: 'line-1\n' })
    jobRegistry.emit(userJobId, { type: 'output', data: 'line-2\n' })
    jobRegistry.emit(userJobId, { type: 'output', data: 'line-3\n' })

    // Advance lastCheckCursor via check_job on the id.
    const checkResult = (await checkJob({ jobId: userJobId, owner }))[0]
      .value as {
      jobId: string
      nextCursor?: number
      errorMessage?: string
    }
    expect(checkResult.errorMessage).toBeUndefined()
    expect(checkResult.jobId).toBe(userJobId)
    expect(adapter.lastCheckCursor).toBe(checkResult.nextCursor)

    const listed = value(await listJobs({ owner })).jobs as Array<{
      jobId: string
      pending: string
      gap: boolean
      command: string
    }>
    // Must expose the id.
    expect(listed.map((j) => j.jobId)).toContain(userJobId)

    const entry = listed.find((j) => j.jobId === userJobId)
    expect(entry?.command).toBe('registered-cmd')
    // Cursor advanced by check_job → pending none at adapter cursor; no gap.
    expect(entry?.pending).toBe('none')
    expect(entry?.gap).toBe(false)

    // New output after the listed cursor should re-bucket pending, and
    // check_job must still resolve that listed id.
    jobRegistry.emit(userJobId, { type: 'output', data: 'line-4\n' })
    const afterMore = (
      value(await listJobs({ owner })).jobs as Array<{
        jobId: string
        pending: string
      }>
    ).find((j) => j.jobId === userJobId)
    expect(afterMore?.pending).toBe('<10')

    const listedId = entry!.jobId
    const recheck = (await checkJob({ jobId: listedId, owner }))[0].value as {
      jobId: string
      errorMessage?: string
      events?: unknown[]
    }
    expect(recheck.errorMessage).toBeUndefined()
    expect(recheck.jobId).toBe(userJobId)

    try {
      fs.unlinkSync(logFile)
    } catch {
      // best-effort temp cleanup
    }
  })
})
