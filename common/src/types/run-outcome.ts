import z from 'zod/v4'

export const outcomeCauseSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict()

export const runOutcomeSchema = z
  .object({
    termination: z.enum([
      'completed',
      'failed',
      'cancelled',
      'budget_exhausted',
      'step_exhausted',
      'deadline_exhausted',
      'resource_failure',
      'cleanup_failure',
    ]),
    cause: outcomeCauseSchema.optional(),
  })
  .strict()

/** Task evidence is independent of whether the agent's execution completed. */
export const taskAcceptanceSchema = z
  .object({
    status: z.enum(['accepted', 'rejected', 'unknown']),
    oracle: z.string().optional(),
    scope: z.string().optional(),
    basis: z.string().optional(),
  })
  .strict()

/** Compact, immutable evidence of an individual tool attempt. */
export const actionOutcomeSchema = z
  .object({
    actionId: z.string().min(1),
    attemptId: z.string().min(1),
    runId: z.string().min(1),
    toolName: z.string().min(1),
    basis: z
      .object({
        inputHash: z.string().min(1),
        workspaceRevision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    outcome: z.enum([
      'succeeded',
      'failed',
      'refused',
      'cancelled',
      'uncertain',
    ]),
    cause: outcomeCauseSchema.optional(),
    effect: z
      .object({
        status: z.enum(['confirmed', 'partial', 'unobserved']),
        receiptIds: z.array(z.string()),
        confirmedPaths: z.array(z.string()),
        forward: z
          .array(
            z
              .object({
                actionId: z.string().min(1),
                outcome: z.enum(['applied', 'not_applied', 'unconfirmed']),
                afterHashes: z.record(z.string(), z.string().nullable()),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
  })
  .strict()

export type RunOutcome = z.infer<typeof runOutcomeSchema>
export type TaskAcceptance = z.infer<typeof taskAcceptanceSchema>
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>

export function runStatusFromOutcome(
  outcome: RunOutcome,
): 'completed' | 'failed' | 'cancelled' {
  if (outcome.termination === 'completed') return 'completed'
  if (outcome.termination === 'cancelled') return 'cancelled'
  return 'failed'
}

/** Known execution failure and task rejection have separate causes. */
export function runFailureMessage(result: {
  output?: { type: string; message?: string }
  runOutcome?: RunOutcome
  taskAcceptance?: TaskAcceptance
}): string | undefined {
  if (result.runOutcome && result.runOutcome.termination !== 'completed') {
    return (
      result.runOutcome.cause?.message.trim() ||
      `Run ${result.runOutcome.termination.replaceAll('_', ' ')}.`
    )
  }
  if (result.output?.type === 'error') {
    return result.output.message?.trim() || 'The run failed.'
  }
  if (result.taskAcceptance?.status === 'rejected') {
    return `Task rejected${result.taskAcceptance.basis?.trim() ? `: ${result.taskAcceptance.basis.trim()}` : '.'}`
  }
  return undefined
}
