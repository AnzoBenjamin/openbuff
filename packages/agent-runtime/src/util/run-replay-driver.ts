/**
 * P2-T2 replay-driver slice (design §4d/§9): the driver that ACTS on
 * `buildRunResumeReport`'s output (see ./run-journal).
 *
 * WHY: buildRunResumeReport is a pure, read-only view of an interrupted run
 * (own tail, children, background intents). This module is the live seam that
 * walks that report and drives caller-injected handlers: re-driving a child
 * whose journal shows live execution is required, and respawning a background
 * intent the planner marked `respawn`. The CALLER owns HOW a child is
 * re-driven or a background job respawned; the driver only invokes the seams
 * and folds the per-item results into one structured outcome.
 *
 * Contract (matching run-journal's planner conventions):
 * - NEVER THROWS: every handler invocation is individually guarded; a handler
 *   that throws is recorded with a bounded message and the remaining items
 *   are still attempted (first error wins for the reported outcome). An
 *   unexpected failure anywhere else is reported the same way instead of
 *   rejecting.
 * - Additive-optional: every handler is optional. An unwired actionable seam
 *   is passed over silently (not counted as a skip), so wiring only some
 *   seams is safe and a driver built without handlers performs no work.
 *   `skipped` always equals the number of onSkipped invocations.
 * - Determinism: no clock/uuid use; the walk follows the report's own order
 *   (awaiting children, in-flight children, then background decisions), so
 *   driving the same report twice invokes the seams in the same order.
 * - Idempotent re-plan: `already_respawned` background decisions are skipped,
 *   so once a respawned child's journal reaches a terminal tail the settled
 *   `respawnOf` marker suppresses further respawns (see
 *   planBackgroundAgentResume) — the driver is stateless and adds no
 *   bookkeeping of its own.
 *
 * The driver never re-runs reconcileInterruptedBackgroundAgentIntents: the
 * caller must have reconciled intents BEFORE building the report (a second
 * pass would double-respawn), mirroring executeReplayActions' contract.
 *
 * Known remaining gap (documented for a later slice, intentionally NOT
 * implemented here): background coroutines do not journal their own streams,
 * so resume-from-own-journal for background agents stays deferred.
 */

import type {
  BackgroundResumeDecision,
  ChildRunDisposition,
  RunResumeReport,
} from './run-journal'

/**
 * One item the driver deliberately did NOT act on. `reason` mirrors the
 * planner's vocabulary: children are skipped because their recorded result
 * suffices (replayed_completed) or nothing is known about them
 * (child_unknown); background decisions are skipped verbatim by their
 * decision kind.
 */
export type RunReplayDriverSkip =
  | {
      kind: 'child'
      childRunId: string
      reason: 'replayed_completed' | 'child_unknown'
    }
  | {
      kind: 'background'
      jobId: string
      reason:
        | 'skip_terminal'
        | 'needs_confirmation'
        | 'still_running'
        | 'already_respawned'
    }

/**
 * Caller-injected seams. Every seam is optional; the CALLER owns the HOW (the
 * driver only invokes the seam with what the report already classified).
 */
export type RunReplayDriverHandlers = {
  /**
   * Re-drive ONE child run whose journal shows live execution is required (an
   * in-flight tool/llm tail or an incomplete tail). `classification` is the
   * child's disposition verbatim: its `toolCallId` is present exactly when
   * the child was killed inside a tool call (child_in_flight_tool), so the
   * caller can consult toolResultFor before re-executing the side-effecting
   * call.
   */
  reDriveChild?: (
    childRunId: string,
    classification: ChildRunDisposition,
  ) => Promise<void>
  /**
   * Respawn ONE background agent from its resume decision (the report carries
   * planBackgroundAgentResume's DECISIONS, not the raw intents; a `respawn`
   * decision is the interrupted intent's durable projection and is passed
   * verbatim). `classification.respawnOf` carries the ORIGINAL jobId and MUST
   * be journaled as the parent `spawn` payload marker (correlation = the
   * respawned child's runId) so re-planning classifies the intent
   * already_respawned once the respawned child's journal reaches a terminal
   * tail — the same convention the existing already_respawned path matches
   * on.
   */
  respawnBackground?: (
    intent: BackgroundResumeDecision,
    classification: { respawnOf: string },
  ) => Promise<void>
  /**
   * Invoked for every item the driver deliberately does NOT act on: children
   * whose recorded result suffices (replayed_completed) or that are unknown,
   * and background decisions of kind skip_terminal / needs_confirmation /
   * still_running / already_respawned.
   */
  onSkipped?: (info: RunReplayDriverSkip) => void
}

/**
 * Structured outcome of driving one report. Never throws: failures are
 * values. The per-item counts are reported on BOTH branches so a caller can
 * see how far the walk got before the first handler error.
 */
export type RunReplayDriverOutcome =
  | {
      ok: true
      /** Children successfully handed to reDriveChild. */
      childrenReplayed: number
      /** Background intents successfully handed to respawnBackground. */
      backgroundRespawned: number
      /** Items skipped; equals the number of onSkipped invocations. */
      skipped: number
    }
  | {
      ok: false
      /** Bounded message of the FIRST handler error (first error wins). */
      error: string
      childrenReplayed: number
      backgroundRespawned: number
      skipped: number
    }

/** Upper bound on a recorded handler error message (design §9: bounded surface). */
const MAX_DRIVER_ERROR_LENGTH = 300

function boundedDriverErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= MAX_DRIVER_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_DRIVER_ERROR_LENGTH)}...`
}

/**
 * Walk a RunResumeReport and act on it through the injected handlers, in the
 * report's own order: awaiting children, in-flight children, then background
 * decisions.
 *
 * - Children: `awaiting` children were already classified child_completed by
 *   planChildResume, so they are SKIPPED — the recorded terminal tail
 *   suffices and re-driving a completed child would duplicate its side
 *   effects. In-flight dispositions map through the same
 *   disposition→verdict mapping executeChildReplay uses: an in-flight
 *   tool/llm tail or an incomplete tail is live_execution_required and is
 *   handed to reDriveChild (the disposition carries toolCallId when the kill
 *   happened inside a tool call); an unknown child is skipped and reported.
 * - Background: a `respawn` decision is handed to respawnBackground together
 *   with the `respawnOf: <jobId>` marker the caller must journal (the same
 *   convention the already_respawned classification matches on);
 *   skip_terminal / needs_confirmation / still_running / already_respawned
 *   are skipped and reported.
 */
export async function executeRunResumeReport(params: {
  report: RunResumeReport
  handlers?: RunReplayDriverHandlers
}): Promise<RunReplayDriverOutcome> {
  const { report } = params
  const handlers = params.handlers ?? {}
  let childrenReplayed = 0
  let backgroundRespawned = 0
  let skipped = 0
  let firstError: string | undefined

  const recordSkip = (info: RunReplayDriverSkip): void => {
    skipped += 1
    try {
      handlers.onSkipped?.(info)
    } catch (error) {
      firstError ??= boundedDriverErrorMessage(error)
    }
  }

  try {
    if (report.children.kind === 'needs_children') {
      // `awaiting` children were already classified child_completed by
      // planChildResume: their recorded terminal tail suffices, so they are
      // skipped — re-driving a completed child would duplicate its side
      // effects.
      for (const child of report.children.awaiting) {
        recordSkip({
          kind: 'child',
          childRunId: child.childRunId,
          reason: 'replayed_completed',
        })
      }
      for (const disposition of report.children.inFlight) {
        // planChildResume never folds a child_completed disposition into
        // inFlight; that variant carries no childRunId (it is classified
        // against the child's own journal), so defensively there is nothing
        // identifiable to act on — skip it silently (the recorded result
        // would suffice anyway).
        if (disposition.kind === 'child_completed') {
          continue
        }
        if (disposition.kind === 'child_unknown') {
          recordSkip({
            kind: 'child',
            childRunId: disposition.childRunId,
            reason: 'child_unknown',
          })
          continue
        }
        // live_execution_required: the child was killed inside a tool call or
        // an llm request, or between its last tool_result and the next
        // llm_request. The disposition carries toolCallId exactly when the
        // kill happened inside a tool call.
        if (!handlers.reDriveChild) continue
        try {
          await handlers.reDriveChild(disposition.childRunId, disposition)
          childrenReplayed += 1
        } catch (error) {
          firstError ??= boundedDriverErrorMessage(error)
        }
      }
    }

    for (const decision of report.background) {
      if (decision.kind === 'respawn') {
        if (!handlers.respawnBackground) continue
        try {
          await handlers.respawnBackground(decision, {
            respawnOf: decision.jobId,
          })
          backgroundRespawned += 1
        } catch (error) {
          firstError ??= boundedDriverErrorMessage(error)
        }
        continue
      }
      recordSkip({
        kind: 'background',
        jobId: decision.jobId,
        reason: decision.kind,
      })
    }

    if (firstError !== undefined) {
      return {
        ok: false,
        error: firstError,
        childrenReplayed,
        backgroundRespawned,
        skipped,
      }
    }
    return { ok: true, childrenReplayed, backgroundRespawned, skipped }
  } catch (error) {
    // Never throws: an unexpected failure (e.g. a malformed hand-built
    // report) is reported, not propagated to the live loop.
    return {
      ok: false,
      error: boundedDriverErrorMessage(error),
      childrenReplayed,
      backgroundRespawned,
      skipped,
    }
  }
}
