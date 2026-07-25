import { getBackgroundJob, killBackgroundJob } from './background-jobs'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

export async function killJob(params: {
  jobId: string
  signal?: 'SIGTERM' | 'SIGKILL'
  owner?: BackgroundJobOwner
}): Promise<CodebuffToolOutput<'kill_job'>> {
  const signal = params.signal ?? 'SIGTERM'
  // Look the job up first so a cross-session recovery can re-stamp the owner
  // before we attempt to kill it.
  getBackgroundJob(params.jobId, { restampOwner: params.owner })
  const result = killBackgroundJob(params.jobId, signal)
  return [
    {
      type: 'json',
      value: result,
    },
  ]
}
