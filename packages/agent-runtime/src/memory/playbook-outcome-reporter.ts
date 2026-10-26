import type { PlaybookGateOutcomeEvent } from '@codebuff/common/types/memory-playbook'
import type { Logger } from '@codebuff/common/types/contracts/logger'

export type PlaybookGateOutcomeReporterDeps = {
  onPlaybookGateOutcome?: (
    event: PlaybookGateOutcomeEvent,
  ) => void | Promise<void>
  logger: Logger
}

/**
 * Report one playbook-gate outcome to the producer callback (memory playbook
 * Phase 2/4 seam), fully isolated from the gate's own control flow.
 *
 * CRITICAL hazard this module exists for: the gate seam in tool-executor.ts
 * runs inside a try/catch that fails OPEN (a gate bug must never break tool
 * dispatch). A producer callback that THROWS inside that block would be
 * swallowed by that catch — and the catch's proceed-semantics would let a
 * BLOCKED call go through, exactly the outcome the gate exists to prevent.
 * This reporter therefore isolates the emission: a synchronous throw is
 * caught here (logged at debug), a returned rejected promise gets a
 * `.catch`, and the function NEVER throws and never leaves an unhandled
 * rejection. A failed outcome report is observability loss, never a gate
 * bypass.
 */
export function reportPlaybookGateOutcome(params: {
  deps: PlaybookGateOutcomeReporterDeps
  event: PlaybookGateOutcomeEvent
}): void {
  const { deps, event } = params
  const report = deps.onPlaybookGateOutcome
  if (!report) return
  try {
    const result = report(event)
    if (result !== undefined && result !== null) {
      Promise.resolve(result).catch((error) => {
        deps.logger.debug(
          { error },
          'Playbook gate outcome report failed (non-fatal)',
        )
      })
    }
  } catch (error) {
    deps.logger.debug(
      { error },
      'Playbook gate outcome report failed (non-fatal)',
    )
  }
}
