/**
 * P2-T2b: background-agent resume-from-own-journal.
 *
 * WHY: a background child journals its own stream under its own runId (the
 * background spawn path propagates journalWriter/journalReader into the
 * detached executeSubagent call), so after a crash an interrupted BACKGROUND
 * intent whose planner decision is `respawn` can be re-driven FROM ITS OWN
 * JOURNAL instead of restarting from scratch: the message history is
 * reconstructed from the child's journaled `llm_request` payloads and the
 * relaunched coroutine is PINNED to its original child runId, so the run
 * resumes mid-flight (mid-tool or mid-LLM) rather than from a blank state.
 *
 * Reconstruction is at STEP level, never per-tool: model-driven tool calls
 * (processStream -> executeToolCall) are not journaled — tool_call/tool_result
 * events exist only on the programmatic handleSteps path — so the history is
 * rebuilt from the LAST journaled llm_request, whose payload carries the FULL
 * message history at step start. Consequences:
 *  - Mid-LLM re-issue is side-effect-free: the request never completed, so
 *    re-issuing it cannot duplicate any provider-visible work.
 *  - Mid-tool re-execution is at-least-once: the tool may or may not have
 *    applied before the kill. That window is ONLY reachable for the read-only
 *    DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES set, because
 *    planBackgroundAgentResume gates every `respawn` decision on that set — a
 *    non-idempotent agent type plans as needs_confirmation and is never
 *    handed to this module.
 *
 * Pinned-runId rationale: journal lookups (reconstructBackgroundChildHistory
 * reads reader.events(childRunId)) and respawn-marker settlement
 * (respawnMarkerIsSettled resolves the marker's correlation to a child journal
 * with a TERMINAL tail) both key on the ORIGINAL child runId. startAgentRun
 * mints a NEW id (the local stub returns local-run-<uuid>), which would orphan
 * the pre-crash journal stream and leave the marker permanently unsettled — so
 * buildBackgroundRelaunchAgentState pre-stamps state.runId = childRunId and the
 * runtime seam passes loopAgentSteps' pinnedRunId to skip the re-mint.
 *
 * Supervised-children gap (documented, non-goal for this slice): a
 * process-supervised background child receives no journalWriter through the
 * P2-T8b bridge (functions cannot cross the JSON transport), so its journal
 * stays empty, findBackgroundChildLinkage finds no linkage event, and resume
 * degrades to {kind:'no_linkage'} — behavior identical to today's no-respawn
 * path. Closing that gap is a later slice.
 *
 * Determinism: no direct Date-now or crypto-random-UUID calls. The only identity
 * this module produces is createAgentState's fresh agentId via
 * generateCompactId — the existing per-instance pattern, and not persisted
 * state a resume must reproduce (the pinned childRunId comes from the journal).
 */

import { createAgentState } from '../tools/handlers/tool/spawn-agent-utils'

import type {
  JournalReader,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { AgentState } from '@codebuff/common/types/session-state'

/** Narrow an untrusted journal payload into a plain record for field reads. */
function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The durable parent-side job -> child-runId record this module consumes. */
export type BackgroundResumeLinkage = { jobId: string; childRunId: string }

/**
 * P2-T2b: find the child runId a background job actually ran under.
 *
 * Scans the PARENT run's journal for `spawn` events whose payload is the
 * linkage record the child's own loopAgentSteps appends at its runId-mint site
 * (payload.backgroundLink === true, payload.jobId === jobId, and a non-empty
 * string payload.childRunId). Events come back seq-ASC, so a LATER linkage
 * supersedes an earlier one — the same job re-launched after an earlier
 * attempt must resume into its newest stream. The linkage event carries
 * correlation = jobId (NOT the childRunId), which is why a background child
 * never enters planChildResume's foreground child-resume plan.
 *
 * Never throws: any reader failure (a closed journal raced by a detached
 * child, a corrupt db) returns undefined, and the caller degrades to
 * {kind:'no_linkage'} — the same behavior as an unjournaled run.
 */
export function findBackgroundChildLinkage(
  reader: JournalReader,
  parentRunId: string,
  jobId: string,
): BackgroundResumeLinkage | undefined {
  let linkage: BackgroundResumeLinkage | undefined
  try {
    for (const event of reader.events(parentRunId)) {
      if (event.eventType !== 'spawn') continue
      const payload = event.payload
      if (!isPayloadRecord(payload)) continue
      if (payload.backgroundLink !== true) continue
      if (payload.jobId !== jobId) continue
      const childRunId = payload.childRunId
      if (typeof childRunId !== 'string' || childRunId.length === 0) continue
      // seq-ASC: the newest matching linkage wins.
      linkage = { jobId, childRunId }
    }
  } catch {
    return undefined
  }
  return linkage
}

/**
 * P2-T2b: reconstruct a background child's message history from its OWN
 * journal stream.
 *
 * Walks reader.events(childRunId) seq-ASC in ONE pass and keeps the LAST
 * `llm_request` whose payload is a record with an Array `messages` field —
 * that payload is the FULL message history at step start, so it is the resume
 * point for both kill windows (a mid-LLM kill re-issues that very request;
 * a mid-tool kill re-runs the step that produced it). The array is returned
 * AS-IS: its values already came from the journal's JSON.parse, so no further
 * copy is needed.
 *
 * Returns undefined when no such event exists (the child died before its
 * first LLM call, or journaled only malformed payloads) — the caller must
 * then degrade honestly instead of relaunching with an invented prompt.
 * Never throws: a reader failure is indistinguishable from an empty journal,
 * which is already the unrecoverable case.
 */
export function reconstructBackgroundChildHistory(
  reader: JournalReader,
  childRunId: string,
): Array<unknown> | undefined {
  let messages: Array<unknown> | undefined
  try {
    for (const event of reader.events(childRunId)) {
      if (event.eventType !== 'llm_request') continue
      const payload = event.payload
      if (!isPayloadRecord(payload)) continue
      const candidate = payload.messages
      if (!Array.isArray(candidate)) continue
      // seq-ASC: the newest qualifying llm_request wins.
      messages = candidate
    }
  } catch {
    return undefined
  }
  return messages
}

/**
 * Everything a detached relaunch of a background child needs, as assembled by
 * the runtime seam (run-agent-step.ts loop entry). `childRunId` and
 * `messageHistory` are the journal-derived halves — resumeBackgroundFromOwnJournal
 * computes both — so its own params omit them from this shape.
 */
export type BackgroundRelaunchParams = {
  agentType: string
  agentTemplate: AgentTemplate
  /** The ORIGINAL child runId the relaunch is pinned to. */
  childRunId: string
  /** The reconstructed pre-crash message history, verbatim from the journal. */
  messageHistory: Message[]
  jobId: string
  parentRunId: string
  logger: Logger
  /**
   * Injected launch seam: re-drives the built relaunch state. The CALLER owns
   * HOW (the runtime seam fires a detached loopAgentSteps re-drive with the
   * runId pinned); this module never launches on its own.
   */
  launch: (state: AgentState) => Promise<unknown>
}

/**
 * P2-T2b: build the relaunch state for a background child resumed from its
 * own journal.
 *
 * createAgentState(agentType, agentTemplate, parentAgentState, {}) provides the
 * fresh-spawn contract (fresh agentId, ancestorRunIds, parentId, cloned
 * taskMemory/playbookContext/workspaceState, backgroundAgentJobs: [], full
 * step budget); the two overrides below turn it into a RESUME:
 *  - messageHistory: the reconstructed pre-crash transcript VERBATIM. The
 *    template's history mode describes a fresh spawn; the journaled history is
 *    the resume itself and must win.
 *  - runId: the PIN. The loop re-stamps initialAgentState.runId = runId from
 *    pinnedRunId, which equals this value, so the re-driven child keeps
 *    journaling into the SAME pre-crash stream.
 */
export function buildBackgroundRelaunchAgentState(params: {
  agentType: string
  agentTemplate: AgentTemplate
  parentAgentState: AgentState
  childRunId: string
  messageHistory: Message[]
}): AgentState {
  const {
    agentType,
    agentTemplate,
    parentAgentState,
    childRunId,
    messageHistory,
  } = params
  const state = createAgentState(agentType, agentTemplate, parentAgentState, {})
  return {
    ...state,
    messageHistory,
    runId: childRunId,
  }
}

/**
 * P2-T2b orchestration: resume one interrupted background job from its OWN
 * journal stream, or degrade honestly.
 *
 * Order matters and is deliberate:
 *  1. findBackgroundChildLinkage — no linkage (unjournaled/supervised child,
 *     pruned journal) returns {kind:'no_linkage'}: nothing is launched and
 *     nothing is journaled, so the caller's behavior is exactly today's.
 *  2. reconstructBackgroundChildHistory — undefined (died pre-first-LLM)
 *     returns {kind:'unrecoverable'} BEFORE any marker is journaled: a marker
 *     whose correlation points at a child that cannot run would settle on a
 *     terminal tail that never arrives, but journaling intent-only evidence
 *     for a relaunch that never happens would misrepresent the attempt, so
 *     the intent simply keeps re-planning — the same state as today.
 *  3. buildBackgroundRelaunchAgentState — pins the runId.
 *  4. journal the respawn marker under the PARENT runId per the documented
 *     contract (run-replay-driver.ts): payload.respawnOf = the ORIGINAL jobId,
 *     correlation = the respawned child's runId, so respawnMarkerIsSettled
 *     settles exactly when the re-driven child's own journal reaches a
 *     TERMINAL tail. Fail-open: a journaling outage must never fail the
 *     resume; the unjournaled marker only means re-planning stays 'respawn'
 *     until the child finishes, which is the honest state anyway.
 *  5. await the launch seam. A launch throw propagates to the caller (the
 *     runtime seam's executor records it): the marker is already journaled and
 *     stays UNSETTLED until the child journals a terminal tail, so re-planning
 *     keeps re-driving instead of silently dropping the job.
 */
export async function resumeBackgroundFromOwnJournal(
  params: {
    reader: JournalReader
    writer?: JournalWriter
    parentAgentState: AgentState
  } & Omit<BackgroundRelaunchParams, 'childRunId' | 'messageHistory'>,
): Promise<
  | { kind: 'resumed'; childRunId: string }
  | { kind: 'no_linkage' }
  | { kind: 'unrecoverable'; reason: string }
> {
  const {
    reader,
    writer,
    parentAgentState,
    agentType,
    agentTemplate,
    jobId,
    parentRunId,
    logger,
    launch,
  } = params

  const linkage = findBackgroundChildLinkage(reader, parentRunId, jobId)
  if (!linkage) {
    return { kind: 'no_linkage' }
  }

  const reconstructed = reconstructBackgroundChildHistory(
    reader,
    linkage.childRunId,
  )
  if (!reconstructed) {
    return {
      kind: 'unrecoverable',
      reason:
        'background child journaled no llm_request; cannot reconstruct the prompt',
    }
  }

  // Trust boundary: the journal payload is the JSON round-trip of the
  // agentState.messageHistory the runtime itself appended at llm_request time
  // (run-agent-step.ts), so the array is treated as Message[] here rather than
  // re-validated field-by-field. A corrupt journal degrades exactly like any
  // other malformed journaled state downstream: the provider request rejects.
  const state = buildBackgroundRelaunchAgentState({
    agentType,
    agentTemplate,
    parentAgentState,
    childRunId: linkage.childRunId,
    messageHistory: reconstructed as Message[],
  })

  if (writer) {
    try {
      writer.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: linkage.childRunId,
        payload: {
          respawnOf: jobId,
          background: true,
          jobId,
          agentType,
          resumedFromJournal: true,
        },
      })
    } catch (error) {
      logger.warn(
        { jobId, childRunId: linkage.childRunId, error: String(error) },
        'Background respawn marker journal append failed; continuing without the marker',
      )
    }
  }

  await launch(state)
  return { kind: 'resumed', childRunId: linkage.childRunId }
}

/**
 * P2-T2b same-process live re-drive dedupe (reviewer finding
 * run-agent-step.ts:respawn-seam-concurrent-dedupe): while ONE re-drive for a
 * job is live, every later parent turn in the SAME process still re-plans
 * the intent 'respawn' (the respawn marker settles only on the re-driven
 * child's TERMINAL journal tail), so without a reservation the runtime seam
 * would launch a DUPLICATE detached coroutine pinned to the SAME childRunId
 * stream. Keyed on jobId — the planner's identity for the intent — because
 * the childRunId is only known after the journal read; while a drive is live
 * it writes the linkage's stream, so the jobId tracks the live stream 1:1.
 * A cross-process resume starts from a dead coroutine (nothing to dedupe
 * against); the settled marker is the cross-turn backstop once the re-driven
 * child reaches a terminal tail. Lives HERE rather than inside
 * resumeBackgroundFromOwnJournal so the engine stays STATELESS — S3 of the
 * gate suite pins that a second ENGINE pass launches again; the seam is the
 * layer that must not.
 */
const liveReDriveJobIds = new Set<string>()

/**
 * Reserve the right to launch this job's re-drive. Returns false (and
 * reserves nothing) when a live re-drive already exists — the caller must
 * skip. Check+reserve is one synchronous Set operation, so a concurrent
 * pass cannot slip between the check and the reservation.
 */
export function reserveBackgroundReDrive(jobId: string): boolean {
  if (liveReDriveJobIds.has(jobId)) return false
  liveReDriveJobIds.add(jobId)
  return true
}

/**
 * Release a reservation once the owning drive settled (or the caller's pass
 * ended without launching). Idempotent: releasing an unreserved id is a
 * no-op.
 */
export function releaseBackgroundReDrive(jobId: string): void {
  liveReDriveJobIds.delete(jobId)
}

/** Test isolation: drop every live-drive reservation (hung drives included). */
export function __clearBackgroundReDriveReservationsForTest(): void {
  liveReDriveJobIds.clear()
}
