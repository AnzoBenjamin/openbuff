import z from 'zod/v4'

import type { Result } from '@codebuff/common/types/contracts/execution-context'

/** No automatic SYNC wall-clock cutoff; a host may explicitly select one. */
export const DEFAULT_SYNC_TIMEOUT_SECONDS = -1
/** Finite fallback used only when the host explicitly forbids unbounded SYNC commands. */
const BOUNDED_SYNC_FALLBACK_SECONDS = 120

const secondsSchema = z
  .number()
  .finite()
  .positive()
  .refine(
    (seconds) => Number.isSafeInteger(seconds * 1_000),
    'Timeout must be representable as a positive whole number of milliseconds',
  )

/** A host policy, never an agent/tool-input setting. */
export const terminalTimeoutPolicySchema = z
  .object({
    defaultSyncSeconds: secondsSchema.optional(),
    maxSeconds: secondsSchema.optional(),
    allowUnbounded: z.boolean().optional(),
  })
  .strict()

export type TerminalTimeoutPolicy = Readonly<
  z.infer<typeof terminalTimeoutPolicySchema>
>
export type TerminalTimeoutResolution = Readonly<{
  localSeconds: number
  /** Omitted/defaulted SYNC timeout starts after admission. */
  defaultExecutionMs?: number
}>

export function captureTerminalTimeoutPolicy(
  candidate: TerminalTimeoutPolicy | undefined,
): Result<TerminalTimeoutPolicy | undefined> {
  if (candidate === undefined) return { ok: true, value: undefined }
  const parsed = terminalTimeoutPolicySchema.safeParse(candidate)
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => String(issue.path[0] ?? 'policy')),
      ),
    ]
    return {
      ok: false,
      reason: 'invalid-context',
      cause: `Invalid terminal timeout policy (${fields.join(', ')}): use finite positive millisecond-precision durations and a boolean allowUnbounded.`,
    }
  }
  return { ok: true, value: Object.freeze(parsed.data) }
}

export function resolveTerminalTimeout(
  requested: number | undefined,
  processType: 'SYNC' | 'BACKGROUND',
  policy: TerminalTimeoutPolicy = {},
): TerminalTimeoutResolution {
  const captured = captureTerminalTimeoutPolicy(policy)
  if (!captured.ok) throw new Error(captured.cause)
  policy = captured.value ?? {}
  const cap = policy.maxSeconds
  const selectedDefault =
    policy.defaultSyncSeconds ??
    (policy.allowUnbounded === false
      ? BOUNDED_SYNC_FALLBACK_SECONDS
      : undefined)
  const syncDefault = Math.min(selectedDefault ?? Infinity, cap ?? Infinity)
  const defaulted = (): TerminalTimeoutResolution =>
    processType === 'SYNC' && Number.isFinite(syncDefault)
      ? { localSeconds: -1, defaultExecutionMs: Math.round(syncDefault * 1000) }
      : { localSeconds: cap ?? DEFAULT_SYNC_TIMEOUT_SECONDS }
  if (requested === undefined) return defaulted()
  if (requested === -1) {
    if (cap !== undefined) return { localSeconds: cap }
    return policy.allowUnbounded === false ? defaulted() : { localSeconds: -1 }
  }
  return {
    localSeconds: cap !== undefined && requested > cap ? cap : requested,
  }
}

/** Preserve fields omitted by later fragments; callers own validation/provenance. */
export function mergeTerminalTimeoutPolicies(
  base: TerminalTimeoutPolicy | undefined,
  override: TerminalTimeoutPolicy | undefined,
): TerminalTimeoutPolicy | undefined {
  if (!base && !override) return undefined
  return { ...base, ...override }
}

/** Untrusted project declarations can shorten waits but cannot relax a user policy. */
export function tightenTerminalTimeoutPolicy(
  base: TerminalTimeoutPolicy | undefined,
  requested: TerminalTimeoutPolicy | undefined,
): TerminalTimeoutPolicy | undefined {
  if (!requested) return undefined
  return {
    ...(requested.defaultSyncSeconds !== undefined
      ? {
          defaultSyncSeconds: Math.min(
            base?.defaultSyncSeconds ??
              (base?.allowUnbounded === false
                ? BOUNDED_SYNC_FALLBACK_SECONDS
                : Infinity),
            requested.defaultSyncSeconds,
          ),
        }
      : {}),
    ...(requested.maxSeconds !== undefined
      ? {
          maxSeconds: Math.min(
            base?.maxSeconds ?? Infinity,
            requested.maxSeconds,
          ),
        }
      : {}),
    ...(requested.allowUnbounded !== undefined
      ? {
          allowUnbounded:
            (base?.allowUnbounded ?? true) && requested.allowUnbounded,
        }
      : {}),
  }
}
