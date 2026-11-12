import {
  PLAN_MODE_READ_ONLY_ERROR_CODE,
  isPlanModeRefusedTool,
} from '@codebuff/common/tools/plan-mode-policy'

import { resolveRuntimeJobOwner } from '../util/runtime-job-owner'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

export { PLAN_MODE_READ_ONLY_ERROR_CODE }

/**
 * Plan-mode lineage marker. The root plan template (base2-plan) declares
 * `programmaticConfig.planOnly`, and {@link inheritPlanLineage} stamps it on
 * every template spawned under it, so each tool call can tell whether it runs
 * inside a plan lineage from its own agent template.
 */
export function isPlanLineage(
  agentTemplate: Pick<AgentTemplate, 'programmaticConfig'> | undefined,
): boolean {
  return agentTemplate?.programmaticConfig?.planOnly === true
}

/**
 * Derive a child template for a plan-lineage parent: mark it plan-only, drop
 * every plan-refused tool from its model-visible tool list, and clamp its
 * terminal profile to `read-only`. A non-plan parent returns the child as is.
 */
export function inheritPlanLineage<T extends AgentTemplate>(params: {
  child: T
  parent: Pick<AgentTemplate, 'programmaticConfig'> | undefined
}): T {
  const { child, parent } = params
  if (!isPlanLineage(parent)) return child
  const toolNames = child.toolNames.filter(
    (toolName) => !isPlanModeRefusedTool(toolName),
  )
  return {
    ...child,
    toolNames,
    terminalPermissionProfile:
      toolNames.includes('run_terminal_command') ||
      child.terminalPermissionProfile !== undefined
        ? 'read-only'
        : child.terminalPermissionProfile,
    programmaticConfig: { ...child.programmaticConfig, planOnly: true },
  }
}

// ---------------------------------------------------------------------------
// Jobs started inside a plan lineage
// ---------------------------------------------------------------------------

/**
 * Background jobs started by plan-lineage agents, keyed by the job owner's
 * (clientSessionId, rootRunId). A plan lineage may kill only these. The SDK
 * job registry already scopes kill_job to the root run; this ledger keeps the
 * plan rule explicit and independent of the host (for example a recovered
 * ownerless job claimed through check_job is still refused).
 *
 * Bounded: the oldest root keys are evicted past MAX_TRACKED_ROOTS.
 */
const MAX_TRACKED_ROOTS = 256
const planLineageJobs = new Map<string, Set<string>>()

function lineageKey(owner: { clientSessionId: string; rootRunId: string }) {
  return `${owner.clientSessionId}\u0000${owner.rootRunId}`
}

export function recordPlanLineageJob(params: {
  clientSessionId: string
  agentState: Pick<AgentState, 'ancestorRunIds' | 'runId' | 'agentId'>
  jobId: string
}): void {
  const key = lineageKey(resolveRuntimeJobOwner(params))
  let jobs = planLineageJobs.get(key)
  if (!jobs) {
    if (planLineageJobs.size >= MAX_TRACKED_ROOTS) {
      const oldest = planLineageJobs.keys().next().value
      if (oldest !== undefined) planLineageJobs.delete(oldest)
    }
    jobs = new Set()
    planLineageJobs.set(key, jobs)
  }
  jobs.add(params.jobId)
}

function planLineageStartedJob(params: {
  clientSessionId: string
  agentState: Pick<AgentState, 'ancestorRunIds' | 'runId' | 'agentId'>
  jobId: string
}): boolean {
  return (
    planLineageJobs
      .get(lineageKey(resolveRuntimeJobOwner(params)))
      ?.has(params.jobId) === true
  )
}

/** Test-only reset of the plan-lineage job ledger. */
export function __resetPlanLineageJobsForTest(): void {
  planLineageJobs.clear()
}

// ---------------------------------------------------------------------------
// Dispatch check
// ---------------------------------------------------------------------------

export type PlanModeRefusal = {
  errorCode: typeof PLAN_MODE_READ_ONLY_ERROR_CODE
  toolName: string
  message: string
  userMessage: string
}

function refusal(toolName: string, reason: string): PlanModeRefusal {
  return {
    errorCode: PLAN_MODE_READ_ONLY_ERROR_CODE,
    toolName,
    message: `${PLAN_MODE_READ_ONLY_ERROR_CODE}: \`${toolName}\` was refused because plan mode is read-only. ${reason} Record the change in the plan with create_plan or update_plan_status instead; it can be applied after switching to execute mode.`,
    userMessage: `Plan mode is read-only: ${toolName} was not run.`,
  }
}

/**
 * Decide whether a native tool call may run in the caller's lineage. Returns a
 * typed refusal for plan-lineage calls to mutating tools, and for kill_job of a
 * job the plan lineage did not start. Returns undefined otherwise (including
 * for every call outside a plan lineage).
 */
export function checkPlanModeToolCall(params: {
  toolName: string
  input: unknown
  agentTemplate: Pick<AgentTemplate, 'programmaticConfig'>
  agentState: Pick<AgentState, 'ancestorRunIds' | 'runId' | 'agentId'>
  clientSessionId: string
}): PlanModeRefusal | undefined {
  const { toolName, input, agentTemplate, agentState, clientSessionId } = params
  if (!isPlanLineage(agentTemplate)) return undefined
  if (isPlanModeRefusedTool(toolName)) {
    return refusal(toolName, 'This tool changes the workspace or git state.')
  }
  if (toolName === 'kill_job') {
    const jobId =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>).jobId
        : undefined
    if (
      typeof jobId !== 'string' ||
      !planLineageStartedJob({ clientSessionId, agentState, jobId })
    ) {
      return refusal(
        toolName,
        'Plan mode may stop only background jobs it started itself.',
      )
    }
  }
  return undefined
}
