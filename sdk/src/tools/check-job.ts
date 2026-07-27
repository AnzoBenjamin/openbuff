import {
  getBackgroundJob,
  killBackgroundJob,
  readNewJobOutput,
} from './background-jobs'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type {
  JobEvent,
  JobState,
} from '@codebuff/common/util/job-registry'
import { jobRegistry } from '@codebuff/common/util/job-registry'

const CHECK_JOB_OUTPUT_LIMIT = 50_000
const POLL_INTERVAL_MS = 200

/**
 * Upper bound on the in-memory `wait_for` match window a single check_job
 * follow accumulates. Prevents a chatty long-running job from growing
 * `collected` without limit (OOM) across many poll iterations.
 */
export const CHECK_JOB_POLL_ACCUMULATION_CAP = CHECK_JOB_OUTPUT_LIMIT * 2
const COLLECTED_TAIL_KEEP = Math.floor(CHECK_JOB_OUTPUT_LIMIT / 4)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Registry-side id backing this adapter job (recovered jobs are remapped). */
function registryIdFor(job: { jobId: string; registryJobId?: string }): string {
  return job.registryJobId ?? job.jobId
}

/** True when a job can no longer produce output. */
function jobSettled(job: { status: string }): boolean {
  return job.status !== 'running'
}

/**
 * Extract a plain-text view of the new `output` events for wait_for matching.
 */
function outputEventsText(events: JobEvent[]): string {
  let text = ''
  for (const event of events) {
    if (event.payload.type === 'output') {
      text += event.payload.data
    }
  }
  return text
}

/**
 * Bound the in-memory `wait_for` match window so a chatty long-running job
 * cannot grow `collected` without limit (OOM) across many poll iterations.
 * Keeps the head and tail of the stream with a marker noting how many chars
 * were dropped mid-stream. The result is bounded to
 * `CHECK_JOB_POLL_ACCUMULATION_CAP` plus the short truncation marker, no
 * matter how much output the job emits.
 */
export function appendBoundedCollected(
  collected: string,
  chunk: string,
): string {
  const combined = collected + chunk
  if (combined.length <= CHECK_JOB_POLL_ACCUMULATION_CAP) {
    return combined
  }
  const headKeep = CHECK_JOB_POLL_ACCUMULATION_CAP - COLLECTED_TAIL_KEEP
  const head = combined.slice(0, headKeep)
  const tail = combined.slice(combined.length - COLLECTED_TAIL_KEEP)
  const overflow = combined.length - headKeep - COLLECTED_TAIL_KEEP
  return head + `\n…[poll truncated ${overflow} chars mid-stream]\n` + tail
}

/**
 * Join (poll) or wait (follow) on a background job started by
 * run_terminal_command.
 *
 * The unified job registry is the source of truth for the job's lifecycle
 * state and output event stream; this adapter-level follow loop drains new
 * log bytes via readNewJobOutput (which mirrors them into the registry as
 * `output` events) and returns the registry event slice since the caller's
 * per-consumer cursor.
 *
 * Blocking (follow mode) is governed solely by `timeout_seconds`:
 * - Without `timeout_seconds` (i.e. it is unset or <= 0) the call performs a
 *   single non-blocking poll and returns immediately with whatever output is
 *   currently available (poll mode). When `wait_for` is supplied it is still
 *   evaluated against that single poll — `matched` reflects the output already
 *   present — but the call does NOT wait for the pattern to appear.
 * - With `timeout_seconds` > 0 the call blocks — bounded by the timeout —
 *   until `wait_for` appears in new output, the job exits, or the timeout
 *   elapses (follow mode). Without `wait_for` it blocks until the job exits or
 *   the timeout elapses.
 * To follow an arbitrary log file until a pattern appears, start a
 * `tail -f <file>` background job and check_job it with both a `wait_for`
 * pattern and a `timeout_seconds`.
 */
export async function checkJob(params: {
  jobId: string
  wait_for?: string
  timeout_seconds?: number
  kill_on_timeout?: boolean
  /**
   * REQUIRED trusted owner, injected from run/session state by the caller
   * (never from model/tool input). Ownership is verified against the
   * registry before any output is served.
   */
  owner: BackgroundJobOwner
}): Promise<CodebuffToolOutput<'check_job'>> {
  const { jobId, wait_for: waitFor, owner } = params
  const timeoutMs = Math.max(0, (params.timeout_seconds ?? 0) * 1000)
  // Observation must be non-destructive by default. Callers can explicitly
  // request termination when a follow timeout represents a hard deadline.
  const killOnTimeout = params.kill_on_timeout ?? false
  // Compute the follow deadline at ENTRY, before any registry calls. Both
  // getBackgroundJob (on recovery) and assertOwned invoke sweep() → Date.now(),
  // so computing the deadline afterward would base it on a later clock read and
  // could push the follow window out indefinitely (a mocked or fast-advancing
  // clock would then never satisfy `Date.now() >= deadline`).
  const deadline = Date.now() + timeoutMs

  // Cross-session recovery re-stamps the registry record with THIS trusted
  // owner (never a model-supplied one).
  const job = getBackgroundJob(jobId, { restampOwner: owner })
  if (!job) {
    return [
      {
        type: 'json',
        value: {
          jobId,
          errorMessage: `No background job found with id "${jobId}". The job metadata/log file may have been cleaned up, or the job was started before recoverable background metadata was written.`,
        },
      },
    ]
  }

  // Ownership gate: the registry is the source of truth for who owns this
  // job. A foreign job is refused with the SAME generic not_found error as
  // an unknown id so the caller cannot probe for other sessions' jobs.
  const registryJobId = registryIdFor(job)
  const ownership = jobRegistry.assertOwned(registryJobId, owner)
  if (!ownership.ok) {
    return [
      {
        type: 'json',
        value: {
          jobId,
          errorMessage: `No background job found with id "${jobId}".`,
        },
      },
    ]
  }
  // Per-consumer cursor into the registry event stream. The first poll
  // adopts the adapter's already-mirrored output as consumed (readOffset),
  // then tracks the registry sequence so events never repeat across calls.
  const initialSnapshot = jobRegistry.snapshot(registryJobId, 0)
  // Entry cursor into the registry event stream. Re-snapshotting from this
  // cursor before returning yields the FULL window matching `nextCursor`, so a
  // multi-iteration follow returns every `output` event emitted before the
  // match/exit/timeout — not just the final poll's batch (which would drop
  // earlier events while advancing `nextCursor` past them).
  const entryCursor = initialSnapshot?.nextCursor ?? 0
  let cursor = entryCursor
  let dropped = initialSnapshot?.dropped ?? 0
  let truncated = false
  let collected = ''
  // `matched` latches across poll iterations. The wait_for pattern is matched
  // against the FULL new content (the retained window plus this chunk) BEFORE
  // the window is bounded, so it is detected even when it lands in the middle
  // of a large chunk that appendBoundedCollected would drop. Latching means a
  // match found in an earlier iteration is never lost when the buffer is later
  // truncated. With no wait_for, poll/follow returns as soon as the job settles
  // or the deadline elapses, so matched starts true.
  let matched = !waitFor
  // Cap accumulation during polling so a long-running chatty job can't OOM
  // the agent runtime before the follow timeout fires. `collected` is only
  // the wait_for match window (kept as head + tail with a marker); the
  // returned output events are bounded separately by the registry's per-job
  // event/byte ring buffer.
  while (true) {
    // Drain newly-written log bytes into the registry as output events.
    readNewJobOutput(job)
    const snapshot = jobRegistry.snapshot(registryJobId, cursor)
    const newEvents = snapshot?.events ?? []
    if (snapshot) {
      cursor = snapshot.nextCursor
      dropped = snapshot.dropped
      truncated = truncated || snapshot.truncated
    }
    const chunk = outputEventsText(newEvents)
    // Preserve wait_for matching semantics: search the un-bounded combined
    // window (the retained match window plus this chunk) BEFORE truncating, so
    // a pattern is matched even when it lands in the middle of a large chunk —
    // the region appendBoundedCollected drops. The result latches so it is not
    // lost when the buffer is subsequently bounded.
    if (waitFor && !matched && (collected + chunk).includes(waitFor)) {
      matched = true
    }
    // Bound the match window so a chatty long-running job can't grow
    // `collected` without limit (OOM) across many poll iterations.
    collected = appendBoundedCollected(collected, chunk)
    const finished = jobSettled(job)
    if (matched || finished || Date.now() >= deadline) {
      const registryJob = jobRegistry.get(registryJobId)
      const state = registryJob?.state ?? job.status
      const exitCode = registryJob?.exitCode ?? job.exitCode ?? undefined
      // The follow-timeout fired (deadline reached, pattern NOT matched, job
      // NOT finished, and still running) and only in follow mode (timeoutMs > 0).
      // Poll mode (timeoutMs === 0) must never kill even though its deadline
      // is immediately reached, because `matched`/`finished` would also be true
      // there — but guard with timeoutMs > 0 to be explicit and safe.
      const timedOut =
        timeoutMs > 0 && !matched && !finished && Date.now() >= deadline
      // Re-snapshot from the entry cursor so the returned `events` cover the
      // FULL window [entryCursor, nextCursor) — every `output` event drained
      // during this follow, not just the final iteration's batch. This keeps
      // `events` consistent with `matched` (computed over the accumulated
      // `collected` window) and with `nextCursor`, so the caller receives all
      // output it would otherwise never be able to refetch. Bounded by the
      // registry's per-job event/byte ring buffer.
      const finalSnapshot = jobRegistry.snapshot(registryJobId, entryCursor)
      const events = finalSnapshot?.events ?? newEvents
      const nextCursor = finalSnapshot?.nextCursor ?? cursor
      const finalDropped = finalSnapshot?.dropped ?? dropped
      const finalTruncated = truncated || (finalSnapshot?.truncated ?? false)
      const baseValue: {
        jobId: string
        state: JobState
        events: JobEvent[]
        nextCursor: number
        truncated: boolean
        dropped: number
        exitCode?: number
        matched?: boolean
        logFile: string
      } = {
        jobId,
        state,
        events,
        nextCursor,
        truncated: finalTruncated,
        dropped: finalDropped,
        ...(exitCode !== undefined && exitCode !== null ? { exitCode } : {}),
        ...(waitFor ? { matched } : {}),
        logFile: job.logFile,
      }
      if (timedOut && job.status === 'running' && killOnTimeout) {
        const killResult = killBackgroundJob(jobId, 'SIGTERM')
        if ('killed' in killResult) {
          // killBackgroundJob updates the in-memory job status; prefer the
          // fresh kill-result state/exitCode over the stale local snapshot.
          const postKillJob = jobRegistry.get(registryJobId)
          const postKillState = postKillJob?.state ?? killResult.status
          const postKillExitCode =
            postKillJob?.exitCode ?? killResult.exitCode ?? undefined
          return [
            {
              type: 'json',
              value: {
                ...baseValue,
                state: postKillState,
                ...(postKillExitCode !== undefined && postKillExitCode !== null
                  ? { exitCode: postKillExitCode }
                  : {}),
                killed: true,
                timedOut: true,
              },
            },
          ]
        }
        // Kill itself reported an error (e.g. no pid): surface it while still
        // marking the attempt so the caller knows a kill was attempted.
        return [
          {
            type: 'json',
            value: {
              ...baseValue,
              killed: true,
              timedOut: true,
              errorMessage: killResult.errorMessage,
            },
          },
        ]
      }
      return [
        {
          type: 'json',
          value: {
            ...baseValue,
            ...(timedOut ? { timedOut: true } : {}),
          },
        },
      ]
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
