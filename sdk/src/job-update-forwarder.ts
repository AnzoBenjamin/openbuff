import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { Job, JobEvent } from '@codebuff/common/util/job-registry'

/**
 * Build the run-loop `jobRegistry.subscribeAll` listener that forwards this
 * run's own live background-job activity to the host via `handleEvent` as
 * `job_update` events (M5). Owner-scoped to the run's trusted owner; forwards
 * process/agent lifecycle + output payloads only (agent_chunk/status ignored).
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
    // M5 forwards process lifecycle + output only. agent_chunk/status are
    // ignored for now (agent jobs still surface via lifecycle state).
    if (event.payload.type !== 'lifecycle' && event.payload.type !== 'output') {
      return
    }
    void handleEvent({
      type: 'job_update',
      jobId: job.jobId,
      kind: job.kind,
      state: job.state,
      sequence: event.sequence,
      label: job.label,
      ...(event.payload.type === 'output'
        ? { outputDelta: event.payload.data }
        : {}),
      ...(job.exitCode !== undefined && job.exitCode !== null
        ? { exitCode: job.exitCode }
        : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
    })
  }
}
