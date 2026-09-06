import {
  flushJobLineCarry,
  getBackgroundJob,
  killBackgroundJob,
  peekJobLineCarry,
  readNewJobOutput,
} from './background-jobs'
import {
  dirtyDelta,
  listDirtyPaths,
  withTouchedPaths,
} from './run-terminal-command'

import type { BackgroundJobOwner } from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { JobEvent, JobState } from '@codebuff/common/util/job-registry'
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
 * Bound the returned `events` to at most `limit` characters of `output` data,
 * keeping the NEWEST output (tail-biased: the most recent output is the most
 * useful for a status check). Non-output events (lifecycle/status) are always
 * retained regardless of the limit. When the newest output event alone exceeds
 * the remaining budget, its `data` is sliced to keep only the tail. Returns the
 * bounded event list (original relative order preserved) and whether any output
 * was dropped or sliced. `nextCursor` is unaffected by this presentation cap;
 * the caller folds `truncated` into its own truncated flag.
 */
export function boundEventsToOutputTail(
  events: JobEvent[],
  limit: number,
): { events: JobEvent[]; truncated: boolean } {
  const result: JobEvent[] = []
  let remaining = limit
  let truncated = false
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.payload.type !== 'output') {
      result.unshift(event)
      continue
    }
    const data = event.payload.data
    if (data.length <= remaining) {
      result.unshift(event)
      remaining -= data.length
    } else if (remaining > 0) {
      result.unshift({
        ...event,
        payload: { type: 'output', data: data.slice(data.length - remaining) },
      })
      remaining = 0
      truncated = true
    } else {
      truncated = true
    }
  }
  return { events: result, truncated }
}

/**
 * Resolve the one-shot settlement dirty delta the first time a settled
 * observation is returned. Stores `[]` when snapshot/git is missing so
 * re-polls stay idempotent and never re-attribute post-settle dirt.
 * Returns paths to emit only on the resolving observation (omit on
 * subsequent polls and while still running).
 */
async function resolveSettlementTouchedPaths(job: {
  settlementTouchedPaths?: string[]
  dirtyBeforePaths?: string[]
  projectRoot?: string
}): Promise<string[] | undefined> {
  if (job.settlementTouchedPaths !== undefined) {
    // Already resolved on a prior settled check_job — do not re-emit.
    return undefined
  }
  if (job.dirtyBeforePaths !== undefined && job.projectRoot !== undefined) {
    const dirtyAfter = await listDirtyPaths(job.projectRoot)
    const touched =
      dirtyAfter !== null
        ? dirtyDelta(new Set(job.dirtyBeforePaths), dirtyAfter)
        : []
    job.settlementTouchedPaths = touched
    return touched
  }
  // Soft-fail: recovered jobs / no git snapshot — lock out recompute.
  job.settlementTouchedPaths = []
  return undefined
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
  // Per-adapter registry consumer cursor (lastCheckCursor). Independent of the
  // live drainer's readOffset: bytes the 250ms interval already mirrored into
  // the registry are still unconsumed by check_job until returned here.
  // Default 0 so the first poll observes prior registry events (including
  // pre-drained live output); subsequent polls advance from the prior return.
  // Re-snapshotting from entryCursor before returning yields the FULL window
  // matching `nextCursor`, so a multi-iteration follow returns every `output`
  // event emitted before the match/exit/timeout — not just the final poll's
  // batch (which would drop earlier events while advancing `nextCursor`).
  const entryCursor = job.lastCheckCursor ?? 0
  let cursor = entryCursor
  let truncated = false
  let collected = ''
  // `matched` latches across poll iterations. The wait_for pattern is matched
  // against the FULL new content (the retained window plus this chunk) BEFORE
  // the window is bounded, so it is detected even when it lands in the middle
  // of a large chunk that appendBoundedCollected would drop. Latching means a
  // match found in an earlier iteration is never lost when the buffer is later
  // truncated. `matched` is purely the wait_for latch: it starts false and is
  // only ever set true when a wait_for needle is found. Poll mode (and follow
  // without wait_for) exits via the finished/deadline terms instead.
  let matched = false
  // Cap accumulation during polling so a long-running chatty job can't OOM
  // the agent runtime before the follow timeout fires. `collected` is only
  // the wait_for match window (kept as head + tail with a marker); the
  // returned output events are bounded separately by the registry's per-job
  // event/byte ring buffer.
  while (true) {
    // Drain newly-written log bytes into the registry as output events — but
    // ONLY for jobs without a live drainer. A live job (spawned by
    // startBackgroundJob) is drained by its own 250ms interval; draining it
    // here too would corrupt the shared readOffset/decoder/lineCarry cursor.
    // Recovered and test-registered jobs have no interval, so they still drain
    // here.
    if (!job.hasLiveDrainer) readNewJobOutput(job)
    const snapshot = jobRegistry.snapshot(registryJobId, cursor)
    const newEvents = snapshot?.events ?? []
    if (snapshot) {
      cursor = snapshot.nextCursor
      truncated = truncated || snapshot.truncated
    }
    const chunk = outputEventsText(newEvents)
    // Preserve wait_for matching semantics: search the un-bounded combined
    // window (the retained match window plus this chunk) BEFORE truncating, so
    // a pattern is matched even when it lands in the middle of a large chunk —
    // the region appendBoundedCollected drops. The result latches so it is not
    // lost when the buffer is subsequently bounded. Also include the pending
    // partial line (peekJobLineCarry) in this transient test ONLY so a needle
    // that lands in an unterminated partial line — drained from the log but not
    // yet emitted as a per-line registry `output` event — is still matchable;
    // the carry is NOT folded into `collected` (that must stay bounded and
    // event-derived, or it would double-count once the line is later emitted).
    // When the needle is found in the pending partial line (carry), force-emit
    // the carry as a registry output event so the returned events are consistent
    // with matched: true. Without this, a needle in an unterminated partial line
    // could be reported as matched while being absent from the returned events/
    // outputText. The re-snapshot from entryCursor picks up the flushed event,
    // so it appears in the returned events. The cursor variable in the follow
    // loop is not updated by the flush, but this is fine because (a) the
    // re-snapshot uses entryCursor not cursor, and (b) matched is now true so
    // the loop exits.
    if (waitFor && !matched) {
      const matchWindow = collected + chunk + peekJobLineCarry(job)
      if (matchWindow.includes(waitFor)) {
        matched = true
        // If the needle depends on the carry (not fully present in the
        // already-emitted collected + chunk), force-emit the carry so the
        // returned events are consistent with matched: true. This covers both
        // the case where the needle is entirely in the carry and where it spans
        // the boundary between chunk and carry. Without this, a needle in an
        // unterminated partial line could be reported as matched while being
        // absent from the returned events/outputText.
        if (!(collected + chunk).includes(waitFor)) {
          flushJobLineCarry(job)
        }
      }
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
      const rawEvents = finalSnapshot?.events ?? newEvents
      const boundedResult = boundEventsToOutputTail(
        rawEvents,
        CHECK_JOB_OUTPUT_LIMIT,
      )
      const events = boundedResult.events
      const nextCursor = finalSnapshot?.nextCursor ?? cursor
      // Advance the per-adapter consumer cursor so the next check_job does not
      // re-serve these events. Mirrored-by-live-drainer is not the same as
      // consumed-by-check_job; only this advance marks consumption.
      job.lastCheckCursor = nextCursor
      const finalDropped = finalSnapshot?.dropped ?? 0
      const finalTruncated =
        truncated ||
        (finalSnapshot?.truncated ?? false) ||
        boundedResult.truncated
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
          // Kill settles the job; credit dirty delta on this first settled
          // observation (same one-shot path as natural finish).
          const killTouched = await resolveSettlementTouchedPaths(job)
          const killValue = {
            ...baseValue,
            state: postKillState,
            ...(postKillExitCode !== undefined && postKillExitCode !== null
              ? { exitCode: postKillExitCode }
              : {}),
            killed: true as const,
            timedOut: true as const,
          }
          return [
            {
              type: 'json',
              value:
                killTouched !== undefined
                  ? withTouchedPaths(killValue, killTouched)
                  : killValue,
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

      const settlementTouched = finished
        ? await resolveSettlementTouchedPaths(job)
        : undefined
      const resultValue =
        settlementTouched !== undefined
          ? withTouchedPaths(
              {
                ...baseValue,
                ...(timedOut ? { timedOut: true as const } : {}),
              },
              settlementTouched,
            )
          : {
              ...baseValue,
              ...(timedOut ? { timedOut: true as const } : {}),
            }
      return [
        {
          type: 'json',
          value: resultValue,
        },
      ]
    }
    // Event-driven wake, used purely as a smarter sleep: wait() is the WAKE
    // signal only (not the matcher — matching stays above, over the drained
    // registry events). The POLL_INTERVAL_MS (200) cap preserves the periodic
    // re-drain cadence for non-live (recovered/test) jobs, which are drained
    // at the top of the loop; live jobs wake earlier on their own events.
    // `remaining > 0` is guaranteed here because the `Date.now() >= deadline`
    // exit check immediately above already returned otherwise. Poll mode
    // (timeoutMs entry === 0, deadline ≈ entry time) returns on iteration 1
    // before ever reaching this line, so wait() never blocks a poll. No
    // predicate is passed and the return value is ignored.
    const remaining = deadline - Date.now()
    await jobRegistry.wait(registryJobId, {
      timeoutMs: Math.min(POLL_INTERVAL_MS, remaining),
      cursor,
    })
  }
}
