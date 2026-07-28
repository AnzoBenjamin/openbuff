import { jobRegistry } from '@codebuff/common/util/job-registry'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

export async function listJobs(params: {
  /**
   * REQUIRED trusted owner, injected from run/session state by the caller
   * (never from model/tool input). list_jobs can never list unscoped.
   */
  owner: BackgroundJobOwner
}): Promise<CodebuffToolOutput<'list_jobs'>> {
  const owner = {
    clientSessionId: params.owner.clientSessionId,
    rootRunId: params.owner.rootRunId,
  }
  const entries = jobRegistry
    .list(owner)
    .filter((job) => job.kind === 'process')
  const jobs = entries.map((entry) => ({
    jobId: entry.jobId,
    kind: entry.kind,
    command: entry.label,
    status: entry.state,
    startedAt: entry.startedAt ?? entry.createdAt,
    ...(entry.completedAt !== undefined
      ? { completedAt: entry.completedAt }
      : {}),
  }))
  return [{ type: 'json', value: { jobs } }]
}
