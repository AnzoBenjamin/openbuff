import type {
  MemoryPlaybook,
  PlaybookStatus,
} from '../../../../common/src/types/memory-playbook'

/**
 * One proposed lifecycle transition for a playbook row, produced by
 * {@link evaluatePlaybookLifecycle}. The evaluator is pure, so every action
 * is a dry-run proposal: the `/memory playbooks` operator report decides
 * whether to apply it through the repository's optional `setPlaybookStatus`
 * and `upsertPlaybookByTriggerSignature` members.
 */
export type PlaybookLifecycleAction = {
  playbookId: string
  title: string
  from: PlaybookStatus
  to: PlaybookStatus
  kind: 'promote' | 'verify' | 'retire-noise' | 'retire-dud'
  reason: string
  /** Set only by promote: the inject-only → warn enforcement flip. */
  flipEnforcement?: 'warn'
}

/** promote: a shadow rule earns real (warn) enforcement. */
const PROMOTE_MIN_FIRED = 8
const PROMOTE_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
/** verify: an enforced rule is proven effective by its gate counters. */
const VERIFY_MIN_FIRED = 10
const VERIFY_MIN_BLOCKED = 3
const VERIFY_MIN_COMPLIED_AFTER_BLOCK = 3
const VERIFY_MAX_FALSE_POSITIVES = 1
const VERIFY_FALSE_POSITIVE_FIRED_RATIO = 0.1
const VERIFY_MAX_BYPASSED = 1
/** retire-noise: a rule that fires wrong (or is ignored) too often. */
const RETIRE_NOISE_MIN_FIRED = 4
const RETIRE_NOISE_FALSE_POSITIVE_RATIO = 0.5
const RETIRE_NOISE_BYPASS_RATIO = 0.3
/** retire-dud: a shadow rule that never earned its keep. */
const RETIRE_DUD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Exclusive upper bound: a dud has fired fewer than 2 times. */
const RETIRE_DUD_FIRED_UPPER_BOUND = 2

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Pure Phase-4 playbook lifecycle evaluator — the promotion/retirement policy
 * table in
 * .agents/sessions/memory-overhaul-2026-10/design-phase2-4-rederived.md
 * (§Promotion/retirement policy), implemented exactly.
 *
 * Semantics the policy encodes: `fired` counts every recorded gate event
 * (the store bumps it on every outcome, including falsePositive and
 * compliedAfterBlock bumps), not raw trigger matches — the thresholds above
 * are already tuned for that. The read band makes `fired` a decreasing
 * measure of success (the model pre-satisfies, so a quiet rule is a working
 * rule): enforced rules are therefore never retired on staleness, only on
 * noise. "Candidate" in the policy table means the inject-only shadow
 * channel — rows with status 'active' and enforcement 'inject-only'.
 * Expired-but-active rows may still yield actions; expiry enforcement
 * remains the gate's job.
 *
 * Purity contract: no I/O, no repository calls, no clock — `nowMs` is
 * injected. Enforcement is never flipped to 'block' here: promote flips
 * inject-only → warn only, and verified → block stays an operator decision.
 */
export function evaluatePlaybookLifecycle(
  playbooks: readonly MemoryPlaybook[],
  options: { nowMs: number },
): PlaybookLifecycleAction[] {
  const actions: PlaybookLifecycleAction[] = []
  for (const playbook of playbooks) {
    const action = evaluatePlaybook(playbook, options.nowMs)
    if (action) actions.push(action)
  }
  // Deterministic output: code-point order by playbookId.
  return actions.sort((left, right) =>
    compareUnicodeCodePoints(left.playbookId, right.playbookId),
  )
}

function evaluatePlaybook(
  playbook: MemoryPlaybook,
  nowMs: number,
): PlaybookLifecycleAction | null {
  const { status, enforcement, createdAt } = playbook
  const {
    fired,
    blocked,
    compliedAfterBlock,
    falsePositives,
    bypassed,
    lastFiredAt,
  } = playbook.counters
  // Integer safety: counters are non-negative integers by schema, but every
  // ratio division is guarded by fired > 0 regardless of the thresholds
  // above, so no future threshold edit can divide by zero.
  const falsePositiveRatio = fired > 0 ? falsePositives / fired : 0
  const bypassRatio = fired > 0 ? bypassed / fired : 0
  // The policy table's "candidate" rows ride the inject-only shadow channel.
  const isShadowCandidate =
    status === 'active' && enforcement === 'inject-only'

  // Precedence: retire-noise beats promote and verify — a noisy rule is
  // retired, not promoted or verified. Every later branch is mutually
  // exclusive with it, so a row yields at most one action per evaluation.
  if (
    status !== 'retired' &&
    fired >= RETIRE_NOISE_MIN_FIRED &&
    (falsePositiveRatio >= RETIRE_NOISE_FALSE_POSITIVE_RATIO ||
      bypassRatio >= RETIRE_NOISE_BYPASS_RATIO)
  ) {
    return {
      playbookId: playbook.playbookId,
      title: playbook.title,
      from: status,
      to: 'retired',
      kind: 'retire-noise',
      reason:
        falsePositiveRatio >= RETIRE_NOISE_FALSE_POSITIVE_RATIO
          ? `Noisy rule: ${falsePositives} of ${fired} fires were false positives.`
          : `Noisy rule: ${bypassed} of ${fired} fires were bypassed.`,
    }
  }
  if (
    isShadowCandidate &&
    fired >= PROMOTE_MIN_FIRED &&
    falsePositives === 0 &&
    lastFiredAt !== undefined &&
    nowMs - lastFiredAt <= PROMOTE_RECENT_WINDOW_MS
  ) {
    return {
      playbookId: playbook.playbookId,
      title: playbook.title,
      from: status,
      to: 'active',
      kind: 'promote',
      reason: `Shadow rule fired ${fired} times with zero false positives, last fired ${Math.floor((nowMs - lastFiredAt) / DAY_MS)}d ago; promote to warn enforcement.`,
      flipEnforcement: 'warn',
    }
  }
  if (
    status === 'active' &&
    (enforcement === 'warn' || enforcement === 'block') &&
    fired >= VERIFY_MIN_FIRED &&
    blocked >= VERIFY_MIN_BLOCKED &&
    compliedAfterBlock >= VERIFY_MIN_COMPLIED_AFTER_BLOCK &&
    falsePositives <= VERIFY_MAX_FALSE_POSITIVES &&
    falsePositives <= fired * VERIFY_FALSE_POSITIVE_FIRED_RATIO &&
    bypassed <= VERIFY_MAX_BYPASSED
  ) {
    return {
      playbookId: playbook.playbookId,
      title: playbook.title,
      from: status,
      to: 'verified',
      kind: 'verify',
      reason: `Rule fired ${fired} times: ${blocked} blocks with ${compliedAfterBlock} complies after a block, ${falsePositives} false positive(s), ${bypassed} bypass(es); counters support verified status.`,
    }
  }
  if (
    isShadowCandidate &&
    nowMs - createdAt > RETIRE_DUD_MAX_AGE_MS &&
    fired < RETIRE_DUD_FIRED_UPPER_BOUND
  ) {
    return {
      playbookId: playbook.playbookId,
      title: playbook.title,
      from: status,
      to: 'retired',
      kind: 'retire-dud',
      reason: `Shadow rule created ${Math.floor((nowMs - createdAt) / DAY_MS)}d ago fired only ${fired} ${fired === 1 ? 'time' : 'times'}; retire as a dud.`,
    }
  }
  return null
}

/** Code-point (not UTF-16 code-unit) comparison for deterministic ordering. */
function compareUnicodeCodePoints(left: string, right: string): number {
  if (left === right) return 0
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0)!,
  )
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}
