import { jobRegistry } from '@codebuff/common/util/job-registry'

import { getBackgroundJob, killBackgroundJob } from './background-jobs'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

/**
 * How long kill_job waits for the job's exit to be observed before it
 * answers. SIGTERM escalates to SIGKILL after 5 s inside background-jobs, so
 * a child that ignores SIGTERM is reported as still stopping, not killed.
 */
export const KILL_JOB_EXIT_WAIT_MS = 3_000
const KILL_JOB_EXIT_POLL_MS = 25

function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && status !== 'running' && status !== 'stopping'
}

export async function killJob(params: {
  jobId: string
  signal?: 'SIGTERM' | 'SIGKILL'
  /** Exit-observation budget (DI seam for tests). */
  waitForExitMs?: number
  /**
   * REQUIRED trusted owner, injected from run/session state by the caller
   * (never from model/tool input). kill_job is mutating: ownership gates the
   * kill BEFORE terminateProcessTree is reachable.
   */
  owner: BackgroundJobOwner
}): Promise<CodebuffToolOutput<'kill_job'>> {
  const signal = params.signal ?? 'SIGTERM'
  // Look the job up first so a cross-session recovery can re-attach it
  // (re-stamped with this trusted owner) before we attempt to kill it.
  const job = getBackgroundJob(params.jobId, { restampOwner: params.owner })
  if (!job) {
    return [
      {
        type: 'json',
        value: {
          jobId: params.jobId,
          errorMessage: `No background job found with id "${params.jobId}".`,
        },
      },
    ]
  }
  // Ownership gate BEFORE any kill path: a foreign job is refused with the
  // same generic not_found error as an unknown id (no existence leak), and
  // terminateProcessTree is never reached for another session's job.
  const ownership = jobRegistry.assertOwned(job.jobId, params.owner)
  if (!ownership.ok) {
    return [
      {
        type: 'json',
        value: {
          jobId: params.jobId,
          errorMessage: `No background job found with id "${params.jobId}".`,
        },
      },
    ]
  }
  const result = killBackgroundJob(params.jobId, signal)
  if ('errorMessage' in result || !result.killed) {
    return [{ type: 'json', value: result }]
  }
  // Signal delivery is not an exit (exec-jobs-13). Report `killed: true`
  // only once the job's own exit has been observed; otherwise say the job is
  // still stopping, why, and what to do next.
  const budgetMs = Math.max(0, params.waitForExitMs ?? KILL_JOB_EXIT_WAIT_MS)
  const deadline = Date.now() + budgetMs
  let current = getBackgroundJob(params.jobId)
  while (!isTerminalStatus(current?.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, KILL_JOB_EXIT_POLL_MS))
    current = getBackgroundJob(params.jobId)
  }
  if (current && isTerminalStatus(current.status)) {
    return [
      {
        type: 'json',
        value: {
          jobId: params.jobId,
          status: current.status,
          killed: true,
          exitObserved: true,
          signal,
          exitCode: current.exitCode,
        },
      },
    ]
  }
  const waitedSeconds = Math.round(budgetMs / 100) / 10
  return [
    {
      type: 'json',
      value: {
        jobId: params.jobId,
        status: current?.status === 'running' ? 'running' : 'stopping',
        killed: false,
        exitObserved: false,
        signal,
        exitCode: current?.exitCode ?? null,
        reason: `${signal} was sent but the process had not exited after ${waitedSeconds}s.`,
        nextStep:
          signal === 'SIGTERM'
            ? 'Do not assume the process is gone (ports and files may still be held). Call check_job to confirm the exit; SIGTERM escalates to SIGKILL automatically after 5s, or call kill_job with signal SIGKILL.'
            : 'Do not assume the process is gone. Call check_job to confirm the exit before reusing its ports or files.',
      },
    },
  ]
}
