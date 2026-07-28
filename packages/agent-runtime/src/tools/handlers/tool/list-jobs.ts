import { jobRegistry } from '@codebuff/common/util/job-registry'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'list_jobs'

/**
 * list_jobs reads the unified job registry directly (both `process` shell
 * jobs and `agent` coroutine jobs owned by this run) rather than delegating
 * to the legacy pending-jobs Map via a client tool call.
 */
export const handleListJobs = (async ({
  previousToolCallFinished,
  agentState,
  clientSessionId,
}: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  requestClientToolCall?: unknown
  agentState: AgentState
  clientSessionId: string
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  await previousToolCallFinished
  const rootRunId =
    agentState.ancestorRunIds[0] ?? agentState.runId ?? agentState.agentId
  const jobs = jobRegistry.list({ clientSessionId, rootRunId }).map((job) => ({
    jobId: job.jobId,
    kind: job.kind,
    command: job.label,
    status: job.state,
    startedAt: job.startedAt ?? job.createdAt,
    ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
  }))
  return { output: [{ type: 'json', value: { jobs } }] }
}) satisfies CodebuffToolHandlerFunction<ToolName>
