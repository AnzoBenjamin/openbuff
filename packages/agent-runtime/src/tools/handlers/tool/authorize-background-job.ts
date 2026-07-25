import {
  getPendingBackgroundJob,
  pendingBackgroundJobOwnedBy,
} from '@codebuff/common/util/pending-background-jobs'

import type { AgentState } from '@codebuff/common/types/session-state'

export type BackgroundJobOwnerTuple = {
  clientSessionId: string
  rootRunId: string
  parentRunId: string
  parentAgentId: string
}

/**
 * Shared authorization decision for the background-job gate handlers
 * (check_job / kill_job / read_logs).
 *
 * - `owned`: a pending entry exists AND is owned by this run -> forward.
 * - `foreign`: a pending entry exists but is owned by another run -> reject
 *   with the "unavailable to this run" error (preserves live-job isolation).
 * - `recover`: there is NO pending entry (pending-miss) -> the cross-session /
 *   orphan path. Forward the client tool call anyway, passing `owner` in the
 *   input so the SDK can attempt disk recovery + owner re-stamp.
 *
 * Re-stamp happens ONLY on a true pending-miss; a live job owned by another run
 * must still be rejected.
 */
export type AuthorizeBackgroundJobResult =
  | { status: 'owned'; owner: BackgroundJobOwnerTuple }
  | { status: 'foreign' }
  | { status: 'recover'; owner: BackgroundJobOwnerTuple }

export function authorizeBackgroundJob({
  jobId,
  agentState,
  clientSessionId,
}: {
  jobId: string
  agentState: AgentState
  clientSessionId: string
}): AuthorizeBackgroundJobResult {
  const rootRunId =
    agentState.ancestorRunIds[0] ?? agentState.runId ?? agentState.agentId
  const owner: BackgroundJobOwnerTuple = {
    clientSessionId,
    rootRunId,
    parentRunId: agentState.runId ?? agentState.agentId,
    parentAgentId: agentState.agentId,
  }
  const job = getPendingBackgroundJob(jobId)
  if (job) {
    if (pendingBackgroundJobOwnedBy(job, { clientSessionId, rootRunId })) {
      return { status: 'owned', owner }
    }
    return { status: 'foreign' }
  }
  return { status: 'recover', owner }
}
