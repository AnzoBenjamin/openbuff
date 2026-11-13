import z from 'zod/v4'

/** A host refusal is distinct from a failed process that was dispatched. */
export const executionRefusalSchema = z.object({
  ok: z.literal(false),
  reason: z.enum([
    'invalid-context',
    'stale-authority',
    'deadline-exhausted',
    'cancelled',
    'denied',
    'unavailable',
    'already-consumed',
  ]),
  cause: z.string(),
})
export type ExecutionRefusal = z.infer<typeof executionRefusalSchema>
