import { listBackgroundJobs } from '@codebuff/common/util/pending-background-jobs'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

export async function listJobs(params: {
  owner?: BackgroundJobOwner
}): Promise<CodebuffToolOutput<'list_jobs'>> {
  const entries = listBackgroundJobs(
    params.owner
      ? {
          clientSessionId: params.owner.clientSessionId,
          rootRunId: params.owner.rootRunId,
        }
      : undefined,
  )
  const jobs = entries.map((entry) => ({
    jobId: entry.jobId,
    command: entry.command,
    status: entry.status,
    startedAt: entry.startedAt,
    ...(entry.completedAt !== undefined
      ? { completedAt: entry.completedAt }
      : {}),
  }))
  return [{ type: 'json', value: { jobs } }]
}
