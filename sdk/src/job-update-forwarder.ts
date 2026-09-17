import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { Job, JobEvent } from '@codebuff/common/util/job-registry'

type AgentChunkPayload = Extract<JobEvent['payload'], { type: 'agent_chunk' }>

const MAX_OUTPUT_DELTA_CHARS = 2000

function truncateOutputDelta(value: string): string {
  if (value.length <= MAX_OUTPUT_DELTA_CHARS) return value
  return value.slice(0, MAX_OUTPUT_DELTA_CHARS)
}

function toolNameFrom(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  for (const key of ['toolName', 'tool', 'name'] as const) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate.slice(0, 120)
    }
  }
  return null
}

/** Summarize an agent_chunk without dumping full opaque JSON (bounded). */
function summarizeAgentChunk(payload: AgentChunkPayload): string | null {
  const chunkType = payload.chunkType
  if (chunkType === 'text') {
    const data = (payload as { data?: unknown }).data
    if (typeof data !== 'string' || data.length === 0) return null
    return truncateOutputDelta(data)
  }
  if (chunkType === 'tool_call' || chunkType.startsWith('tool_call')) {
    const data = (payload as { data?: unknown }).data
    const name =
      toolNameFrom(payload) ??
      (typeof data === 'string' && data.length > 0
        ? data.slice(0, 120)
        : toolNameFrom(data))
    return name ? `[tool_call:${name}]` : '[tool_call]'
  }
  if (chunkType === 'tool_result' || chunkType.startsWith('tool_result')) {
    return '[tool_result]'
  }
  if (chunkType.startsWith('subagent_')) {
    return `[${chunkType.slice(0, 64)}]`
  }
  return null
}

/**
 * Build the run-loop `jobRegistry.subscribeAll` listener that forwards this
 * run's own live background-job activity to the host via `handleEvent` as
 * `job_update` events (M5). Owner-scoped to the run's trusted owner; forwards
 * lifecycle + output plus live agent activity (agent_chunk text deltas as
 * outputDelta, tool_call/tool_result/subagent markers, and status messages).
 * Extracted from run.ts so the forwarding contract is unit-tested against the
 * real production code rather than a duplicated closure.
 */
export function createJobUpdateForwarder(params: {
  owner: { clientSessionId: string; rootRunId: string }
  handleEvent: (event: PrintModeEvent) => void | Promise<void>
  /** Read at emit time: forward only while callbacks are enabled and not aborted. */
  shouldForward: () => boolean
}): (job: Job, event: JobEvent) => void {
  const { owner, handleEvent, shouldForward } = params
  return (job, event) => {
    if (!shouldForward()) return
    // Owner scope: only this run's own jobs. Never the UNKNOWN placeholder
    // owner (unattributable) or a foreign session.
    if (
      job.owner.clientSessionId !== owner.clientSessionId ||
      job.owner.rootRunId !== owner.rootRunId
    ) {
      return
    }
    const payload = event.payload
    let outputDelta: string | undefined
    if (payload.type === 'lifecycle') {
      // State transition only; no delta.
    } else if (payload.type === 'output') {
      outputDelta = truncateOutputDelta(payload.data)
    } else if (payload.type === 'agent_chunk') {
      const summarized = summarizeAgentChunk(payload)
      if (summarized === null) return
      outputDelta = summarized
    } else if (payload.type === 'status') {
      if (typeof payload.message !== 'string' || payload.message.length === 0) {
        return
      }
      outputDelta = truncateOutputDelta(payload.message)
    } else {
      return
    }
    void handleEvent({
      type: 'job_update',
      jobId: job.jobId,
      kind: job.kind,
      state: job.state,
      sequence: event.sequence,
      label: job.label,
      ...(outputDelta !== undefined ? { outputDelta } : {}),
      ...(job.exitCode !== undefined && job.exitCode !== null
        ? { exitCode: job.exitCode }
        : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
    })
  }
}
