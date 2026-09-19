export const USEFULNESS_SCORE_MODEL_VERSION = 'usefulness-v1'

export type UsefulnessTier = 'explicit' | 'outcome' | 'derived'

const MAX_AGE_BUCKET_DAYS = 90

const DAY_MS = 86_400_000

const COUNTER_CAP = 1_000_000

const clampCounter = (value: number) =>
  Number.isFinite(value) ? Math.min(Math.max(0, Math.trunc(value)), COUNTER_CAP) : 0

/**
 * Tier derivation is agent-explicit-first: only observations recorded via the
 * 'record_decision' tool (decisions and constraints) are 'explicit'; genuine
 * 'outcome' observations are 'outcome'; everything else is 'derived'.
 */
export function deriveUsefulnessTier(params: {
  kind: string
  provenance?: { toolName?: string } | null
}): UsefulnessTier {
  if (
    params.provenance?.toolName === 'record_decision' &&
    (params.kind === 'decision' || params.kind === 'constraint')
  )
    return 'explicit'
  if (params.kind === 'outcome') return 'outcome'
  return 'derived'
}

/**
 * Agent-explicit age floor in whole days, computed purely from the two wall
 * clocks (NO Date.now). Unparseable timestamps and asOf-before-created both
 * bucket to 0; anything beyond 90 days caps at 90.
 */
export function ageBucketDays(
  createdAtWall: string,
  asOfTurnWall: string,
): number {
  const createdMs = Date.parse(createdAtWall)
  const asOfMs = Date.parse(asOfTurnWall)
  if (Number.isNaN(createdMs) || Number.isNaN(asOfMs)) return 0
  const elapsedDays = Math.floor(Math.max(0, asOfMs - createdMs) / DAY_MS)
  return Math.min(elapsedDays, MAX_AGE_BUCKET_DAYS)
}

/**
 * Integer usefulness score (usefulness-v1). Pure and deterministic: the same
 * inputs always yield the same integer. staled/reinforced are reserved for
 * future producers (no producers exist in P5; callers pass 0). The final
 * score is clamped to [0,1000]; 'explicit' observations then receive an
 * agent-explicit age floor of 12 (post-clamp), so a heavily-ignored old
 * decision never ranks below an equally-ignored derived observation.
 */
export function scoreUsefulness(params: {
  used: number
  ignored: number
  staled: number
  reinforced: number
  pinned: number
  createdAtWall: string
  asOfTurnWall: string
  tier: UsefulnessTier
}): { score: number; modelVersion: typeof USEFULNESS_SCORE_MODEL_VERSION } {
  const wUsed = 4
  const wReinforced = 6
  const wPinned = 8
  const wIgnored = 3
  const wStaled = 5
  const wAge = 2
  const used = clampCounter(params.used)
  const ignored = clampCounter(params.ignored)
  const staled = clampCounter(params.staled)
  const reinforced = clampCounter(params.reinforced)
  const pinned = params.pinned > 0 ? 1 : 0
  const age = ageBucketDays(params.createdAtWall, params.asOfTurnWall)
  const raw =
    wUsed * used +
    wReinforced * reinforced +
    wPinned * pinned -
    wIgnored * ignored -
    wStaled * staled -
    wAge * age
  const clamped = Math.max(0, Math.min(1000, raw))
  const score = params.tier === 'explicit' ? Math.max(clamped, 12) : clamped
  return { score, modelVersion: USEFULNESS_SCORE_MODEL_VERSION }
}
