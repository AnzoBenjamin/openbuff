/**
 * P2-audit-fix-8: the PRODUCTION resumeDriver for crash-resumed runs.
 *
 * sdk/src/run.ts builds this driver exactly when a journalReader is wired and
 * threads it additively into the agent-runtime deps (impl/agent-runtime.ts →
 * callMainPrompt → loopAgentSteps). The runtime's loop-entry block builds the
 * RunResumeReport inside its existing not-clean branch and invokes this
 * driver, which walks the report via executeRunResumeReport
 * (packages/agent-runtime/src/util/run-replay-driver.ts). That driver records
 * every skipped item itself, so this module only supplies the two seams:
 *
 * - reDriveChild: BEST-EFFORT ONLY. A faithful re-drive is out of reach at
 *   this composition root: the parent journal's spawn records do not carry
 *   the child's agent template, prompt, spawn params, or AgentState, so there
 *   is nothing to re-launch from here (resume-from-own-journal, which would
 *   reconstruct it, stays deferred — see the documented gap in
 *   run-replay-driver.ts). The handler therefore RECORDS the attempt (a
 *   bounded warn log carrying childRunId, the disposition kind, and the
 *   toolCallId when the child was killed inside a tool call) and never
 *   throws. The child stays classified in-flight and keeps re-planning on
 *   every later resume instead of being silently dropped.
 * - respawnBackground: journals the durable parent `spawn` marker with
 *   `respawnOf: <original jobId>` through the caller's journalWriter
 *   (fail-open, deduped to at most one marker per jobId per run journal) and
 *   records the attempt. LIMITATION, documented rather than oversold: no live
 *   re-launch of the background coroutine happens at this seam — the runtime
 *   spawn path lives inside the spawn_agents tool handler and needs the live
 *   parent AgentState/template context, which the composition root does not
 *   hold. The marker's correlation deliberately reuses the launch-time jobId
 *   convention (spawn-agents.ts) rather than an invented child runId:
 *   respawnMarkerIsSettled (run-journal) resolves that correlation to a
 *   child_unknown child journal, so the marker can never falsely settle the
 *   intent and suppress re-planning — the job keeps re-planning (respawn) on
 *   later resumes, which is the planner's documented behavior while no real
 *   respawned child has reached a terminal journal tail.
 *
 * Fail-open contract: executeRunResumeReport never throws, and every logger
 * call here is guarded, so no driver failure can ever break the run. The
 * runtime's toolResultForInput replay short-circuit (run-programmatic-step)
 * still guards re-execution of journaled tool calls; this driver neither
 * bypasses nor duplicates it, and it never re-runs
 * reconcileInterruptedBackgroundAgentIntents (the runtime already reconciled
 * the intents before building the report).
 */

import { executeRunResumeReport } from '@codebuff/agent-runtime/util/run-replay-driver'

import type { RunReplayDriverOutcome } from '@codebuff/agent-runtime/util/run-replay-driver'
import type { RunResumeReport } from '@codebuff/agent-runtime/util/run-journal'
import type {
  JournalReader,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'

export type RunResumeDriverParams = {
  /** Durable journal writer: the respawn marker is journaled through it. */
  journalWriter?: JournalWriter
  /** Journal reader used to dedupe respawn markers (one per jobId). */
  journalReader?: JournalReader
  logger?: Logger
}

/**
 * Build the production resumeDriver seam for loopAgentSteps' `resumeDriver`
 * param. Returns a function that acts on one RunResumeReport and resolves
 * with the driver's structured outcome (or undefined if the walk itself
 * failed unexpectedly — it never rejects).
 */
export function createRunResumeDriver(
  params: RunResumeDriverParams,
): (report: RunResumeReport) => Promise<RunReplayDriverOutcome | undefined> {
  const { journalWriter, journalReader, logger } = params

  // Fail-open logging: a broken host logger must never break the run (the
  // same never-throws contract the driver's handlers already satisfy).
  const logSafely = (
    level: 'debug' | 'warn',
    data: unknown,
    message: string,
  ): void => {
    try {
      logger?.[level](data, message)
    } catch {
      // Fail-open: logging is never load-bearing here.
    }
  }

  return async (report) => {
    try {
      const outcome = await executeRunResumeReport({
        report,
        handlers: {
          onSkipped: (info) => {
            logSafely(
              'debug',
              { runId: report.runId, ...info },
              'Journal resume: item skipped (recorded by the driver)',
            )
          },
          reDriveChild: async (childRunId, classification) => {
            // Best-effort re-drive: a faithful re-launch is impossible at
            // this composition root (see the module docblock), so the attempt
            // is RECORDED, never thrown, and no journal event is appended —
            // appending one would change the parent run's resume tail
            // classification without doing the work it claims.
            const toolCallId =
              classification.kind === 'child_in_flight_tool'
                ? classification.toolCallId
                : undefined
            logSafely(
              'warn',
              {
                runId: report.runId,
                childRunId,
                dispositionKind: classification.kind,
                ...(toolCallId !== undefined ? { toolCallId } : {}),
              },
              'Journal resume: foreground child requires a live re-drive; recording the attempt only — a faithful re-drive needs the child agent state/prompt the parent journal does not record (resume-from-own-journal stays deferred), so the child keeps re-planning on later resumes',
            )
          },
          respawnBackground: async (decision) => {
            if (decision.kind !== 'respawn') return
            const { jobId, agentType } = decision
            // Dedupe: at most ONE respawnOf marker per jobId in this run's
            // journal, so repeated resume passes cannot grow the journal
            // without bound (the planner keeps re-planning the intent until a
            // real respawned child settles a marker; this seam never launches
            // one).
            let alreadyMarked = false
            if (journalReader) {
              try {
                alreadyMarked = journalReader
                  .events(report.runId)
                  .some((event) => {
                    if (event.eventType !== 'spawn') return false
                    const payload = event.payload
                    return (
                      typeof payload === 'object' &&
                      payload !== null &&
                      (payload as Record<string, unknown>).respawnOf === jobId
                    )
                  })
              } catch (error) {
                logSafely(
                  'warn',
                  { runId: report.runId, jobId, error: String(error) },
                  'Journal resume: respawn-marker dedupe scan failed; journaling the marker anyway',
                )
              }
            }
            if (!alreadyMarked && journalWriter) {
              try {
                journalWriter.append(report.runId, {
                  eventType: 'spawn',
                  stepNumber: 0,
                  // Correlation deliberately reuses the launch-time jobId
                  // convention (spawn-agents.ts): respawnMarkerIsSettled
                  // resolves it to a child_unknown child journal, so the
                  // marker can never falsely settle the intent and suppress
                  // re-planning.
                  correlation: jobId,
                  payload: {
                    agentType,
                    background: true,
                    jobId,
                    respawnOf: jobId,
                  },
                })
              } catch (error) {
                logSafely(
                  'warn',
                  { runId: report.runId, jobId, error: String(error) },
                  'Journal resume: respawn marker append failed; continuing without the marker',
                )
              }
            }
            logSafely(
              'warn',
              {
                runId: report.runId,
                jobId,
                agentType,
                markerJournaled: !alreadyMarked && Boolean(journalWriter),
              },
              'Journal resume: interrupted background intent respawn attempted (best-effort marker only; no live re-launch exists at this seam — the runtime spawn path needs the live parent agent state, so the intent keeps re-planning on later resumes)',
            )
          },
        },
      })
      if (outcome.ok) {
        logSafely(
          'debug',
          {
            runId: report.runId,
            childrenReplayed: outcome.childrenReplayed,
            backgroundRespawned: outcome.backgroundRespawned,
            skipped: outcome.skipped,
          },
          'Journal resume driver finished',
        )
      } else {
        logSafely(
          'warn',
          {
            runId: report.runId,
            error: outcome.error,
            childrenReplayed: outcome.childrenReplayed,
            backgroundRespawned: outcome.backgroundRespawned,
            skipped: outcome.skipped,
          },
          'Journal resume driver reported handler failures; continuing (fail-open)',
        )
      }
      return outcome
    } catch (error) {
      // Belt-and-braces fail-open: executeRunResumeReport is contracted never
      // to throw, but a driver failure must NEVER break the run.
      logSafely(
        'warn',
        { runId: report.runId, error: String(error) },
        'Journal resume driver failed unexpectedly; continuing (fail-open)',
      )
      return undefined
    }
  }
}
