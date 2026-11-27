import type {
  AgentOutput,
  AgentState,
} from '@codebuff/common/types/session-state'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { MemoryV2Coordinator } from './coordinator'

/** Metadata cleanup, not a productive agent-work timeout. */
export const MEMORY_FINALIZATION_WAIT_MS = 2_500

/**
 * Caller cancellation selects the terminal status; it must not cancel the
 * persistence of that status. The coordinator parks an unconfirmed append
 * after its own 2s budget. This outer wait also bounds optional maintenance or
 * an arbitrary host callback, without claiming it can preempt that callback.
 */
export async function finishMemoryV2Turn(input: {
  coordinator: Pick<MemoryV2Coordinator, 'finishTurn'>
  agentState: AgentState
  output: AgentOutput
  signal?: AbortSignal
  logger?: Pick<Logger, 'warn'>
  /** Test-only/host-selected metadata wait; production keeps the default. */
  waitMs?: number
}): Promise<void> {
  const wait = input.waitMs ?? MEMORY_FINALIZATION_WAIT_MS
  if (!Number.isFinite(wait) || wait < 0 || wait > 2_147_483_647)
    throw new Error('Invalid memory finalization wait budget')
  const warn = (message: string, error?: unknown) => {
    try {
      input.logger?.warn({ error }, message)
    } catch {
      /* Metadata cannot change run outcome. */
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = Promise.resolve()
    .then(() =>
      input.coordinator.finishTurn({
        agentState: input.agentState,
        output: input.output,
        signal: input.signal,
      }),
    )
    .catch((error) =>
      warn(
        'Memory V2 finalization failed; retained state may require reconciliation',
        error,
      ),
    )
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      warn(
        'Memory V2 finalization wait expired; no unobserved append or maintenance completion is claimed',
      )
      resolve()
    }, wait)
  })
  try {
    await Promise.race([pending, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
