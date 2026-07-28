import { jobRegistry } from '@codebuff/common/util/job-registry'

import { getBackgroundJob, killBackgroundJob } from './background-jobs'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

/** Registry-side id backing this adapter job (recovered jobs are remapped). */
function registryIdFor(job: { jobId: string; registryJobId?: string }): string {
  return job.registryJobId ?? job.jobId
}

export async function killJob(params: {
  jobId: string
  signal?: 'SIGTERM' | 'SIGKILL'
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
  const ownership = jobRegistry.assertOwned(registryIdFor(job), params.owner)
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
  return [
    {
      type: 'json',
      value: result,
    },
  ]
}
