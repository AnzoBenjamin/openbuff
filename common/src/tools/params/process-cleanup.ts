import z from 'zod/v4'

const tier = z.enum(['posix-owned-group', 'direct-child', 'injected', 'linux-pid-namespace'])
const deadline = z.union([
  z.object({ kind: z.literal('unbounded'), limitId: z.string() }),
  z.object({ kind: z.literal('finite'), limitId: z.string(), domainId: z.string(), expiresAtMs: z.number() }),
])
export const processCleanupSchema = z.object({
  attemptId: z.string(), scopeId: z.string(), status: z.enum(['complete', 'failed', 'unknown']),
  selectedTier: tier, observedTier: tier, satisfiesSelectedTier: z.boolean(),
  trigger: z.enum(['deadline', 'owner-cancel', 'job-kill', 'output-limit', 'adapter-error', 'owner-shutdown', 'normal-leader-exit']),
  originalDeadline: deadline, firstStopAtMs: z.number(), killAtMs: z.number(), observeUntilMs: z.number(),
  signals: z.array(z.object({ signal: z.enum(['SIGTERM', 'SIGKILL']), atMs: z.number(), targetTier: tier,
    result: z.enum(['delivered', 'already-absent', 'refused-identity', 'unknown']), errorCode: z.string().optional() })),
  finalObservation: z.object({
    sampledAtMs: z.number(), clockDomainId: z.string(),
    leader: z.enum(['not-started', 'running', 'exited-reaped', 'unknown']),
    scopePresence: z.enum(['living', 'zombie-only', 'absent', 'unknown']),
    members: z.array(z.object({ identity: z.object({ pid: z.number().int().positive(), startTime: z.string().nullable(),
      pgid: z.number().int().nullable(), sid: z.number().int().nullable(), pidNamespace: z.string().nullable() }),
      state: z.string(), disposition: z.enum(['living', 'zombie', 'exited', 'unknown']) })),
    membershipComplete: z.boolean(), identity: z.enum(['verified', 'mismatch', 'unknown']),
    streams: z.object({ stdin: z.enum(['open', 'closed', 'unknown']),
      stdout: z.enum(['open', 'drained', 'closed-incomplete', 'unknown']),
      stderr: z.enum(['open', 'drained', 'closed-incomplete', 'unknown']) }),
  }),
  output: z.object({ stdoutSeenBytes: z.number().nonnegative(), stderrSeenBytes: z.number().nonnegative(),
    retainedBytes: z.number().nonnegative(), droppedBytes: z.number().nonnegative(), complete: z.boolean() }),
  cleanupAuthorityRetained: z.boolean(), selectedLimitSatisfied: z.boolean().nullable(),
  cause: z.string().optional(), launchFacts: z.json().optional(),
})
