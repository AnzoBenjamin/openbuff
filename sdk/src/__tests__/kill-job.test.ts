import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  __clearJobsForTest,
  __registerJobForTest,
  type BackgroundJob,
} from '../tools/background-jobs'
import { killJob } from '../tools/kill-job'

let counter = 0
const tempFiles: string[] = []

/** Trusted owner injected into killJob by the run/session layer in tests. */
const TRUSTED_OWNER = {
  clientSessionId: 'session-1',
  rootRunId: 'root-1',
  parentRunId: 'parent-1',
  parentAgentId: 'agent-1',
}
const FOREIGN_OWNER = {
  clientSessionId: 'session-2',
  rootRunId: 'root-2',
  parentRunId: 'parent-2',
  parentAgentId: 'agent-2',
}

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  counter += 1
  const logFile = path.join(os.tmpdir(), `openbuff-test-kill-${counter}.log`)
  fs.writeFileSync(logFile, '')
  tempFiles.push(logFile)
  const job: BackgroundJob = {
    jobId: `job-test-${counter}`,
    command: 'echo hi',
    // Fake child with a kill method so killBackgroundJob's `child.kill` path
    // is exercised without spawning a real process.
    child: {
      pid: 53000 + counter,
      kill: () => true,
    } as unknown as BackgroundJob['child'],
    logFile,
    metadataFile: `${logFile}.json`,
    status: 'running',
    exitCode: null,
    startedAt: 0,
    readOffset: 0,
    owner: TRUSTED_OWNER,
    ...overrides,
  }
  __registerJobForTest(job)
  return job
}

function value(output: Awaited<ReturnType<typeof killJob>>): any {
  return output[0].value
}

afterEach(() => {
  __clearJobsForTest()
  for (const f of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(f)
    } catch {
      // ignore
    }
  }
})

describe('killJob', () => {
  test('returns an errorMessage when the job id is unknown', async () => {
    const out = await killJob({
      jobId: 'job-does-not-exist',
      owner: TRUSTED_OWNER,
    })
    expect(value(out).errorMessage).toMatch(/No background job found/)
    expect(value(out).jobId).toBe('job-does-not-exist')
  })

  test('kills a running job with SIGTERM by default and reports killed=true', async () => {
    const job = makeJob()
    const out = await killJob({ jobId: job.jobId, owner: TRUSTED_OWNER })
    expect(value(out)).toEqual({
      jobId: job.jobId,
      status: 'stopped',
      killed: true,
      signal: 'SIGTERM',
      exitCode: null,
    })
  })

  test('honors an explicit SIGKILL signal', async () => {
    const job = makeJob()
    const out = await killJob({
      jobId: job.jobId,
      signal: 'SIGKILL',
      owner: TRUSTED_OWNER,
    })
    expect(value(out).signal).toBe('SIGKILL')
    expect(value(out).killed).toBe(true)
  })

  test('does not attempt to kill an already-finished job', async () => {
    const job = makeJob({ status: 'completed', exitCode: 0 })
    const out = await killJob({ jobId: job.jobId, owner: TRUSTED_OWNER })
    expect(value(out)).toEqual({
      jobId: job.jobId,
      status: 'completed',
      killed: false,
      signal: 'SIGTERM',
      exitCode: 0,
    })
  })

  test('returns an errorMessage when the running job has no pid', async () => {
    const job = makeJob({
      child: {
        pid: undefined,
        kill: () => true,
      } as unknown as BackgroundJob['child'],
    })
    const out = await killJob({ jobId: job.jobId, owner: TRUSTED_OWNER })
    expect(value(out).errorMessage).toMatch(/no process id to kill/)
    expect(value(out).jobId).toBe(job.jobId)
  })

  test('refuses to kill a foreign-owned job with a generic not_found error', async () => {
    let killCalled = false
    const job = makeJob({
      child: {
        pid: 53000 + 999,
        kill: () => {
          killCalled = true
          return true
        },
      } as unknown as BackgroundJob['child'],
    })
    const out = await killJob({ jobId: job.jobId, owner: FOREIGN_OWNER })
    expect(value(out).errorMessage).toContain(
      `No background job found with id "${job.jobId}"`,
    )
    // terminateProcessTree must never be reached for another session's job.
    expect(killCalled).toBe(false)
    expect(job.status).toBe('running')
  })

  test('a model-supplied owner cannot override the trusted owner for a kill', async () => {
    const job = makeJob()
    // Simulate the run.ts dispatch: spread the (hostile) model input, then
    // pin owner to the trusted value. The trusted owner wins and the kill is
    // allowed; the foreign owner in the input is ignored.
    const modelInput = { jobId: job.jobId, owner: FOREIGN_OWNER }
    const out = await killJob({ ...modelInput, owner: TRUSTED_OWNER })
    expect(value(out).killed).toBe(true)
  })
})
