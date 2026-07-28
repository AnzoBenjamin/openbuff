import { jobRegistry } from '@codebuff/common/util/job-registry'

import { getBackgroundAgentJob } from '../../../util/background-agent-jobs'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

const MAX_JOBS_LISTED = 5

export const handleEndTurn = (async (params: {
  previousToolCallFinished: Promise<any>
  toolCall: CodebuffToolCall<'end_turn'>
  agentState?: AgentState
  clientSessionId?: string
}): Promise<{ output: CodebuffToolOutput<'end_turn'> }> => {
  const { previousToolCallFinished, agentState, clientSessionId } = params

  await previousToolCallFinished

  const rootRunId = agentState
    ? agentState.ancestorRunIds[0] ?? agentState.runId ?? agentState.agentId
    : undefined
  const owner =
    clientSessionId && rootRunId ? { clientSessionId, rootRunId } : undefined
  // The unified job registry lists both shell `process` jobs and `agent`
  // coroutine jobs; end_turn must keep warning about BOTH kinds.
  const running = jobRegistry.listRunning(owner)
  const runningJobs = running.filter((job) => job.kind === 'process')
  const runningAgentJobs = running.filter((job) => job.kind === 'agent')
  if (runningJobs.length === 0 && runningAgentJobs.length === 0) {
    return { output: [{ type: 'json', value: { message: 'Turn ended.' } }] }
  }

  // Surface still-running background jobs at end of turn so the agent (and the
  // user reading the transcript) can decide to kill_job, check_job, or read_logs
  // them rather than silently leaking work across turns. We do not auto-kill —
  // dev servers and watchers are intentional long-runners — but we do refuse to
  // hide them.
  const listed = runningJobs.slice(0, MAX_JOBS_LISTED).map((job) => ({
    jobId: job.jobId,
    command: job.label,
    startedAt: job.startedAt ?? job.createdAt,
  }))
  const remaining = runningJobs.length - listed.length
  // The registry stores the agentType as the label; the display agentName
  // lives on the adapter view (keyed by the same single job id).
  const listedAgents = runningAgentJobs
    .slice(0, MAX_JOBS_LISTED)
    .map((job) => ({
      jobId: job.jobId,
      agentType: job.label,
      agentName: getBackgroundAgentJob(job.jobId)?.agentName ?? job.label,
      startedAt: job.startedAt ?? job.createdAt,
    }))
  const remainingAgents = runningAgentJobs.length - listedAgents.length
  const summary =
    `Turn ended. ${runningJobs.length} shell job(s) and ${runningAgentJobs.length} agent job(s) are still running. ` +
    `Use check_job/read_logs/kill_job or check_background_agent to manage them.`

  return {
    output: [
      {
        type: 'json',
        value: {
          message: summary,
          pendingBackgroundJobs: listed,
          pendingBackgroundAgentJobs: listedAgents,
          ...(remaining > 0
            ? { pendingBackgroundJobsTruncated: remaining }
            : {}),
          ...(remainingAgents > 0
            ? { pendingBackgroundAgentJobsTruncated: remainingAgents }
            : {}),
        },
      },
    ],
  }
}) satisfies CodebuffToolHandlerFunction<'end_turn'>
