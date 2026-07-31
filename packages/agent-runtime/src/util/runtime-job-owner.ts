import type { RuntimeJobOwner } from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

/**
 * Build the trusted job-ownership identity used by list_jobs / check_job /
 * kill_job / read_logs / BACKGROUND run_terminal_command / end_turn.
 *
 * Ownership is derived ONLY from agent/session state (never model/tool input).
 * The pair that scopes the registry is (clientSessionId, rootRunId):
 * - rootRunId prefers the root ancestor so basher/subagent handlers list the
 *   same jobs the root run stamped at spawn time.
 * - parentRunId / parentAgentId identify the immediate agent for diagnostics
 *   and are NOT part of registry ownership equality.
 */
export function resolveRuntimeJobOwner(params: {
  clientSessionId: string
  agentState: Pick<AgentState, 'ancestorRunIds' | 'runId' | 'agentId'>
}): RuntimeJobOwner {
  const { clientSessionId, agentState } = params
  const rootRunId =
    agentState.ancestorRunIds[0] ?? agentState.runId ?? agentState.agentId
  const parentRunId = agentState.runId ?? agentState.agentId
  return {
    clientSessionId,
    rootRunId,
    parentRunId,
    parentAgentId: agentState.agentId,
  }
}
