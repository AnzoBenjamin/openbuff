import {
  assertBackgroundAgentJobOwned,
  cancelBackgroundAgentJob,
  getBackgroundAgentJob,
  getBackgroundAgentJobCore,
  snapshotBackgroundAgentJob,
  waitForBackgroundAgentJob,
} from '../../../util/background-agent-jobs'
import { resolveRuntimeJobOwner } from '../../../util/runtime-job-owner'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { JobEvent } from '@codebuff/common/util/job-registry'

type ToolName = 'check_background_agent'

/**
 * Flatten an event's payload into a searchable string for wait_for matching.
 * agent_chunk payloads are opaque structured events (text, tool_call,
 * tool_result, subagent_*); we join string-coercible fields so a caller can
 * wait for a substring like 'completed' or a tool name.
 */
function eventToSearchString(event: JobEvent): string {
  const payload = event.payload
  if (payload.type !== 'agent_chunk') return ''
  const { chunkType, data } = payload
  if (typeof data === 'string') {
    return `${chunkType} ${data}`
  }
  if (data && typeof data === 'object') {
    try {
      return `${chunkType} ${JSON.stringify(data)}`
    } catch {
      return chunkType
    }
  }
  return chunkType
}

export const handleCheckBackgroundAgent = (async ({
  previousToolCallFinished,
  toolCall,
  agentState,
  clientSessionId,
}: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentState: AgentState
  clientSessionId: string
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  await previousToolCallFinished

  const {
    jobId,
    wait_for,
    timeout_seconds = 0,
    cancel = false,
    cursor,
  } = toolCall.input
  const resolved = resolveRuntimeJobOwner({ clientSessionId, agentState })
  const owner = {
    clientSessionId: resolved.clientSessionId,
    rootRunId: resolved.rootRunId,
  }

  // Ownership is enforced inside the unified core registry via assertOwned;
  // the legacy owned/foreign/recover gate is gone.
  const owned = assertBackgroundAgentJobOwned(jobId, owner)
  if (!owned.ok) {
    return {
      output: {
        type: 'json',
        value:
          owned.reason === 'not_found'
            ? {
                jobId,
                errorMessage: `No background agent job found with id "${jobId}".`,
              }
            : {
                jobId,
                errorMessage:
                  'Background agent job is not owned by this client session/root run.',
              },
      } as unknown as CodebuffToolOutput<ToolName>,
    }
  }

  // cancel:true maps to the registry's cancel + the adapter's AbortController.
  if (cancel) {
    const cancelResult = cancelBackgroundAgentJob(jobId)
    if ('errorMessage' in cancelResult) {
      return {
        output: {
          type: 'json',
          value: { jobId, errorMessage: cancelResult.errorMessage },
        } as unknown as CodebuffToolOutput<ToolName>,
      }
    }
    const intent = agentState.backgroundAgentJobs?.find(
      (entry) => entry.jobId === jobId,
    )
    if (intent) {
      intent.status = 'cancelled'
      intent.completedAt = Date.now()
      intent.error = 'Cancelled by check_background_agent.'
    }
  }

  const timeoutMs = Math.max(0, (timeout_seconds ?? 0) * 1000)
  const predicate = wait_for
    ? (event: JobEvent) => eventToSearchString(event).includes(wait_for)
    : undefined
  const follow = Boolean(wait_for) || timeoutMs > 0

  // Join/wait over the unified core event stream. Poll mode resolves
  // immediately from the snapshot; follow mode is driven off the registry's
  // internal notifications (no sleep-polling).
  const result = follow
    ? await waitForBackgroundAgentJob(jobId, {
        cursor,
        predicate,
        timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
      })
    : (snapshotBackgroundAgentJob(jobId, cursor) ?? undefined)

  const events = result?.events ?? []
  const nextCursor = result?.nextCursor ?? cursor ?? 0
  const state = result?.state ?? owned.job.state
  const dropped = result?.dropped ?? 0
  const truncated =
    result && 'truncated' in result ? result.truncated : dropped > 0
  const matched = predicate ? events.some(predicate) : undefined
  const timedOut = result && 'timedOut' in result ? result.timedOut : false

  // The settled result/error comes from the core Job view (the adapter's
  // completion handler stamps result; error is folded into the lifecycle).
  const coreJob = getBackgroundAgentJobCore(jobId)
  const view = getBackgroundAgentJob(jobId)
  const cancelled = cancel || state === 'cancelled'
  const resultValue = view?.result
  const errorValue = coreJob?.error ?? view?.error

  return {
    output: {
      type: 'json',
      value: {
        jobId,
        state,
        events,
        nextCursor,
        truncated,
        dropped,
        ...(state === 'completed' && resultValue !== undefined
          ? { result: resultValue }
          : {}),
        ...(errorValue !== undefined &&
        (state === 'error' || state === 'cancelled')
          ? { error: errorValue }
          : {}),
        ...(matched !== undefined ? { matched } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      },
    } as unknown as CodebuffToolOutput<ToolName>,
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
