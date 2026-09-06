import {
  advanceBackgroundAgentConsumerCursor,
  assertBackgroundAgentJobOwned,
  BACKGROUND_AGENT_CANCEL_REASON,
  cancelBackgroundAgentJob,
  getBackgroundAgentConsumerCursor,
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
import type {
  JobEvent,
  JobSnapshot,
  WaitJobResult,
} from '@codebuff/common/util/job-registry'

type ToolName = 'check_background_agent'

/**
 * Deadline applied to a follow-mode call that asked to wait (`wait_for`) without
 * an explicit `timeout_seconds`. Follow mode must ALWAYS have a deadline:
 * awaiting the registry with none would let one tool call block the agent turn
 * indefinitely, contradicting the tool's documented `timeout_seconds: 0`
 * (return-immediately) behavior. Exported so the covering test pins the bound
 * instead of hard-coding it.
 */
export const DEFAULT_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS = 30_000

/**
 * Hard ceiling on any follow-mode wait, mirroring the input schema's 600-second
 * maximum so a caller that reaches this handler through a non-validating path
 * still cannot hold the turn open longer than the documented maximum.
 */
export const MAX_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS = 600_000

/**
 * Resolve whether a call joins (follow mode) and the deadline that join runs
 * under. Follow mode ALWAYS gets a finite deadline: awaiting the registry with
 * none would let one tool call block the agent turn indefinitely, contradicting
 * the tool's documented `timeout_seconds: 0` (return-immediately) behavior. A
 * non-finite or negative `timeout_seconds` is treated as omitted rather than
 * disabling the bound, and every deadline is capped at the documented maximum.
 */
export function resolveCheckBackgroundAgentWaitBounds(params: {
  waitFor?: string
  timeoutSeconds?: number
}): { follow: boolean; timeoutMs: number } {
  const requestedSeconds = params.timeoutSeconds
  const requestedTimeoutMs =
    typeof requestedSeconds === 'number' && Number.isFinite(requestedSeconds)
      ? Math.max(0, requestedSeconds * 1000)
      : 0
  return {
    follow: Boolean(params.waitFor) || requestedTimeoutMs > 0,
    timeoutMs: Math.min(
      requestedTimeoutMs > 0
        ? requestedTimeoutMs
        : DEFAULT_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
      MAX_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
    ),
  }
}

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

/**
 * Build the structured poll/follow result from the raw wait result and the
 * wait_for predicate. Computes the common output fields (state, events,
 * nextCursor, truncated, dropped, matched, timedOut) shared by poll and
 * follow modes. Advances the per-consumer cursor for cursorless polls as a
 * side effect. Agent-specific fields (result/error/cancelled) are resolved
 * separately by the caller from the core/view.
 */
function buildAgentPollResult(params: {
  /** Poll mode yields a JobSnapshot; follow mode yields a WaitJobResult. */
  result: WaitJobResult | JobSnapshot | undefined
  predicate: ((event: JobEvent) => boolean) | undefined
  fallbackState: string
  jobId: string
  consumerId: string
  cursorOmitted: boolean
}): {
  state: string
  events: JobEvent[]
  nextCursor: number
  truncated: boolean
  dropped: number
  matched: boolean | undefined
  timedOut: boolean
} {
  const { result, predicate, fallbackState, jobId, consumerId, cursorOmitted } =
    params
  const events = result?.events ?? []
  // Falls back to 0 rather than echoing the caller's cursor: the owned job
  // always yields a result here, and reporting a cursor the core did not
  // confirm could pin a consumer past every future event.
  const nextCursor = result?.nextCursor ?? 0
  // Only a cursorless poll owns the stored position, and it advances only as
  // far as the core confirmed: a follow-mode timeout that returned no events
  // confirms the cursor it started from, so events that land later are still
  // delivered to this consumer.
  if (cursorOmitted) {
    advanceBackgroundAgentConsumerCursor(jobId, consumerId, nextCursor)
  }
  const state = result?.state ?? fallbackState
  const dropped = result?.dropped ?? 0
  const truncated =
    result && 'truncated' in result ? result.truncated : dropped > 0
  const matched = predicate ? events.some(predicate) : undefined
  const timedOut = result && 'timedOut' in result ? result.timedOut : false
  return { state, events, nextCursor, truncated, dropped, matched, timedOut }
}

/**
 * The single not_found message shape, used for an id the unified core no
 * longer knows about (never allocated, or reclaimed by the settled-job TTL
 * sweep). A job whose adapter view was count-cap evicted is NOT reported this
 * way: its lifecycle state and its settled result still live on the core
 * record, so it is reported normally.
 */
function jobNotFoundMessage(jobId: string): string {
  return `No background agent job found with id "${jobId}".`
}

export const handleCheckBackgroundAgent = (async ({
  previousToolCallFinished,
  toolCall,
  agentState,
  clientSessionId,
  signal,
}: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentState: AgentState
  clientSessionId: string
  signal: AbortSignal
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
                errorMessage: jobNotFoundMessage(jobId),
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
  // A repeat cancel on an already-settled job (including one whose settled view
  // was count-cap evicted) is an IDEMPOTENT no-op, not an error: the caller
  // still asked for this job's state, events, and result, and replacing that
  // with an error-only payload would make the retry lose the settled receipt.
  // Only an id the unified core no longer knows at all is an error, and the
  // ownership gate above already reported that case as not_found.
  let cancelledNow = false
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
    cancelledNow = cancelResult.cancelled
    if (cancelledNow) {
      const intent = agentState.backgroundAgentJobs?.find(
        (entry) => entry.jobId === jobId,
      )
      if (intent) {
        intent.status = 'cancelled'
        intent.completedAt = Date.now()
        intent.error = BACKGROUND_AGENT_CANCEL_REASON
      }
    }
  }

  // Follow mode is always bounded, by BOTH a deadline and the turn's abort
  // signal, so joining a background agent can neither block nor leak the turn.
  // A `wait_for` without an explicit timeout uses the documented default bound
  // instead of awaiting the registry forever.
  const predicate = wait_for
    ? (event: JobEvent) => eventToSearchString(event).includes(wait_for)
    : undefined
  const { follow, timeoutMs } = resolveCheckBackgroundAgentWaitBounds({
    waitFor: wait_for,
    timeoutSeconds: timeout_seconds,
  })

  // The tool documents "immediate chunks since cursor (or last poll if
  // omitted)", so a poll that omits `cursor` resolves from THIS consumer's last
  // confirmed position instead of the core's default 0 — which would
  // re-deliver the entire retained buffer on every poll and report
  // `truncated: true` forever once eviction started. A supplied cursor is
  // honored exactly (including an explicit 0 = replay from the beginning) and
  // never moves the stored position. The consumer key is the polling identity
  // resolved above (session + root run + polling agent), so two pollers of one
  // job cannot steal each other's place, and the store is per job and bounded
  // by the adapter's MAX_CONSUMER_CURSORS.
  const consumerId = `${resolved.clientSessionId}:${resolved.rootRunId}:${resolved.parentAgentId}`
  const cursorOmitted = cursor === undefined
  const effectiveCursor = cursorOmitted
    ? getBackgroundAgentConsumerCursor(jobId, consumerId)
    : cursor

  // Join/wait over the unified core event stream. Poll mode resolves
  // immediately from the snapshot; follow mode is driven off the registry's
  // internal notifications (no sleep-polling). The cursor is clamped to the
  // job's latest sequence by the core, so a cursor past the end can never
  // leave the terminal transition unable to settle the wait.
  const result = follow
    ? await waitForBackgroundAgentJob(jobId, {
        cursor: effectiveCursor,
        predicate,
        timeoutMs,
        signal,
      })
    : (snapshotBackgroundAgentJob(jobId, effectiveCursor) ?? undefined)

  const { state, events, nextCursor, truncated, dropped, matched, timedOut } =
    buildAgentPollResult({
      result,
      predicate,
      fallbackState: owned.job.state,
      jobId,
      consumerId,
      cursorOmitted,
    })

  // Both the settled error and the settled result are folded into the core
  // lifecycle, so they are resolved from the core first and fall back to the
  // adapter view. That keeps the reported `state` and `result` on the same
  // source of truth even when the count-cap sweep has already evicted the
  // view of this settled job (the view is only a live mirror; a job that is
  // still cancellable never has its view evicted).
  const coreJob = getBackgroundAgentJobCore(jobId)
  const view = getBackgroundAgentJob(jobId)
  // Only a cancel that actually took effect (or a job already cancelled)
  // reports `cancelled`: an idempotent repeat cancel on a completed job must
  // not relabel that job's terminal outcome.
  const cancelled = cancelledNow || state === 'cancelled'
  const resultValue = coreJob?.result ?? view?.result
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
