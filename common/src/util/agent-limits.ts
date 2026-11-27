/** No implicit inference-step ceiling; hosts/templates may explicitly select one. */
export const DEFAULT_SUBAGENT_MAX_STEPS = -1

/** A selected template may narrow an existing budget, never refill or revive it. */
export function selectAgentStepBudget(
  remaining: number,
  declared: number | undefined,
  subagent: boolean,
): number {
  if (
    declared !== undefined &&
    declared !== -1 &&
    (!Number.isSafeInteger(declared) || declared < 1 || declared > 100_000)
  )
    throw new Error(
      'Agent maxSteps must be -1 or a positive integer up to 100000',
    )
  const requested = declared ?? (subagent ? DEFAULT_SUBAGENT_MAX_STEPS : -1)
  if (remaining === 0) return 0
  if (requested === -1) return remaining
  return remaining > 0 ? Math.min(remaining, requested) : requested
}
